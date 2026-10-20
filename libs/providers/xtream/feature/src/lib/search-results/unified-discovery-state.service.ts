import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from "@angular/core";
import {
  PORTAL_DISCOVERY_ADAPTER,
  PortalDiscoveryCoordinator,
  DiscoverySelectionService,
} from "@arm-nator/providers/shared/util";
import {
  catalogueIdentityKey,
  groupDiscoveryVersions,
  rankDiscoveryVersions,
} from "@arm-nator/shared/interfaces";
import type {
  DiscoveryRanking,
  DiscoveryVersion,
  GroupedGlobalSearchResult,
} from "@arm-nator/shared/interfaces";
import type {
  DiscoveryPortal,
  PortalDiscoverySnapshot,
} from "@arm-nator/providers/shared/util";
@Injectable()
export class UnifiedDiscoveryState {
  readonly adapter = inject(PORTAL_DISCOVERY_ADAPTER, { optional: true });
  private readonly selection = inject(DiscoverySelectionService);
  readonly portals = signal<DiscoveryPortal[]>([]);
  readonly snapshot = signal<PortalDiscoverySnapshot>({
    versions: [],
    statuses: [],
  });
  readonly searching = computed(() =>
    this.snapshot().statuses.some(
      (source) => source.state === "searching" || source.state === "idle",
    ),
  );
  readonly indexed = signal<DiscoveryVersion[]>([]);
  readonly choosing = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  readonly groups = computed(() =>
    groupDiscoveryVersions([...this.indexed(), ...this.snapshot().versions]),
  );
  private query = "";
  private types: ("movie" | "series" | "live")[] = [];
  private choosingGeneration = 0;
  private readonly coordinator = new PortalDiscoveryCoordinator(
    (source, query, page, signal) => {
      if (!this.adapter) throw new Error("Portal search is unavailable");
      return this.adapter.page(source, query, page, signal);
    },
    () => this.snapshot.set(this.coordinator.snapshot),
  );
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.coordinator.cancel();
      ++this.choosingGeneration;
    });
    void this.adapter
      ?.sources()
      .then((sources) => this.portals.set(sources))
      .catch((error) => this.error.set(String(error)));
  }
  update(
    query: string,
    types: ("movie" | "series" | "live")[],
    indexed: DiscoveryVersion[],
  ): void {
    const key = JSON.stringify(types);
    if (query.trim() !== this.query || key !== JSON.stringify(this.types)) {
      this.query = query.trim();
      this.types = [...types];
      this.coordinator.cancel();
      ++this.choosingGeneration;
      this.choosing.set(null);
      this.error.set(null);
    }
    this.indexed.set(indexed);
  }
  async searchPortals(): Promise<void> {
    if (this.query.length < 2 || !this.types.length) return;
    this.error.set(null);
    await this.coordinator.search(this.portals(), this.query, this.types);
  }
  cancelPortals(): void {
    this.coordinator.cancel(false);
  }
  continue(playlistId: string): void {
    void this.coordinator.continue(playlistId);
  }
  async choose(
    group: GroupedGlobalSearchResult,
    manual?: DiscoveryVersion,
  ): Promise<DiscoveryVersion | null> {
    const generation = ++this.choosingGeneration;
    this.choosing.set(group.key);
    this.error.set(null);
    try {
      let selected = manual;
      if (!selected) {
        const ranked = await this.rank(group);
        if (generation !== this.choosingGeneration) return null;
        selected = ranked[0];
      }
      if (!selected || generation !== this.choosingGeneration) return null;
      this.selection.select(group.versions, selected);
      return selected;
    } catch (error) {
      if (generation === this.choosingGeneration)
        this.error.set(
          `Unable to choose a version: ${error instanceof Error ? error.message : String(error)}`,
        );
      return null;
    } finally {
      if (generation === this.choosingGeneration) this.choosing.set(null);
    }
  }
  /** Preference lookup only: no stream resolution or playback selection. */
  async rank(group: GroupedGlobalSearchResult): Promise<DiscoveryVersion[]> {
    let ranking: DiscoveryRanking | undefined;
    const generation = this.choosingGeneration;
    try {
      ranking = await this.adapter?.ranking(group.versions[0]);
    } catch (error) {
      if (generation === this.choosingGeneration)
        this.error.set(
          `Saved preferences could not be read; using available version metadata. ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return rankDiscoveryVersions(group.versions, ranking ?? {});
  }
  versionKey(version: DiscoveryVersion): string {
    return catalogueIdentityKey(version.identity);
  }
}

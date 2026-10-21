import {
  Injectable,
  DestroyRef,
  computed,
  inject,
  signal,
} from "@angular/core";
import {
  summarizeSourceEvidence,
  matchesSourcePlaybackFilter,
  type SourceEvidenceSnapshot,
  type SourcePlaybackCategory,
  type SourcePlaybackFilter,
} from "@arm-nator/shared/interfaces";
import { SourcePlaybackRepositoryService } from "./source-playback-repository.service";
@Injectable({ providedIn: "root" })
export class SourcePlaybackStoreService {
  private readonly repository = inject(SourcePlaybackRepositoryService);
  private readonly clock = signal(Date.now());
  private generation = 0;
  readonly snapshots = signal<ReadonlyMap<string, SourceEvidenceSnapshot>>(
    new Map(),
  );
  readonly filter = signal<SourcePlaybackFilter>({
    category: "all",
    result: "any",
  });
  readonly persistenceFailure = signal<string | null>(null);
  readonly categories: readonly SourcePlaybackCategory[] = [
    "live",
    "movies",
    "series",
  ];
  readonly summaries = computed(() => {
    const now = this.clock();
    return new Map(
      [...this.snapshots()].map(([id, s]) => [
        id,
        this.categories.map((category) =>
          summarizeSourceEvidence(
            { sourceId: id, revision: s.revision, category },
            [...s.observations, ...s.latest],
            s.attempts.find((a) => a.key.category === category) ?? null,
            now,
            s.lastSuccessfulAt[category],
          ),
        ),
      ]),
    );
  });
  constructor() {
    const timer = setInterval(() => this.clock.set(Date.now()), 60000);
    (timer as unknown as { unref?: () => void }).unref?.();
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }
  summariesFor(sourceId: string) {
    return (
      this.summaries().get(sourceId) ??
      this.categories.map((category) =>
        summarizeSourceEvidence(
          { sourceId, revision: "", category },
          [],
          null,
          this.clock(),
        ),
      )
    );
  }
  matches(sourceId: string) {
    return matchesSourcePlaybackFilter(
      this.summariesFor(sourceId),
      this.filter(),
    );
  }
  setFilter(filter: SourcePlaybackFilter) {
    this.filter.set(filter);
  }
  async load(sourceIds: readonly string[]): Promise<void> {
    const generation = ++this.generation;
    try {
      const data = await this.repository.read(sourceIds);
      if (generation !== this.generation) return;
      this.snapshots.set(new Map(data.map((s) => [s.sourceId, s])));
      this.clock.set(Date.now());
      this.persistenceFailure.set(null);
    } catch (error) {
      if (generation === this.generation)
        this.persistenceFailure.set(
          error instanceof Error
            ? error.message
            : "Playback evidence could not be loaded",
        );
    }
  }
  refreshSaved(sourceIds: readonly string[]) {
    return this.load(sourceIds);
  }
}

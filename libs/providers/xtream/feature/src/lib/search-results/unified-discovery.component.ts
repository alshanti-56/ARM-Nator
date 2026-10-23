import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  viewChild,
  computed,
  effect,
  signal,
  inject,
  input,
  output,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { FormsModule } from "@angular/forms";
import { MatIcon } from "@angular/material/icon";
import {
  discoveryDisplayYear,
  discoveryDisplayTitle,
  groupDiscoverySources,
} from "@arm-nator/shared/interfaces";
import type {
  DiscoveryVersion,
  GroupedGlobalSearchResult,
} from "@arm-nator/shared/interfaces";
import { UnifiedDiscoveryState } from "./unified-discovery-state.service";

@Component({
  selector: "app-portal-discovery-controls",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule],
  template: ` <div class="portal-search-controls">
    @if (showAction()) {
      <button
        type="button"
        mat-stroked-button
        (click)="state.searchPortals()"
        [disabled]="disabled() || !state.portals().length"
      >
        Search portals
      </button>
      @if (state.searching()) {
        <button type="button" mat-button (click)="state.cancelPortals()">
          Cancel portal search
        </button>
      }
    }
    @if (showStatus()) {
      @if (state.snapshot().statuses.length) {
        <details class="portal-status">
          <summary>{{ portalSummary() }}</summary>
          @for (source of state.snapshot().statuses; track source.playlistId) {
            <div role="status">
              <strong>{{ source.providerName }}</strong> ·
              {{ source.resultCount }} loaded · {{ source.state }}
              @if (source.error) {
                <span>{{ source.error }}</span>
              }
              @if (
                source.continuation.length &&
                source.state !== "searching" &&
                source.state !== "idle"
              ) {
                <button
                  type="button"
                  mat-button
                  (click)="state.continue(source.playlistId)"
                >
                  Continue {{ source.providerName }}
                </button>
              }
            </div>
          }
        </details>
      }
      @if (state.error()) {
        <p role="alert">{{ state.error() }}</p>
      }
    }
  </div>`,
  styles: [
    `
      .portal-search-controls {
        display: flex;
        gap: 8px 16px;
        align-items: center;
        flex-wrap: wrap;
        padding-block: 12px;
      }
      .portal-status {
        width: 100%;
        font-size: 12px;
        border: 1px solid var(--app-separator, #dce0e7);
        border-radius: 8px;
        padding: 10px 14px;
        box-sizing: border-box;
        background: var(--app-widget-bg, #fff);
      }
      .portal-status summary {
        cursor: pointer;
        color: var(--app-body-color, #4a5060);
      }
      .portal-status [role="status"] {
        padding-top: 8px;
        overflow-wrap: anywhere;
      }
      .portal-search-controls [role="status"] {
        width: 100%;
      }
    `,
  ],
})
export class PortalDiscoveryControlsComponent {
  readonly state = inject(UnifiedDiscoveryState);
  readonly disabled = input(false);
  readonly showAction = input(true);
  readonly showStatus = input(true);
  readonly portalSummary = computed(() => {
    const statuses = this.state.snapshot().statuses;
    const count = statuses.reduce((sum, source) => sum + source.resultCount, 0);
    const failed = statuses.filter((source) => source.state === "error").length;
    return `${statuses.length} portals · ${count} loaded${failed ? ` · ${failed} failed` : ""} · ${this.state.searching() ? "Searching…" : "Source status"}`;
  });
}

@Component({
  selector: "app-unified-discovery-results",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatIcon],
  templateUrl: "./discovery-library.component.html",
  styleUrl: "./discovery-library.component.scss",
})
export class UnifiedDiscoveryResultsComponent {
  readonly state = inject(UnifiedDiscoveryState);
  readonly selected = output<DiscoveryVersion>();
  readonly groupBySource = input(false);
  readonly focusedKey = signal<string | null>(null);
  readonly inspector = viewChild<ElementRef<HTMLElement>>("inspector");
  readonly preferred = signal<DiscoveryVersion | null>(null);
  readonly preferredKey = computed(() => {
    const version = this.preferred();
    return version ? this.state.versionKey(version) : null;
  });
  readonly sourcesOpenFor = signal<string | null>(null);
  readonly expandedSource = signal<string | null>(null);
  readonly sources = computed(() =>
    groupDiscoverySources(this.focused()?.versions ?? []),
  );
  readonly sort = signal("match");
  readonly focused = computed(
    () =>
      this.state.groups().find((group) => group.key === this.focusedKey()) ??
      this.state.groups()[0],
  );
  readonly sections = computed(() => {
    const groups = [...this.state.groups()];
    if (this.sort() === "title")
      groups.sort((a, b) =>
        this.title(this.displayVersion(a)).localeCompare(
          this.title(this.displayVersion(b)),
        ),
      );
    if (this.sort() === "year")
      groups.sort(
        (a, b) =>
          (this.displayYear(this.displayVersion(b)) ?? 0) -
          (this.displayYear(this.displayVersion(a)) ?? 0),
      );
    if (!this.groupBySource()) return [{ key: "all", name: "", groups }];
    const sections = new Map<
      string,
      { key: string; name: string; groups: GroupedGlobalSearchResult[] }
    >();
    for (const group of groups) {
      const first = group.versions[0],
        key = first.identity.playlistId;
      const section = sections.get(key) ?? {
        key,
        name: first.providerName,
        groups: [],
      };
      section.groups.push(group);
      sections.set(key, section);
    }
    return [...sections.values()];
  });
  constructor() {
    effect((onCleanup) => {
      const group = this.focused();
      this.preferred.set(null);
      if (!group) return;
      let active = true;
      onCleanup(() => {
        active = false;
      });
      void this.state.rank(group).then((ranked) => {
        if (active && ranked[0]) this.preferred.set(ranked[0]);
      });
    });
  }
  focus(group: GroupedGlobalSearchResult, showSources = false): void {
    this.focusedKey.set(group.key);
    this.sourcesOpenFor.set(showSources ? group.key : null);
    this.expandedSource.set(null);
    if (globalThis.matchMedia?.("(max-width:850px)").matches) {
      this.inspector()?.nativeElement.scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }
  }
  async choose(
    group: GroupedGlobalSearchResult,
    manual?: DiscoveryVersion,
  ): Promise<void> {
    const version = await this.state.choose(group, manual);
    if (version) this.selected.emit(version);
  }
  title(version: DiscoveryVersion): string {
    return discoveryDisplayTitle(version);
  }
  displayVersion(group: GroupedGlobalSearchResult): DiscoveryVersion {
    const first = group.versions[0];
    const year = group.versions
      .map((version) => this.displayYear(version))
      .find((candidate) => candidate !== undefined);
    return year !== undefined && this.displayYear(first) !== year
      ? { ...first, displayYear: year }
      : first;
  }
  displayYear(version: DiscoveryVersion): number | undefined {
    return discoveryDisplayYear(version);
  }
  sourceCount(group: GroupedGlobalSearchResult): number {
    return groupDiscoverySources(group.versions).length;
  }
  toggleSources(group: GroupedGlobalSearchResult): void {
    this.sourcesOpenFor.update((key) => (key === group.key ? null : group.key));
    this.expandedSource.set(null);
  }
  sourceSummary(version: DiscoveryVersion): string {
    return [
      version.providerName.split(" — ")[0],
      ...(version.resolution ? [this.quality(version)] : []),
      ...(version.languages?.length ? [this.language(version)] : []),
    ].join(" · ");
  }
  action(version: DiscoveryVersion): string {
    return version.contentType === "series"
      ? "View episodes"
      : version.contentType === "live"
        ? "Watch channel"
        : "Open movie";
  }
  quality(version: DiscoveryVersion): string {
    return version.resolution ? `${version.resolution}p` : "Quality unknown";
  }
  language(version: DiscoveryVersion): string {
    return (
      version.languages
        ?.map((code) =>
          code === "mul" ? "Multi" : this.languageNames?.of(code) || code,
        )
        .join(", ") || "Language unknown"
    );
  }
  private readonly languageNames =
    typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames(["en"], { type: "language" })
      : null;
}

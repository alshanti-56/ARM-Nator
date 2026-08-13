import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from "@angular/core";
import { MatIcon } from "@angular/material/icon";
import { MatProgressSpinner } from "@angular/material/progress-spinner";
import { ActivatedRoute, Router } from "@angular/router";
import { TranslatePipe } from "@ngx-translate/core";
import { PlaylistContextFacade } from "@arm-nator/providers/shared/playlist-util";
import { SearchFormComponent } from "@arm-nator/providers/shared/ui";
import {
  RankedPersonSearchResult,
  TmdbEnrichmentService,
} from "@arm-nator/services";

const MIN_ACTOR_SEARCH_LENGTH = 3;

@Component({
  selector: "app-xtream-filmography-search",
  imports: [
    MatIcon,
    MatProgressSpinner,
    SearchFormComponent,
    TranslatePipe,
  ],
  templateUrl: "./xtream-filmography-search.component.html",
  styleUrl: "./xtream-filmography-search.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class XtreamFilmographySearchComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly playlistContext = inject(PlaylistContextFacade);
  private readonly tmdb = inject(TmdbEnrichmentService);

  readonly searchTerm = signal(
    this.route.snapshot.queryParamMap.get("q")?.trim() ?? "",
  );
  readonly candidates = signal<RankedPersonSearchResult[]>([]);
  readonly isSearching = signal(false);
  readonly selectionError = signal(false);
  readonly tmdbEnabled = this.tmdb.isEnabled();
  private searchRequestVersion = 0;

  readonly targetPlaylist = computed(() => {
    const activePlaylist = this.playlistContext.activePlaylist();
    if (activePlaylist?.serverUrl && activePlaylist._id) {
      return activePlaylist;
    }

    return (
      this.playlistContext
        .playlists()
        .find((playlist) => Boolean(playlist.serverUrl) && Boolean(playlist._id)) ??
      null
    );
  });

  readonly targetPlaylistName = computed(
    () => this.targetPlaylist()?.title || this.targetPlaylist()?.filename || "",
  );

  constructor() {
    const initialQuery = this.searchTerm();
    if (initialQuery.length >= MIN_ACTOR_SEARCH_LENGTH) {
      void this.searchActors(initialQuery);
    }
  }

  onSearchTermChange(value: string): void {
    const term = value.trim();
    this.searchTerm.set(value);
    this.selectionError.set(false);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: term || null },
      replaceUrl: true,
    });

    if (term.length < MIN_ACTOR_SEARCH_LENGTH) {
      this.searchRequestVersion += 1;
      this.candidates.set([]);
      this.isSearching.set(false);
      return;
    }

    void this.searchActors(term);
  }

  selectActor(personId: number): void {
    const playlistId = this.targetPlaylist()?._id;
    if (!playlistId) {
      this.selectionError.set(true);
      return;
    }

    void this.router.navigate([
      "/workspace/xtreams",
      playlistId,
      "actor",
      personId,
    ]);
  }

  private async searchActors(query: string): Promise<void> {
    if (!this.tmdbEnabled) {
      this.candidates.set([]);
      return;
    }

    const requestVersion = ++this.searchRequestVersion;
    this.isSearching.set(true);
    this.candidates.set([]);

    try {
      const results = await this.tmdb.searchPersonCandidates(query);
      if (requestVersion === this.searchRequestVersion) {
        this.candidates.set(results);
      }
    } finally {
      if (requestVersion === this.searchRequestVersion) {
        this.isSearching.set(false);
      }
    }
  }

  actorName(candidate: RankedPersonSearchResult): string {
    return candidate.result.name ?? "Unknown actor";
  }
}

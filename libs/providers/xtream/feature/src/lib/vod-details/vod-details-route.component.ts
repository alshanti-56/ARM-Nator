/* eslint-disable max-lines */
import { Location, SlicePipe, UpperCasePipe } from "@angular/common";
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { MatIcon } from "@angular/material/icon";
import { MatSnackBar } from "@angular/material/snack-bar";
import { MatDialog } from "@angular/material/dialog";
import { ActivatedRoute, Router } from "@angular/router";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import {
  DetailActionsTemplateDirective,
  DetailMetaTemplateDirective,
  DetailTagsTemplateDirective,
  PortalDetailShellComponent,
} from "@arm-nator/ui/components";
import { SafePipe } from "@arm-nator/pipes";
import { createLogger } from "@arm-nator/providers/shared/util";
import { XtreamStore } from "@arm-nator/providers/xtream/data-access";
import { type PlaybackFallbackRequest } from "@arm-nator/player/ui";
import {
  CrossPortalSimilarItem,
  CrossPortalSimilarService,
  SettingsStore,
} from "@arm-nator/services";
import {
  getXtreamVodInfo,
  metadataDisplayEntries,
  normalizeTitleKeys,
  TmdbEnrichedCastMember,
  XtreamCategory,
  XtreamVodDetails,
  XtreamVodInfo,
  XtreamVodStream,
  youtubeEmbedUrl,
} from "@arm-nator/shared/interfaces";
import {
  SimilarCatalogItem,
  matchRecommendationsToCatalog,
} from "../tmdb-similar.util";
import {
  buildXtreamVodFallbackViewModel,
  hasUsableXtreamVodMetadata,
} from "./vod-details-fallback.util";
import { VodDetailsPlaybackService } from "./vod-details-playback.service";
import {
  ContentMetadataDialogComponent,
  ContentMetadataDialogData,
} from "../content-metadata-dialog/content-metadata-dialog.component";

@Component({
  templateUrl: "./vod-details-route.component.html",
  styleUrls: [
    "../../../../../../ui/components/src/lib/styles/detail-view.scss",
    "./vod-details-route.component.scss",
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [VodDetailsPlaybackService],
  imports: [
    DetailActionsTemplateDirective,
    DetailMetaTemplateDirective,
    DetailTagsTemplateDirective,
    MatIcon,
    PortalDetailShellComponent,
    SafePipe,
    SlicePipe,
    UpperCasePipe,
    TranslateModule,
  ],
})
export class VodDetailsRouteComponent implements OnInit, OnDestroy {
  private readonly location = inject(Location);
  private readonly settingsStore = inject(SettingsStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly crossPortalSimilar = inject(CrossPortalSimilarService);
  private readonly xtreamStore = inject(XtreamStore);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly translateService = inject(TranslateService);
  private readonly playback = inject(VodDetailsPlaybackService);
  private readonly logger = createLogger("VodDetailsRoute");
  /** `playlistId:vodId` of the last initialized detail view */
  private readonly lastInitKey = signal<string | null>(null);
  private readonly backdropBackfillKey = signal<string | null>(null);
  readonly inlinePlayback = this.playback.inlinePlayback;
  readonly vodPlaybackPosition = this.playback.vodPlaybackPosition;

  /**
   * Reactive route params: the component is reused when navigating
   * between two VOD details (e.g. via the Similar rail), so computeds
   * must not read the one-shot snapshot.
   */
  private readonly routeParams = toSignal(this.route.params, {
    initialValue: this.route.snapshot.params,
  });

  readonly theme = this.settingsStore.theme;
  readonly isFavorite = this.xtreamStore.isFavorite;
  readonly selectedItem = computed(
    () => this.xtreamStore.selectedItem() as unknown as XtreamVodDetails | null,
  );
  readonly selectedVodId = computed(() => Number(this.routeParams().vodId));
  readonly selectedCategory = computed<Partial<XtreamCategory> | null>(() => {
    const categoryId = this.routeParams().categoryId;
    if (!categoryId) {
      return null;
    }

    return (
      this.xtreamStore.vodCategories().find(
        (category) =>
          String(
            (
              category as XtreamCategory & {
                id?: string | number;
              }
            ).category_id ??
              (
                category as XtreamCategory & {
                  id?: string | number;
                }
              ).id,
          ) === String(categoryId),
      ) ?? null
    );
  });
  readonly selectedCatalogItem = computed<
    | (Partial<XtreamVodStream> & {
        id?: string | number;
        poster_url?: string;
        title?: string;
        xtream_id?: string | number;
      })
    | null
  >(() => {
    const vodId = this.selectedVodId();
    if (!Number.isFinite(vodId) || vodId <= 0) {
      return null;
    }

    return (
      this.xtreamStore.vodStreams().find(
        (item) =>
          Number(
            (
              item as XtreamVodStream & {
                id?: string | number;
                xtream_id?: string | number;
              }
            ).xtream_id ??
              (
                item as XtreamVodStream & {
                  id?: string | number;
                }
              ).stream_id ??
              (
                item as XtreamVodStream & {
                  id?: string | number;
                }
              ).id,
          ) === vodId,
      ) ?? null
    );
  });
  readonly selectedVodInfo = computed(() => {
    const item = this.selectedItem();
    return item && hasUsableXtreamVodMetadata(item)
      ? getXtreamVodInfo(item)
      : null;
  });
  /**
   * The detail endpoint is not consistent across Xtream providers. Keep the
   * live detail object as the source of truth, but fill its display fields
   * from the catalog row when the endpoint omits them.
   */
  readonly displayInfo = computed<XtreamVodInfo | null>(() => {
    const item = this.selectedItem();
    const info = getXtreamVodInfo(item);
    const catalog = this.selectedCatalogItem() as unknown as Record<
      string,
      unknown
    > | null;

    if (!info && !catalog) {
      return null;
    }

    const catalogText = (...fields: string[]): string | undefined => {
      for (const field of fields) {
        const value = catalog?.[field];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) {
          return String(value);
        }
      }
      return undefined;
    };

    return {
      ...(info ?? {}),
      name: info?.name || catalogText("title", "name") || "",
      o_name: info?.o_name || catalogText("original_title") || "",
      releasedate:
        info?.releasedate || catalogText("releaseDate", "releasedate") || "",
      genre: info?.genre || catalogText("genre") || "",
      country: info?.country || catalogText("country") || "",
      director: info?.director || catalogText("director") || "",
      actors: info?.actors || catalogText("actors", "cast") || "",
      cast: info?.cast || catalogText("cast", "actors") || "",
      description:
        info?.description || catalogText("description", "plot") || "",
      plot: info?.plot || catalogText("plot", "description") || "",
      rating_imdb: info?.rating_imdb || catalogText("rating_imdb", "rating"),
      movie_image:
        info?.movie_image || catalogText("poster_url", "stream_icon") || "",
      cover_big: info?.cover_big || catalogText("poster_url") || "",
      backdrop_path: info?.backdrop_path?.length
        ? info.backdrop_path
        : catalogText("backdrop_url")
          ? [catalogText("backdrop_url") as string]
          : [],
      video: info?.video ?? [],
      audio: info?.audio ?? [],
    } as XtreamVodInfo;
  });
  readonly rawMetadata = computed(() => {
    const item = this.selectedItem();
    const info = getXtreamVodInfo(item);
    return [
      ...metadataDisplayEntries(
        info as unknown as Record<string, unknown> | null,
      ),
      ...metadataDisplayEntries(
        item?.movie_data as unknown as Record<string, unknown> | undefined,
        "movie_data",
      ),
    ];
  });
  readonly fallbackView = computed(() => {
    const item = this.selectedItem();
    if (!item || this.selectedVodInfo()) {
      return null;
    }

    return buildXtreamVodFallbackViewModel({
      vodDetails: item,
      catalogItem: this.selectedCatalogItem(),
      category: this.selectedCategory(),
      vodId: this.selectedVodId(),
    });
  });
  readonly isLoadingDetails = this.xtreamStore.isLoadingDetails;
  readonly detailsError = this.xtreamStore.detailsError;
  readonly matchedExternalPlayback = this.playback.matchedExternalPlayback;
  readonly externalPrimaryLabel = this.playback.externalPrimaryLabel;
  readonly externalPrimaryIcon = this.playback.externalPrimaryIcon;
  readonly isExternalLaunchPending = this.playback.isExternalLaunchPending;
  readonly isExternalStopAction = this.playback.isExternalStopAction;
  readonly externalPrimaryButtonState =
    this.playback.externalPrimaryButtonState;
  readonly vodPlaybackProgress = this.playback.vodPlaybackProgress;
  readonly hasPlaybackPosition = this.playback.hasPlaybackPosition;

  readonly trailerEmbedUrl = computed(() =>
    youtubeEmbedUrl(this.displayInfo()?.youtube_trailer),
  );

  /** TMDB recommendations matched against the loaded VOD catalog */
  readonly similarItems = computed<SimilarCatalogItem[]>(() => {
    const info = this.selectedVodInfo();
    if (!info?.tmdb_recommendations?.length) {
      return [];
    }
    return matchRecommendationsToCatalog(
      info.tmdb_recommendations,
      this.xtreamStore.vodStreams(),
      { excludeId: this.selectedVodId() },
    );
  });

  /** Recommendations found in the user's OTHER portals (Electron only) */
  private readonly crossPortalItems = signal<CrossPortalSimilarItem[]>([]);
  readonly similarInPortals = computed<CrossPortalSimilarItem[]>(() => {
    const localTitles = new Set(
      this.similarItems().map((item) => normalizeTitleKeys(item.title).exact),
    );
    return this.crossPortalItems().filter(
      (item) => !localTitles.has(normalizeTitleKeys(item.title).exact),
    );
  });

  private readonly loadCrossPortalSimilar = effect(() => {
    const recommendations = this.selectedVodInfo()?.tmdb_recommendations;
    const playlistId = this.xtreamStore.currentPlaylist()?.id;
    untracked(() => {
      this.crossPortalItems.set([]);
      if (!recommendations?.length || !this.crossPortalSimilar.isAvailable) {
        return;
      }
      void this.crossPortalSimilar
        .matchRecommendations(recommendations, "movie", {
          excludePlaylistId: playlistId,
        })
        .then((items) => {
          if (
            this.selectedVodInfo()?.tmdb_recommendations === recommendations
          ) {
            this.crossPortalItems.set(items);
          }
        });
    });
  });

  constructor() {
    this.playback.bind({
      vodId: this.selectedVodId,
      vodInfo: this.selectedVodInfo,
    });

    // Initializes on first render and RE-initializes when the route
    // params change while the component is reused (Similar rail).
    effect(() => {
      const playlistId = this.xtreamStore.currentPlaylist()?.id;
      const vodId = this.selectedVodId();
      if (!playlistId || !Number.isFinite(vodId) || vodId <= 0) return;

      const initKey = `${playlistId}:${vodId}`;
      if (this.lastInitKey() === initKey) return;
      this.lastInitKey.set(initKey);

      this.playback.closeInlinePlayer();
      this.vodPlaybackPosition.set(null);
      this.initializeVodDetails(playlistId, vodId);
    });

    effect(() => {
      const playlistId = this.xtreamStore.currentPlaylist()?.id;
      const vodId = this.selectedVodId();
      const backdropUrl = this.selectedVodInfo()?.backdrop_path?.[0]?.trim();

      if (
        !playlistId ||
        !Number.isFinite(vodId) ||
        vodId <= 0 ||
        !backdropUrl
      ) {
        return;
      }

      const backfillKey = `${playlistId}:${vodId}:${backdropUrl}`;
      if (this.backdropBackfillKey() === backfillKey) {
        return;
      }

      this.backdropBackfillKey.set(backfillKey);
      void this.xtreamStore.backfillContentBackdrop({
        xtreamId: vodId,
        contentType: "movie",
        playlist: this.xtreamStore.currentPlaylist,
        backdropUrl,
      });
    });
  }

  ngOnInit(): void {
    // Initialization is handled by the params-driven effect in the
    // constructor; the hook remains for interface compatibility.
    if (!this.xtreamStore.currentPlaylist()?.id) {
      this.logger.warn("Deferring VOD details init: playlist not ready");
    }
  }

  openSimilarInPortals(item: CrossPortalSimilarItem): void {
    void this.router.navigate(this.crossPortalSimilar.buildLink(item));
  }

  openSimilar(item: SimilarCatalogItem): void {
    void this.router.navigate(["../..", item.categoryId, item.id], {
      relativeTo: this.route,
    });
  }

  openActor(member: TmdbEnrichedCastMember): void {
    const playlistId = this.xtreamStore.currentPlaylist()?.id;
    if (!playlistId || !member.tmdbPersonId) {
      return;
    }
    void this.router.navigate([
      "/workspace/xtreams",
      playlistId,
      "actor",
      member.tmdbPersonId,
    ]);
  }

  ngOnDestroy(): void {
    this.playback.closeInlinePlayer();
    this.xtreamStore.setSelectedItem(null);
  }

  playVod(vodItem: XtreamVodDetails | null): void {
    this.playback.playVod(vodItem);
  }

  resumeVod(vodItem: XtreamVodDetails | null): void {
    this.playback.resumeVod(vodItem);
  }

  onPrimaryAction(vodItem: XtreamVodDetails | null): void {
    this.playback.onPrimaryAction(vodItem);
  }

  stopExternalPlayback(): Promise<void> {
    return this.playback.stopExternalPlayback();
  }

  formatPosition(): string {
    return this.playback.formatPosition();
  }

  toggleFavorite(): void {
    const playlist = this.xtreamStore.currentPlaylist();
    if (!playlist) {
      return;
    }

    this.xtreamStore.toggleFavorite(
      this.route.snapshot.params.vodId,
      playlist.id,
      "movie",
      this.selectedVodInfo()?.backdrop_path?.[0],
    );
  }

  openMetadataDialog(): void {
    const info = this.displayInfo();
    const entries = this.rawMetadata();
    if (!info || entries.length === 0) return;

    this.dialog.open<ContentMetadataDialogComponent, ContentMetadataDialogData>(
      ContentMetadataDialogComponent,
      {
        data: {
          title: info.name || this.selectedItem()?.movie_data?.name || "Movie",
          entries,
        },
        width: "min(820px, calc(100vw - 32px))",
        maxWidth: "calc(100vw - 24px)",
        maxHeight: "calc(100vh - 32px)",
      },
    );
  }

  getBackdropUrl(
    info: Pick<XtreamVodInfo, "backdrop_path">,
  ): string | undefined {
    return info.backdrop_path?.[0];
  }

  goBack(): void {
    this.playback.closeInlinePlayer();
    this.location.back();
  }

  closeInlinePlayer(): void {
    this.playback.closeInlinePlayer();
  }

  handleInlineTimeUpdate(event: {
    currentTime: number;
    duration: number;
  }): void {
    this.playback.handleInlineTimeUpdate(event);
  }

  showCopyNotification(): void {
    this.snackBar.open(
      this.translateService.instant("PORTALS.STREAM_URL_COPIED"),
      undefined,
      {
        duration: 2000,
      },
    );
  }

  handleExternalFallbackRequest(request: PlaybackFallbackRequest): void {
    this.playback.handleExternalFallbackRequest(request);
  }

  private initializeVodDetails(playlistId: string, vodId: number): void {
    const { categoryId } = this.route.snapshot.params;
    this.xtreamStore.fetchVodDetailsWithMetadata({
      vodId: String(vodId),
      categoryId,
    });
    this.xtreamStore.checkFavoriteStatus(vodId, playlistId, "movie");
    void this.playback.loadPosition(playlistId, vodId);
  }
}

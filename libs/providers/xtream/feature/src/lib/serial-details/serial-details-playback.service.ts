import { readProviderSeekPreviews } from "@arm-nator/shared/interfaces";
import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  Signal,
  signal,
  untracked,
} from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import {
  PORTAL_EXTERNAL_PLAYBACK,
  PORTAL_PLAYBACK_POSITIONS,
  PORTAL_PLAYER,
  getSeriesQuickStartAction,
} from "@arm-nator/providers/shared/util";
import {
  XtreamStore,
  XtreamUrlService,
  type XtreamPlaylistData,
  buildXtreamSavedPlaybackHeaders,
} from "@arm-nator/providers/xtream/data-access";
import type { XtreamCredentials } from "@arm-nator/providers/xtream/data-access";
import { PlaybackPositionRuntimeBridgeService } from "@arm-nator/services";
import {
  PlaybackPositionData,
  PlayerContentInfo,
  ResolvedPortalPlayback,
  xtreamItemIdentity,
  describeMovieWork,
  XtreamSerieDetails,
  XtreamSerieEpisode,
} from "@arm-nator/shared/interfaces";
import { SeasonContainerPlaybackToggleRequest } from "@arm-nator/ui/components";
import {
  getSeriesEpisodeMetadata,
  getSeriesPlaybackNavigation,
  type PlaybackFallbackRequest,
  resolveSeriesPlaybackEpisodeState,
  type SeriesPlaybackEpisodeState,
} from "@arm-nator/player/ui";
import { XTREAM_SERIES_RESUME_TARGET } from "./serial-details-resume-target.token";
import { SerialDetailsPlaybackPositionState } from "./serial-details-playback-position-state";

export type XtreamSerieDetailsView = XtreamSerieDetails & {
  readonly series_id: number;
};

interface SerialDetailsPlaybackBindings {
  readonly selectedItem: Signal<XtreamSerieDetailsView | null>;
}

/**
 * Component-provided service that owns the episode playback concern of the
 * serial details view: inline playback state, per-episode playback
 * positions, external-player session tracking, and playback orchestration.
 */
@Injectable()
export class SerialDetailsPlaybackService {
  private readonly route = inject(ActivatedRoute);
  private readonly xtreamStore = inject(XtreamStore);
  private readonly xtreamUrl = inject(XtreamUrlService);
  private readonly playbackPositions = inject(PORTAL_PLAYBACK_POSITIONS);
  private readonly playbackPositionBridge = inject(
    PlaybackPositionRuntimeBridgeService,
  );
  private readonly portalPlayer = inject(PORTAL_PLAYER);
  private readonly externalPlayback = inject(PORTAL_EXTERNAL_PLAYBACK);
  private readonly resumeTarget = inject(XTREAM_SERIES_RESUME_TARGET);

  private readonly bindings = signal<SerialDetailsPlaybackBindings | null>(
    null,
  );
  private readonly currentPlaylistId = computed(
    () => this.xtreamStore.currentPlaylist()?.id ?? "",
  );
  private readonly playbackPositionState =
    new SerialDetailsPlaybackPositionState();
  private lastSaveTime = 0;

  readonly inlinePlayback = signal<ResolvedPortalPlayback | null>(null);
  readonly episodePlaybackPositions = this.playbackPositionState.positions;
  readonly openingEpisodeId = signal<number | null>(null);
  readonly activeEpisodeId = signal<number | null>(null);

  readonly quickStartAction = computed(() => {
    const item = this.selectedItem();
    if (!item) {
      return null;
    }

    return getSeriesQuickStartAction({
      seasons: item.episodes ?? {},
      playbackPositions: this.episodePlaybackPositions(),
    });
  });
  readonly inlineEpisodeState =
    computed<SeriesPlaybackEpisodeState<XtreamSerieEpisode> | null>(() =>
      this.getInlineEpisodeState(),
    );
  readonly inlineEpisodeMetadata = computed(() =>
    getSeriesEpisodeMetadata(this.inlineEpisodeState()),
  );
  readonly inlineSeriesNavigation = computed(() =>
    getSeriesPlaybackNavigation(this.inlineEpisodeState()),
  );

  constructor() {
    effect(() => {
      const session = this.externalPlayback.activeSession();
      const selectedItem = this.selectedItem();
      const playlistId = this.currentPlaylistId();

      if (
        !session?.contentInfo ||
        !selectedItem?.series_id ||
        !playlistId ||
        session.contentInfo.contentType !== "episode" ||
        session.contentInfo.playlistId !== playlistId ||
        session.contentInfo.seriesXtreamId !== Number(selectedItem.series_id)
      ) {
        this.openingEpisodeId.set(null);
        this.activeEpisodeId.set(null);
        return;
      }

      if (session.status === "launching") {
        this.openingEpisodeId.set(session.contentInfo.contentXtreamId);
        this.activeEpisodeId.set(null);
        return;
      }

      if (session.status === "opened" || session.status === "playing") {
        this.openingEpisodeId.set(null);
        this.activeEpisodeId.set(session.contentInfo.contentXtreamId);
        return;
      }

      this.openingEpisodeId.set(null);
      this.activeEpisodeId.set(null);
    });

    effect(() => {
      const target = this.resumeTarget();
      const selectedItem = this.selectedItem();
      const playlistId = this.currentPlaylistId();

      if (!target || !selectedItem || !playlistId) {
        return;
      }

      const episode = this.playbackPositionState.takeResumeEpisode({
        playlistId,
        selectedItem,
        target,
      });
      if (!episode) {
        return;
      }

      untracked(() => this.playEpisode(episode));
    });

    const unsubscribePositionUpdates =
      this.playbackPositionBridge.onPlaybackPositionUpdate(
        (data: PlaybackPositionData) => {
          const selectedItem = this.selectedItem();

          if (
            data.contentType !== "episode" ||
            data.playlistId !== this.currentPlaylistId() ||
            data.seriesXtreamId !== Number(selectedItem?.series_id ?? 0)
          ) {
            return;
          }

          this.playbackPositionState.update(data);
        },
      ) ?? null;

    inject(DestroyRef).onDestroy(() => {
      unsubscribePositionUpdates?.();
    });
  }

  /** Connects the service to the owning component's reactive state. */
  bind(bindings: SerialDetailsPlaybackBindings): void {
    this.bindings.set(bindings);
  }

  /** Clears all playback state when switching to another series. */
  resetForNewSeries(): void {
    this.closeInlinePlayer();
    this.playbackPositionState.reset();
    this.openingEpisodeId.set(null);
    this.activeEpisodeId.set(null);
  }

  playEpisode(episode: XtreamSerieEpisode): void {
    const playlist = this.xtreamStore.currentPlaylist();
    const selectedItem = this.selectedItem();
    if (!playlist || !selectedItem) {
      return;
    }

    this.addToRecentlyViewed(this.route.snapshot.params['serialId']);

    const streamUrl = this.xtreamStore.constructEpisodeStreamUrl(episode);
    const contentInfo: PlayerContentInfo = {
      playlistId: playlist.id,
      contentXtreamId: Number(episode.id),
      contentType: "episode",
      seriesXtreamId: Number(selectedItem.series_id),
      seasonNumber: Number(episode.season),
      episodeNumber: Number(episode.episode_num),
    };

    const position = this.episodePlaybackPositions().get(Number(episode.id));

    const playback: ResolvedPortalPlayback = {
      streamUrl,
      recovery: this.xtreamUrl.buildPlaybackRecoveryMetadata(
        this.getXtreamCredentials(playlist),
        playlist.id,
        streamUrl,
        { savedHeaders: buildXtreamSavedPlaybackHeaders(playlist) },
      ),
      requestPolicy: { accountRef: playlist.id, portalCredentials: true },
      userAgent: playlist.userAgent,
      referer: playlist.referrer,
      origin: playlist.origin,
      title: episode.title,
      thumbnail: selectedItem.info.cover,
      seekPreviews: readProviderSeekPreviews(episode),
      startTime: position?.positionSeconds,
      contentInfo,
      itemIdentity: xtreamItemIdentity(playlist.id, 'episode', contentInfo.contentXtreamId),
      seriesIdentity: xtreamItemIdentity(playlist.id, 'series', contentInfo.seriesXtreamId ?? Number(selectedItem.series_id)),
      work: { kind: 'episode', title: episode.title, seasonNumber: contentInfo.seasonNumber, episodeNumber: contentInfo.episodeNumber,
        series: { ...describeMovieWork(selectedItem.info.name, selectedItem.info), kind: 'series' } },
    };

    this.startPlayback(playback);
  }

  playQuickStartEpisode(): void {
    const action = this.quickStartAction();
    if (!action || action.disabled) {
      return;
    }

    this.playEpisode(action.episode);
  }

  playPreviousEpisode(): void {
    const previous = this.inlineEpisodeState()?.previous;
    if (!previous) {
      return;
    }
    this.playEpisode(previous);
  }

  playNextEpisode(): void {
    const next = this.inlineEpisodeState()?.next;
    if (!next) {
      return;
    }
    this.playEpisode(next);
  }

  handleInlinePlaybackEnded(): void {
    const navigation = this.inlineSeriesNavigation();
    if (!navigation?.autoplayEnabled || !navigation.canNext) {
      return;
    }
    this.playNextEpisode();
  }

  closeInlinePlayer(): void {
    this.inlinePlayback.set(null);
    this.lastSaveTime = 0;
  }

  handleInlineTimeUpdate(event: {
    currentTime: number;
    duration: number;
    persistenceHandled?: boolean;
    action?: 'progress' | 'finished' | 'reset';
  }): void {
    const playback = this.inlinePlayback();
    if (!playback?.contentInfo) return;

    if (event.persistenceHandled) {
      this.playbackPositionState.update({ ...playback.contentInfo, action: event.action, positionSeconds: event.currentTime, durationSeconds: event.duration > 0 ? event.duration : undefined });
      return;
    }
    const now = Date.now();
    if (now - this.lastSaveTime <= 15000) return;

    this.lastSaveTime = now;
    const position: PlaybackPositionData = {
      ...playback.contentInfo,
      action: event.action,
      positionSeconds: event.currentTime,
      durationSeconds: event.duration,
    };
    void this.playbackPositions.savePlaybackPosition(
      playback.contentInfo.playlistId,
      position,
    );
    this.playbackPositionState.update(position);
  }

  handleExternalFallbackRequest(request: PlaybackFallbackRequest): void {
    void this.playbackPositionState.recordExternalLaunch(
      request.playback,
      this.portalPlayer.openExternalPlayback(request.playback, request.player),
      (playlistId, position) =>
        this.playbackPositions.savePlaybackPosition(playlistId, position),
    );
  }

  async handlePlaybackToggleRequested(
    request: SeasonContainerPlaybackToggleRequest,
  ): Promise<void> {
    const playlistId = this.currentPlaylistId();
    if (!playlistId) {
      return;
    }

    if (request.nextPosition) {
      await this.playbackPositions.savePlaybackPosition(
        playlistId,
        request.nextPosition,
      );
      this.playbackPositionState.update(request.nextPosition);
      return;
    }

    await this.playbackPositions.clearPlaybackPosition(
      playlistId,
      request.contentXtreamId,
      "episode",
    );
    this.playbackPositionState.remove(request.contentXtreamId);
  }

  async loadSeriesPlaybackPositions(
    playlistId: string,
    seriesXtreamId: number,
  ): Promise<void> {
    return this.playbackPositionState.load(playlistId, seriesXtreamId, () =>
      this.playbackPositions.getSeriesPlaybackPositions(
        playlistId,
        seriesXtreamId,
      ),
    );
  }

  private selectedItem(): XtreamSerieDetailsView | null {
    return this.bindings()?.selectedItem() ?? null;
  }

  private addToRecentlyViewed(xtreamId: number): void {
    this.xtreamStore.addRecentItem({
      xtreamId,
      contentType: "series",
      playlist: this.xtreamStore.currentPlaylist,
      backdropUrl: this.selectedItem()?.info?.backdrop_path?.[0],
    });
  }

  private startPlayback(playback: ResolvedPortalPlayback): void {
    this.lastSaveTime = 0;
    if (!this.portalPlayer.isEmbeddedPlayer(false)) {
      this.closeInlinePlayer();
      void this.playbackPositionState.recordExternalLaunch(
        playback,
        this.portalPlayer.openResolvedPlayback(playback, true),
        (playlistId, position) =>
          this.playbackPositions.savePlaybackPosition(playlistId, position),
      );
      return;
    }

    this.inlinePlayback.set(playback);
    const navigation = this.inlineSeriesNavigation();
    void this.portalPlayer.openResolvedPlayback(playback, true, {
      canPrevious: navigation?.canPrevious ?? false,
      canNext: navigation?.canNext ?? false,
      autoplayNext: navigation?.autoplayEnabled ?? false,
      onPrevious: () => this.playPreviousEpisode(),
      onNext: () => this.playNextEpisode(),
      onEnded: () => this.handleInlinePlaybackEnded(),
      onClosed: () => this.closeInlinePlayer(),
      onTimeUpdate: (event) => this.handleInlineTimeUpdate(event),
    });
  }

  private getXtreamCredentials(
    playlist: XtreamPlaylistData,
  ): XtreamCredentials {
    return {
      serverUrl: playlist.serverUrl,
      username: playlist.username,
      password: playlist.password,
      playbackServerUrl: playlist.playbackServerUrl,
      allowedOutputFormats: playlist.allowedOutputFormats,
    };
  }

  private getInlineEpisodeState(): SeriesPlaybackEpisodeState<XtreamSerieEpisode> | null {
    const playback = this.inlinePlayback();
    const episodesBySeason = this.selectedItem()?.episodes;
    const currentEpisodeId = playback?.contentInfo?.contentXtreamId;

    if (
      !episodesBySeason ||
      playback?.contentInfo?.contentType !== "episode" ||
      currentEpisodeId === undefined
    ) {
      return null;
    }

    return resolveSeriesPlaybackEpisodeState({
      episodesBySeason,
      currentEpisodeId,
      fallbackSeasonNumber: playback.contentInfo.seasonNumber,
      fallbackEpisodeNumber: playback.contentInfo.episodeNumber,
    });
  }
}

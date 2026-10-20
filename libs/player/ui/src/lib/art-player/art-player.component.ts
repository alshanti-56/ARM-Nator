import { toAbsolutePlaybackPosition, toAbsolutePlaybackDuration, toLocalPlaybackPosition } from '../player-controls/playback-timeline';
import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  OnChanges,
  OnDestroy,
  OnInit,
  output,
  signal,
  SimpleChanges,
  viewChild,
  ChangeDetectionStrategy
} from "@angular/core";
import Artplayer from "artplayer";
import { Channel, createDevLogger } from "@arm-nator/shared/interfaces";
import type { PlaybackDiagnostic } from "../playback-diagnostics/playback-diagnostics.util";
import { readBrowserPlaybackEvidence } from "../playback-diagnostics/playback-evidence";
import {
  PlayerControlsComponent,
  type PlayerMediaTitle,
  type PlayerRuntimeSnapshot,
  WebVideoControlsAdapter,
} from "../player-controls";
import type { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import {
  buildArtPlayerChrome,
  exitOwnedArtPlayerFullscreen,
  getArtPlayerVideoType,
  resolveArtPlayerIsLive,
} from "./art-player-setup";
import { ArtPlayerSourceSession } from "./art-player-source-session";
import { ArtPlayerVideoSession } from "./art-player-video-session";
import { syncOnlineSubtitleTrack } from "../web-video-support/online-subtitle-track";
import { clearNativeVideoSources } from "../web-video-support/web-video-native-source.util";
import { WorkspacePlayerStateService } from "../workspace-player/workspace-player-state.service";

const debugArtPlayer = createDevLogger("ArtPlayer");

@Component({
  selector: "app-art-player",
  imports: [PlayerControlsComponent],
  providers: [WebVideoControlsAdapter],
  templateUrl: "./art-player.component.html",
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ["./art-player.component.scss"],
})
export class ArtPlayerComponent implements OnInit, OnDestroy, OnChanges {
  readonly channel = input.required<Channel>();
  readonly volume = input(1);
  readonly showCaptions = input(false);
  readonly startTime = input(0);
  readonly seekOverride = input<((absoluteSeconds: number) => void) | null>(null);
  readonly timelineOffsetSeconds = input(0);
  readonly durationSeconds = input<number | null>(null);
  readonly seriesNavigation = input<SeriesPlaybackNavigation | null>(null);
  readonly isLive = input(true);
  readonly interactionEnabled = input(true);
  readonly mediaTitle = input<PlayerMediaTitle | null>(null);
  readonly onlineSubtitleUrl = input("");
  readonly onlineSubtitleLabel = input("Online subtitle");
  readonly onlineSubtitleLanguage = input("und");

  readonly timeUpdate = output<{
    currentTime: number;
    duration: number;
  }>();
  readonly playbackIssue = output<PlaybackDiagnostic | null>();
  readonly playbackEnded = output<void>();
  readonly previousEpisodeRequested = output<void>();
  readonly nextEpisodeRequested = output<void>();
  readonly runtimeSnapshotChange = output<PlayerRuntimeSnapshot>();

  readonly controlsAdapter = inject(WebVideoControlsAdapter);
  private readonly unregisterPlaybackTeardown = inject(
    WorkspacePlayerStateService,
  ).registerPlaybackTeardown(() => this.teardownPlayback(), {
    repeatable: true,
  });
  private readonly runtimeSnapshotEffect = effect(() => {
    const state = this.controlsAdapter.state();
    const capabilities = this.controlsAdapter.capabilities();
    const media = this.controlsAdapter.mediaTelemetry();
    this.runtimeSnapshotChange.emit({
      state,
      capabilities,
      media: {
        ...media,
        ...readBrowserPlaybackEvidence(this.player?.video),
      },
      engine: {
        engine: "artplayer",
        available: true,
        sessionStatus: state.status,
      },
    });
  });
  readonly playerRoot = viewChild<ElementRef<HTMLElement>>("playerRoot");
  private readonly artplayerContainer =
    viewChild.required<ElementRef<HTMLDivElement>>("artplayer");
  private readonly seriesNavigationSignal =
    signal<SeriesPlaybackNavigation | null>(null);

  private player: Artplayer | null = null;
  private sourceSession: ArtPlayerSourceSession | null = null;
  private videoSession: ArtPlayerVideoSession | null = null;
  private teardownInFlight: Promise<void> | null = null;
  private destroyed = false;
  private lifecycleGeneration = 0;

  ngOnInit(): void {
    this.seriesNavigationSignal.set(this.seriesNavigation());
    this.controlsAdapter.setContext({
      seriesNavigation: this.seriesNavigationSignal,
      getTimelineOffsetSeconds: () => this.timelineOffsetSeconds(),
      getReportedDurationSeconds: () => this.durationSeconds(),
      ...(this.seekOverride() ? { onTimelineSeek: (seconds: number) => this.seekOverride()?.(seconds) } : {}),
    });
    this.initPlayer();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["seriesNavigation"]) {
      this.seriesNavigationSignal.set(this.seriesNavigation());
    }

    const channelChanged =
      changes["channel"] && !changes["channel"].firstChange;
    const authoritativeLiveChanged =
      changes["isLive"] &&
      !changes["isLive"].firstChange &&
      changes["isLive"].previousValue !== changes["isLive"].currentValue;
    if (channelChanged || authoritativeLiveChanged) {
      void this.restartPlayerAfterTeardown().catch((error: unknown) =>
        debugArtPlayer("Unable to stop the previous source:", error),
      );
    }

    if (changes["showCaptions"]) {
      this.sourceSession?.refreshInputs();
    }
    if (
      changes["onlineSubtitleUrl"] ||
      changes["onlineSubtitleLabel"] ||
      changes["onlineSubtitleLanguage"]
    ) {
      this.syncOnlineSubtitle();
      this.sourceSession?.refreshInputs();
    }
    if (changes["interactionEnabled"]?.currentValue === false) {
      exitOwnedArtPlayerFullscreen(
        this.playerRoot()?.nativeElement,
        (error) =>
          debugArtPlayer("Failed to exit ArtPlayer fullscreen:", error),
      );
    }
    if (changes["volume"]?.currentValue !== undefined && this.player) {
      this.applyVolume(changes["volume"].currentValue);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.lifecycleGeneration += 1;
    void this.teardownPlayback()
      .then(() => this.unregisterPlaybackTeardown())
      .catch(() => undefined);
  }

  private initPlayer(): void {
    if (this.destroyed) {
      return;
    }
    this.playbackIssue.emit(null);
    const channel = this.channel();
    const sourceUrl = channel.url;
    const requestHeaders = this.getRequestHeaders(channel);
    const preparedProxy = channel.http.preparedProxy;
    const sourceSession = new ArtPlayerSourceSession({
      controlsAdapter: this.controlsAdapter,
      isLive: () => this.isLive(),
      showCaptions: () => this.showCaptions(),
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      getDrm: () => this.channel().drm,
      providerRecovery: () => this.channel().http.providerRecovery === true,
      startPaused: channel.http.startPaused,
      hlsRequestHeaders: requestHeaders,
      mediaRequestHeaders: requestHeaders,
      mpegTsRequestHeaders: requestHeaders,
      preparedProxy,
      requestPolicy: channel.http.requestPolicy,
      direct: channel.http.direct,
    });
    this.sourceSession = sourceSession;

    const player = new Artplayer({
      container: this.artplayerContainer().nativeElement,
      url: sourceUrl,
      volume: this.clampVolume(this.volume()),
      isLive: resolveArtPlayerIsLive(this.isLive()),
      autoplay: !channel.http.startPaused,
      type: getArtPlayerVideoType(channel.url, preparedProxy),
      playsInline: true,
      backdrop: true,
      mutex: true,
      theme: "#ff0000",
      ...buildArtPlayerChrome(),
      customType: sourceSession.customType,
    });
    this.player = player;
    this.syncOnlineSubtitle();
    sourceSession.attach(player);

    const videoSession = new ArtPlayerVideoSession({
      player,
      sourceUrl: channel.url,
      isLive: () => this.isLive(),
      getStartTime: () => toLocalPlaybackPosition(this.startTime(), this.timelineOffsetSeconds()),
      getDuration: () => sourceSession.resolveDuration(player.duration),
      persistSharedVolume: true,
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      shouldDeferNativePlaybackError: (errorCode) =>
        sourceSession.shouldDeferNativePlaybackError(errorCode),
      emitTimeUpdate: (value) => this.timeUpdate.emit({
        currentTime: toAbsolutePlaybackPosition(value.currentTime, this.timelineOffsetSeconds()),
        duration: toAbsolutePlaybackDuration(value.duration, this.timelineOffsetSeconds(), this.durationSeconds()) ?? 0,
      }),
      emitPlaybackEnded: () => this.playbackEnded.emit(),
    });
    this.videoSession = videoSession;
    videoSession.attach();

    // ArtPlayer synchronously restores `artplayer_settings.volume` after
    // applying the constructor option. Shared controls use the app-wide
    // volume as authoritative, so reapply it directly to the media element.
    this.applyVolume(this.volume());
  }

  private syncOnlineSubtitle(): void {
    if (!this.player) {
      return;
    }
    syncOnlineSubtitleTrack(this.player.video, {
      url: this.onlineSubtitleUrl(),
      label: this.onlineSubtitleLabel(),
      language: this.onlineSubtitleLanguage(),
    });
  }

  private async restartPlayerAfterTeardown(): Promise<void> {
    const generation = ++this.lifecycleGeneration;
    await this.teardownPlayback();
    if (!this.destroyed && generation === this.lifecycleGeneration) {
      this.initPlayer();
    }
  }

  private teardownPlayback(): Promise<void> {
    if (this.teardownInFlight) {
      return this.teardownInFlight;
    }

    const player = this.player;
    const sourceSession = this.sourceSession;
    const videoSession = this.videoSession;
    const cleanup = (async (): Promise<void> => {
      if (player) {
        clearNativeVideoSources(player.video);
        player.destroy();
        if (this.player === player) {
          this.player = null;
        }
      }
      if (videoSession) {
        videoSession.destroy();
        if (this.videoSession === videoSession) {
          this.videoSession = null;
        }
      }
      await sourceSession?.quiesce();
      if (this.sourceSession === sourceSession) {
        this.sourceSession = null;
      }
    })();
    this.teardownInFlight = cleanup.finally(() => {
      this.teardownInFlight = null;
    });
    return this.teardownInFlight;
  }

  private applyVolume(value: number): void {
    const player = this.player;
    if (!player) {
      return;
    }

    const volume = this.clampVolume(value);
    player.video.volume = volume;
    player.video.muted = volume <= 0;
  }

  private clampVolume(value: number): number {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return 1;
    }
    return Math.max(0, Math.min(1, numericValue));
  }

  private getRequestHeaders(channel: Channel): Record<string, string> {
    const headers = { ...(channel.http.headers ?? {}) };
    const channelHeaders = {
      'User-Agent': channel.http['user-agent'],
      Referer: channel.http.referrer,
      Origin: channel.http.origin,
    };
    for (const [name, value] of Object.entries(channelHeaders)) {
      if (
        value &&
        !Object.keys(headers).some(
          (existing) => existing.toLowerCase() === name.toLowerCase(),
        )
      ) {
        headers[name] = value;
      }
    }
    return headers;
  }
}

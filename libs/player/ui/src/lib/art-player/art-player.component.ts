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
} from "@angular/core";
import Artplayer from "artplayer";
import { Channel, createDevLogger } from "@arm-nator/shared/interfaces";
import type { PlaybackDiagnostic } from "../playback-diagnostics/playback-diagnostics.util";
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

const debugArtPlayer = createDevLogger("ArtPlayer");

@Component({
  selector: "app-art-player",
  imports: [PlayerControlsComponent],
  providers: [WebVideoControlsAdapter],
  templateUrl: "./art-player.component.html",
  styleUrls: ["./art-player.component.scss"],
})
export class ArtPlayerComponent implements OnInit, OnDestroy, OnChanges {
  readonly channel = input.required<Channel>();
  readonly volume = input(1);
  readonly showCaptions = input(false);
  readonly startTime = input(0);
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
  private readonly runtimeSnapshotEffect = effect(() => {
    this.runtimeSnapshotChange.emit({
      state: this.controlsAdapter.state(),
      capabilities: this.controlsAdapter.capabilities(),
      media: this.controlsAdapter.mediaTelemetry(),
      engine: {
        engine: "artplayer",
        available: true,
        sessionStatus: this.controlsAdapter.state().status,
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

  ngOnInit(): void {
    this.seriesNavigationSignal.set(this.seriesNavigation());
    this.controlsAdapter.setContext({
      seriesNavigation: this.seriesNavigationSignal,
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
    if (this.player && (channelChanged || authoritativeLiveChanged)) {
      this.destroyPlayer();
      this.initPlayer();
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
    this.destroyPlayer();
  }

  private initPlayer(): void {
    this.playbackIssue.emit(null);
    const channel = this.channel();
    const sourceUrl = channel.url;
    const sourceSession = new ArtPlayerSourceSession({
      controlsAdapter: this.controlsAdapter,
      isLive: () => this.isLive(),
      showCaptions: () => this.showCaptions(),
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      getDrm: () => this.channel().drm,
      hlsRequestHeaders: {
        'User-Agent': channel.http['user-agent'],
        Referer: channel.http.referrer,
        Origin: channel.http.origin,
      },
      mediaRequestHeaders: {
        'User-Agent': channel.http['user-agent'],
        Referer: channel.http.referrer,
        Origin: channel.http.origin,
      },
    });
    this.sourceSession = sourceSession;

    const player = new Artplayer({
      container: this.artplayerContainer().nativeElement,
      url: sourceUrl,
      volume: this.clampVolume(this.volume()),
      isLive: resolveArtPlayerIsLive(this.isLive()),
      autoplay: true,
      type: getArtPlayerVideoType(channel.url),
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
      getStartTime: () => this.startTime(),
      getDuration: () => sourceSession.resolveDuration(player.duration),
      persistSharedVolume: true,
      emitPlaybackIssue: (issue) => this.playbackIssue.emit(issue),
      shouldDeferNativePlaybackError: (errorCode) =>
        sourceSession.shouldDeferNativePlaybackError(errorCode),
      emitTimeUpdate: (value) => this.timeUpdate.emit(value),
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

  private destroyPlayer(): void {
    const sourceSession = this.sourceSession;
    this.sourceSession = null;
    sourceSession?.destroy();

    const videoSession = this.videoSession;
    this.videoSession = null;
    videoSession?.destroy();

    const player = this.player;
    this.player = null;
    player?.destroy();
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
}

import {
  Component,
  Signal,
  ViewEncapsulation,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { toSignal } from "@angular/core/rxjs-interop";
import { ClipboardModule } from "@angular/cdk/clipboard";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatTooltipModule } from "@angular/material/tooltip";
import { StorageMap } from "@ngx-pwa/local-storage";
import { TranslatePipe } from "@ngx-translate/core";
import {
  Channel,
  ResolvedPortalPlayback,
  Settings,
  STORE_KEY,
  VideoPlayer,
  resolveDefaultVideoPlayer,
} from "@arm-nator/shared/interfaces";
import type { ExternalPlayerName } from "@arm-nator/shared/interfaces";
import { RuntimeCapabilitiesService, SettingsStore } from "@arm-nator/services";
import { ArtPlayerComponent } from "../art-player/art-player.component";
import { EmbeddedMpvPlayerComponent } from "../embedded-mpv-player/embedded-mpv-player.component";
import { HtmlVideoPlayerComponent } from "../html-video-player/html-video-player.component";
import {
  type PlayerMediaTitle,
  type PlayerRuntimeSnapshot,
} from "../player-controls";
import {
  type PlaybackDiagnostic,
  type PlaybackFallbackRequest,
} from "../playback-diagnostics/playback-diagnostics.util";
import type { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import {
  getDiagnosticCodecHint,
  getDiagnosticDescriptionKey,
  getDiagnosticDetails,
  getDiagnosticMeta,
  getDiagnosticTitleKey,
} from "./web-player-view-diagnostics.utils";

@Component({
  selector: "app-web-player-view",
  templateUrl: "./web-player-view.component.html",
  styleUrls: ["./web-player-view.component.scss"],
  host: {
    class: "web-player-view",
  },
  imports: [
    ArtPlayerComponent,
    ClipboardModule,
    EmbeddedMpvPlayerComponent,
    HtmlVideoPlayerComponent,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    TranslatePipe,
  ],
  encapsulation: ViewEncapsulation.None,
})
export class WebPlayerViewComponent {
  storage = inject(StorageMap);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly settingsStore = inject(SettingsStore);

  streamUrl = input.required<string>();
  title = input("");
  playback = input<ResolvedPortalPlayback | null>(null);
  startTime = input<number>(0);
  volume = input<number>(1);
  playerOverride = input<VideoPlayer | null>(null);
  reloadGeneration = input(0);
  seriesNavigation = input<SeriesPlaybackNavigation | null>(null);
  /** Display-ready title lines for the fullscreen overlay; hosts with richer
   * context (e.g. series name + episode label) pass it explicitly. */
  mediaTitle = input<PlayerMediaTitle | null>(null);
  readonly timeUpdate = output<{
    currentTime: number;
    duration: number;
  }>();
  readonly externalFallbackRequested = output<PlaybackFallbackRequest>();
  readonly playbackDiagnosticChange = output<PlaybackDiagnostic | null>();
  readonly runtimeSnapshotChange = output<PlayerRuntimeSnapshot>();
  readonly playbackEnded = output<void>();
  readonly previousEpisodeRequested = output<void>();
  readonly nextEpisodeRequested = output<void>();

  settings = toSignal(this.storage.get(STORE_KEY.Settings)) as Signal<
    Settings | undefined
  >;

  /**
   * Subtitle preference for the built-in web players. Read from the settings
   * store instead of an input so every host
   * detail pages) gets it without having to wire it through — the missing
   * bindings were why the setting looked like a no-op (#1155).
   */
  readonly showCaptions = computed(
    () => this.settingsStore.showCaptions?.() ?? false,
  );

  channel!: Channel;
  readonly reloadToken = signal(0);
  readonly playbackDiagnostic = signal<PlaybackDiagnostic | null>(null);
  readonly visiblePlaybackDiagnostic = computed(() =>
    this.selectedPlayer() === VideoPlayer.EmbeddedMpv ||
    this.selectedPlayer() === VideoPlayer.KsPlayer
      ? null
      : this.playbackDiagnostic(),
  );
  readonly playbackInteractionEnabled = computed(
    () => this.visiblePlaybackDiagnostic() === null,
  );
  readonly canShowExternalFallbackActions = computed(
    () =>
      this.runtime.supportsManagedExternalPlayers &&
      !!this.visiblePlaybackDiagnostic()?.externalFallbackRecommended,
  );
  readonly diagnosticHeadlineKey = computed(() =>
    this.canShowExternalFallbackActions()
      ? "PLAYBACK_DIAGNOSTICS.NATIVE_FALLBACK_TITLE"
      : "PLAYBACK_DIAGNOSTICS.INLINE_FAILURE_TITLE",
  );

  readonly resolvedPlayback = computed<ResolvedPortalPlayback>(() => {
    const playback = this.playback();
    if (playback) {
      return playback;
    }

    return {
      streamUrl: this.streamUrl(),
      title: this.title() || this.streamUrl(),
      startTime: this.startTime(),
    };
  });
  readonly resolvedIsLive = computed(() => {
    const playback = this.resolvedPlayback();
    return typeof playback.isLive === "boolean"
      ? playback.isLive
      : !playback.contentInfo;
  });
  readonly selectedPlayer = computed(() => {
    const override = this.playerOverride();
    if (override) {
      return override;
    }
    const settings = this.settings();
    return settings
      ? resolveDefaultVideoPlayer(settings, this.resolvedIsLive())
      : VideoPlayer.ArtPlayer;
  });
  readonly resolvedMediaTitle = computed<PlayerMediaTitle | null>(() => {
    const explicit = this.mediaTitle();
    if (explicit?.primary?.trim()) {
      return explicit;
    }
    const playback = this.resolvedPlayback();
    const title = playback.title?.trim();
    // resolvedPlayback() falls back to the stream URL as title; a raw URL
    // is not a watchable overlay title.
    if (!title || title === playback.streamUrl) {
      return null;
    }
    return { primary: title, secondary: null };
  });

  constructor() {
    effect(() => {
      // Track player changes so stale browser diagnostics are cleared on switch.
      this.selectedPlayer();
      this.reloadGeneration();

      const playback = this.resolvedPlayback();
      this.playbackDiagnostic.set(null);
      this.setChannel(playback);

      const userAgent =
        playback.userAgent ?? this.getHeaderValue(playback.headers, "User-Agent");
      const referer =
        playback.referer ?? this.getHeaderValue(playback.headers, "Referer");
      if (userAgent || referer) {
        void window.electron?.setUserAgent(userAgent, referer, playback.streamUrl)
          .catch(() => undefined);
      }
    });
  }

  setChannel(playbackOrUrl: ResolvedPortalPlayback | string) {
    const playback =
      typeof playbackOrUrl === "string"
        ? {
            streamUrl: playbackOrUrl,
            title: playbackOrUrl,
          }
        : playbackOrUrl;

    this.channel = {
      id: playback.streamUrl,
      url: playback.streamUrl,
      name: playback.title || playback.streamUrl,
      group: { title: "" },
      tvg: {
        id: "",
        name: playback.title || playback.streamUrl,
        url: "",
        logo: playback.thumbnail ?? "",
        rec: "",
      },
      http: {
        referrer:
          playback.referer ??
          this.getHeaderValue(playback.headers, "Referer") ??
          "",
        "user-agent":
          playback.userAgent ??
          this.getHeaderValue(playback.headers, "User-Agent") ??
          "",
        origin:
          playback.origin ??
          this.getHeaderValue(playback.headers, "Origin") ??
          "",
      },
      radio: "false",
      drm: playback.drm,
    };
  }

  handlePlaybackIssue(issue: PlaybackDiagnostic | null): void {
    if (
      this.selectedPlayer() === VideoPlayer.EmbeddedMpv ||
      this.selectedPlayer() === VideoPlayer.KsPlayer
    ) {
      this.playbackDiagnostic.set(null);
      this.playbackDiagnosticChange.emit(null);
      return;
    }

    this.playbackDiagnostic.set(issue);
    this.playbackDiagnosticChange.emit(issue);
  }

  requestExternalFallback(player: ExternalPlayerName): void {
    const diagnostic = this.visiblePlaybackDiagnostic();
    if (!diagnostic) {
      return;
    }

    this.externalFallbackRequested.emit({
      player,
      playback: this.resolvedPlayback(),
      diagnostic,
    });
  }

  retryPlayback(): void {
    const playback = this.resolvedPlayback();

    this.playbackDiagnostic.set(null);
    this.playbackDiagnosticChange.emit(null);
    this.reloadToken.update((value) => value + 1);
    this.setChannel(playback);
  }

  readonly getDiagnosticTitleKey = getDiagnosticTitleKey;
  readonly getDiagnosticMeta = getDiagnosticMeta;
  readonly getDiagnosticCodecHint = getDiagnosticCodecHint;
  readonly getDiagnosticDetails = getDiagnosticDetails;

  getDiagnosticDescriptionKey(issue: PlaybackDiagnostic): string {
    return getDiagnosticDescriptionKey(
      issue,
      this.runtime.supportsManagedExternalPlayers,
    );
  }

  private getHeaderValue(
    headers: ResolvedPortalPlayback["headers"] | undefined,
    name: string,
  ): string | undefined {
    if (!headers) {
      return undefined;
    }

    const matchingKey = Object.keys(headers).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );
    return matchingKey ? headers[matchingKey] : undefined;
  }
}

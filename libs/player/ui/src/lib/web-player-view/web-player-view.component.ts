import { catalogueIdentityKey } from '@arm-nator/shared/interfaces';
import { waitForRecoveryRetry } from '../playback-recovery/recovery-retry-delay';
import { PLAYER_FACADE, originalProviderPlayback, getPlaybackContext, registerPlaybackContext, PLAYER_ENGINES } from '@arm-nator/player/core';
import { PlaybackRecoveryMenuComponent } from '../playback-recovery/playback-recovery-menu.component';
import { applyRecoveryAction, buildRecoveryActions, type RecoveryAction, type RecoveryEngine, type RecoverySelection } from '../playback-recovery/playback-recovery-actions';
import { WorkspacePlayerStateService } from '../workspace-player/workspace-player-state.service';
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
  viewChild,
  ChangeDetectionStrategy
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
import { ArtPlayer2Component } from "../art-player2/art-player2.component";
import { EmbeddedMpvPlayerComponent } from "../embedded-mpv-player/embedded-mpv-player.component";
import { HtmlVideoPlayerComponent } from "../html-video-player/html-video-player.component";
import {
  type PlayerMediaTitle,
  type PlayerController,
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
    ArtPlayer2Component,
    ClipboardModule,
    EmbeddedMpvPlayerComponent,
    HtmlVideoPlayerComponent,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    TranslatePipe,
    PlaybackRecoveryMenuComponent,
  ],
  changeDetection: ChangeDetectionStrategy.Eager,
  encapsulation: ViewEncapsulation.None,
})
export class WebPlayerViewComponent {
  private readonly htmlPlayer = viewChild(HtmlVideoPlayerComponent);
  private readonly artPlayer = viewChild(ArtPlayerComponent);
  private readonly stockPlayer = viewChild(ArtPlayer2Component);
  private readonly nativePlayer = viewChild(EmbeddedMpvPlayerComponent);

  currentController(): PlayerController | null {
    return this.nativePlayer()?.sharedControls ?? this.htmlPlayer()?.controlsAdapter ?? this.artPlayer()?.controlsAdapter ?? null;
  }

  seekToConfirmedPosition(positionSeconds: number): boolean {
    const controller = this.currentController();
    if (controller) {
      if (!controller.capabilities().seek || !controller.state().canSeek) return false;
      controller.commands.seekTo(positionSeconds);
      return true;
    }
    return this.stockPlayer()?.seekToPosition(positionSeconds) ?? false;
  }

  storage = inject(StorageMap);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly settingsStore = inject(SettingsStore);

  streamUrl = input.required<string>();
  title = input("");
  playback = input<ResolvedPortalPlayback | null>(null);
  /** Hosts can hold the mounted player until an owned transition is ready. */
  playbackEnabled = input(true);
  /** A host-level preparation failure can be shown before any player mounts. */
  initialDiagnostic = input<PlaybackDiagnostic | null>(null);
  /** When true, the host owns retry so it can mint a fresh provider URL. */
  retryWithPlaybackContext = input(false);
  providerRecovery = input(false);
  recoveryActions = input<readonly RecoveryAction[] | null>(null);
  recoveryEngines = input<readonly RecoveryEngine[]>([]);
  recoveryBusy = input(false);
  readonly recoverySelected = output<RecoverySelection>();
  readonly recoveryHelp = signal<string | null>(null);
  private readonly playerFacade = inject(PLAYER_FACADE, { optional: true });
  private readonly workspaceState = inject(WorkspacePlayerStateService);
  readonly standaloneRecoveryBusy = computed(() => !this.retryWithPlaybackContext() && this.workspaceState.recoveryBusy());
  readonly standaloneRecoveryCountdown = this.workspaceState.recoveryCountdown;
  cancelStandaloneRecovery(): void { this.workspaceState.cancelRecovery(); }
  private readonly recoveredInlineSource = signal<{ original: ResolvedPortalPlayback; source: ResolvedPortalPlayback } | null>(null);
  private latestInlineSnapshot: PlayerRuntimeSnapshot | null = null;
  private inlineHasAdvanced = false;
  private inlineHandedOff = false;
  private inlineSelectionId: number | undefined;
  private inlineSource?: ResolvedPortalPlayback;
  private readonly inlineCredentialAvailability = signal({ loginCookies: false, portalCredentials: false });
  private readonly inlineRuntimeAvailability = signal<Record<string, { available: boolean; detail?: string }>>({});
  private readonly inlineDrmAvailable = signal(false);
  readonly inlineRecoveryEngines = computed<RecoveryEngine[]>(() => PLAYER_ENGINES.map(engine => {
    const playback = this.resolvedPlayback();
    const runtime = this.inlineRuntimeAvailability()[engine.id];
    const browser = [VideoPlayer.ArtPlayer, VideoPlayer.Html5Player, VideoPlayer.ArtPlayer2].includes(engine.id);
    const automatic = engine.id === VideoPlayer.Auto;
    const compatible = (!playback.drm || (playback.drm.supported && (!playback.drm.licenseServerUrl || this.inlineDrmAvailable()) && [VideoPlayer.Auto, VideoPlayer.ArtPlayer, VideoPlayer.Html5Player].includes(engine.id))) && !(engine.id === VideoPlayer.ArtPlayer2 && /\.mpd(?:[?#]|$)/i.test(playback.originalStreamUrl ?? playback.streamUrl));
    const different = engine.id !== this.selectedPlayer();
    return { ...engine, available: different && compatible && (browser || automatic || runtime?.available === true),
      detail: !different ? 'Already selected' : !compatible ? 'This player does not support the configured media and DRM.' : runtime?.detail ?? 'Player runtime is unavailable' };
  }));
  readonly resolvedRecoveryActions = computed(() => this.recoveryActions() ?? buildRecoveryActions({
    playback: this.resolvedPlayback(), canResolve: !!getPlaybackContext(this.resolvedPlayback())?.resolvePlayback,
    proxyAvailable: !!this.playerFacade && window.electron?.platform !== 'web' && typeof window.electron?.prepareAutoPlayback === 'function',
    ...this.inlineCredentialAvailability(), drmAvailable: this.inlineDrmAvailable(), engines: this.inlineRecoveryEngines(),
    network: this.playbackDiagnostic()?.network, diagnosticCode: this.playbackDiagnostic()?.code,
  }));

  async executeRecovery(selection: RecoverySelection): Promise<void> {
    if (this.retryWithPlaybackContext()) { this.recoverySelected.emit(selection); return; }
    const facade = this.playerFacade;
    if (this.workspaceState.recoveryBusy()) return;
    if (selection.id === 'engine' && (!selection.engine || !this.inlineRecoveryEngines().find(engine => engine.id === selection.engine)?.available)) return;
    if (!facade || !this.resolvedRecoveryActions().find(action => action.id === selection.id)?.enabled) {
      if (selection.id === 'retry') this.retryPlayback();
      return;
    }
    const baseline = this.resolvedPlayback();
    const context = getPlaybackContext(baseline);
    this.prepareInlineRecovery(baseline);
    await this.workspaceState.recoverPlayback(async request => {
      if (selection.id === 'wait') await waitForRecoveryRetry(Math.max(0, this.playbackDiagnostic()?.network?.retryAfterSeconds ?? 5) * 1000, request.signal, seconds => this.workspaceState.recoveryCountdown.set(seconds));
      return selection.id === 'fresh-link' && context?.resolvePlayback
        ? context.resolvePlayback(request) : applyRecoveryAction(originalProviderPlayback(baseline), selection.id);
    }, async (playback, context) => {
      if (selection.engine === VideoPlayer.MPV || selection.engine === VideoPlayer.VLC) await facade.openExternalPlayback(playback, selection.engine === VideoPlayer.VLC ? 'vlc' : 'mpv');
      else if (selection.id !== 'direct' && selection.id !== 'engine' && typeof window.electron?.prepareAutoPlayback === 'function') await facade.openAutomaticPlayback?.(playback, context);
      else await facade.openInlinePlayback(playback, selection.engine ?? (this.selectedPlayer() === VideoPlayer.Auto ? VideoPlayer.ArtPlayer : this.selectedPlayer()), context);
      this.inlineHandedOff = true;
    }, false, selection.id === 'wait' ? Infinity : 15_000, { playback: baseline, context, snapshot: () => this.latestInlineSnapshot });
  }
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
  readonly playbackRetryRequested = output<void>();
  readonly runtimeSnapshotChange = output<PlayerRuntimeSnapshot>();
  readonly playbackEnded = output<void>();
  readonly previousEpisodeRequested = output<void>();
  readonly nextEpisodeRequested = output<void>();

  private prepareInlineRecovery(playback: ResolvedPortalPlayback): void {
    if (this.inlineSource === playback) return;
    this.inlineSource = playback;
    const context = getPlaybackContext(playback);
    if (!context?.recoveryIdentity || !this.workspaceState.recovery.isCurrent(context.recoveryIdentity)) this.workspaceState.recovery.beginSelection();
    this.inlineSelectionId = this.workspaceState.recovery.identity.selectionId;
    this.inlineHandedOff = false;
    if (!context?.recoveryIdentity) this.workspaceState.recoveryBaseline.set(originalProviderPlayback(playback));
  }

  readonly companionSeekOverride = computed(() => {
    const playback = this.resolvedPlayback();
    const proxy = playback.preparedProxy;
    return !playback.isLive && proxy &&
      (proxy.processingMode === 'convert' || proxy.processingMode === 'remux') ? this.seekCompanion : null;
  });
  private readonly seekCompanion = (seconds: number): void => {
    if (!Number.isFinite(seconds) || seconds < 0 || !this.playerFacade) return;
    const playback = this.resolvedPlayback();
    const mode = playback.preparedProxy?.processingMode;
    if (mode !== 'remux' && mode !== 'convert') return;
    const snapshot = this.workspaceState.runtimeSnapshot();
    const original: ResolvedPortalPlayback = {
      ...originalProviderPlayback(playback), startTime: seconds, resumePolicy: 'start-over',
      preferredProcessingMode: mode, startPaused: snapshot?.state.status === 'paused',
      recoveryState: snapshot ? {
        volume: snapshot.state.volume, playbackSpeed: snapshot.state.playbackSpeed,
        audio: snapshot.state.audioTracks.find(track => track.selected),
        subtitle: snapshot.state.subtitlesEnabled ? snapshot.state.subtitleTracks.find(track => track.selected) : 'off',
      } : playback.recoveryState,
    };
    void this.playerFacade.openInlinePlayback(original, this.selectedPlayer(), this.workspaceState.context() ?? undefined);
  };

  handleRuntimeSnapshot(snapshot: PlayerRuntimeSnapshot): void {
    this.runtimeSnapshotChange.emit(snapshot);
    if (this.retryWithPlaybackContext()) return;
    const last = this.latestInlineSnapshot;
    if (last && snapshot.state.status === 'playing' && !snapshot.state.stalled && !snapshot.state.seeking && snapshot.state.positionSeconds > last.state.positionSeconds) this.inlineHasAdvanced = true;
    this.latestInlineSnapshot = snapshot;
    if (this.inlineSelectionId === this.workspaceState.recovery.identity.selectionId && !this.inlineHandedOff) {
      this.workspaceState.recovery.observe(snapshot.state.positionSeconds, snapshot.state.stalled ? 'loading' : snapshot.state.status, snapshot.state.seeking);
    }
  }

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
  readonly playerMounted = signal(true);
  readonly playbackDiagnostic = signal<PlaybackDiagnostic | null>(null);
  readonly visiblePlaybackDiagnostic = computed(() => {
    const initialDiagnostic = this.initialDiagnostic();
    if (this.recoveryBusy() || this.workspaceState.recoveryBusy()) return null;
    if (initialDiagnostic) {
      return initialDiagnostic;
    }
    return this.selectedPlayer() === VideoPlayer.EmbeddedMpv ||
      this.selectedPlayer() === VideoPlayer.KsPlayer
      ? null
      : this.playbackDiagnostic();
  });
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
      const recovered = this.recoveredInlineSource();
      return recovered?.original === playback ? recovered.source : playback;
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

  private lastReloadGeneration: number | null = null;

  constructor() {
    const bridge = typeof window === 'undefined' ? undefined : window.electron;
    if (bridge?.getEmbeddedMpvSupport) void bridge.getEmbeddedMpvSupport().then(value => this.inlineRuntimeAvailability.update(current => ({ ...current, [VideoPlayer.EmbeddedMpv]: { available: value.supported, detail: value.reason } }))).catch(() => {});
    if (bridge?.getKsPlayerMetalSupport) void bridge.getKsPlayerMetalSupport().then(value => this.inlineRuntimeAvailability.update(current => ({ ...current, [VideoPlayer.KsPlayer]: { available: value.supported, detail: value.reason } }))).catch(() => {});
    if (bridge?.getPlayerEngineAvailability) void bridge.getPlayerEngineAvailability().then(values => this.inlineRuntimeAvailability.update(current => ({ ...current, ...Object.fromEntries(values.map(value => [value.engine, { available: value.available, detail: value.reason }])) }))).catch(() => {});
    effect((onCleanup) => {
      const playback = this.resolvedPlayback();
      this.inlineSource = undefined;
      this.inlineHandedOff = false;
      this.inlineSelectionId = getPlaybackContext(playback)?.recoveryIdentity?.selectionId;
      this.latestInlineSnapshot = null;
      this.inlineHasAdvanced = false;
      this.inlineCredentialAvailability.set({ loginCookies: false, portalCredentials: false });
      this.inlineDrmAvailable.set(false);
      let current = true; onCleanup(() => {
        current = false;
        if (!this.inlineHandedOff && this.inlineSelectionId === this.workspaceState.recovery.identity.selectionId && this.inlineSource === playback) this.workspaceState.cancelRecovery();
      });
      const drm = playback.drm;
      if (drm?.supported && drm.licenseServerUrl && typeof navigator !== 'undefined' && navigator.requestMediaKeySystemAccess) {
        void navigator.requestMediaKeySystemAccess(drm.licenseType, [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }])
          .then(() => { if (current) this.inlineDrmAvailable.set(true); }).catch(() => {});
      }
      const accountRef = playback.recovery?.accountRef;
      if (accountRef) void window.electron?.getPlaybackRecoveryAvailability?.(accountRef)
        .then(value => { if (current) this.inlineCredentialAvailability.set(value); }).catch(() => {});
    });
    effect(() => {
      const generation = this.reloadGeneration();
      if (this.lastReloadGeneration === null) {
        this.lastReloadGeneration = generation;
        return;
      }
      if (generation !== this.lastReloadGeneration) {
        this.lastReloadGeneration = generation;
        this.remountPlayer();
      }
    });

    effect(() => {
      // Track player changes so stale browser diagnostics are cleared on switch.
      this.selectedPlayer();
      this.reloadGeneration();

      const playback = this.resolvedPlayback();
      this.playbackDiagnostic.set(null);
      this.setChannel(playback);

      const userAgent =
        playback.userAgent ??
        this.getHeaderValue(playback.headers, "User-Agent");
      const referer =
        playback.referer ?? this.getHeaderValue(playback.headers, "Referer");
      {
        void window.electron
          ?.setUserAgent(
            userAgent,
            referer,
            playback.originalStreamUrl ?? playback.streamUrl,
          )
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
      seekPreviews: playback.seekPreviews,
      seekPreviewCacheKey: playback.itemIdentity ? catalogueIdentityKey(playback.itemIdentity) : playback.originalStreamUrl ?? playback.streamUrl,
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
        headers: playback.headers,
        preparedProxy: playback.preparedProxy,
        requestPolicy: playback.requestPolicy,
        direct: playback.transport === 'direct',
        providerRecovery: this.providerRecovery() || !!getPlaybackContext(playback)?.resolvePlayback,
        startPaused: playback.startPaused,
      },
      radio: "false",
      drm: playback.drm,
    };
  }

  handlePlaybackIssue(issue: PlaybackDiagnostic | null): void {
    if (issue) issue = { ...issue, attemptToken: this.resolvedPlayback().playbackAttemptToken };
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
    if (this.retryWithPlaybackContext() || !issue?.network || !this.inlineHasAdvanced || !this.playerFacade) return;
    const baseline = this.resolvedPlayback();
    const context = getPlaybackContext(baseline);
    if (!context?.resolvePlayback) return;
    this.prepareInlineRecovery(baseline);
    const clock = this.latestInlineSnapshot?.state.positionSeconds ?? 0;
    if (!this.workspaceState.recovery.busy) {
      this.workspaceState.recovery.observe(clock - 0.01, 'playing', false, Date.now() - 1000);
      this.workspaceState.recovery.observe(clock, 'playing');
    }
    this.workspaceState.recovery.noteFailure(issue.network);
    if (!this.workspaceState.recovery.canRenew(issue.network)) return;
    void this.workspaceState.recoverPlayback(context.resolvePlayback, async (playback, renewedContext) => {
      const transition = await this.workspaceState.prepareForPlayback();
      if (transition === null || !this.workspaceState.isPlaybackTransitionCurrent(transition)) throw new Error('Playback replacement was cancelled');
      registerPlaybackContext(playback, renewedContext);
      this.inlineHandedOff = true;
      this.recoveredInlineSource.set({ original: this.playback() ?? baseline, source: playback });
      this.playbackDiagnostic.set(null);
    }, true, 15_000, { playback: baseline, context, snapshot: () => this.latestInlineSnapshot });
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
    this.playbackDiagnostic.set(null);
    this.playbackDiagnosticChange.emit(null);
    if (this.retryWithPlaybackContext()) {
      this.playbackRetryRequested.emit();
      return;
    }

    this.remountPlayer();
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

  private remountPlayer(): void {
    this.reloadToken.update((value) => value + 1);
    this.playerMounted.set(false);
    window.setTimeout(() => this.playerMounted.set(true), 0);
  }
}

import { NativeCompositionService } from '../embedded-mpv-player/native-composition.service';
import { Router } from '@angular/router';
import { DiscoverySelectionService } from '@arm-nator/providers/shared/util';
import { catalogueIdentityKey } from '@arm-nator/shared/interfaces';
import type { DiscoveryVersion } from '@arm-nator/shared/interfaces';
import { waitForRecoveryRetry } from '../playback-recovery/recovery-retry-delay';
import { PlaybackRecoveryMenuComponent } from '../playback-recovery/playback-recovery-menu.component';
import { applyRecoveryAction, buildRecoveryActions, type RecoverySelection } from '../playback-recovery/playback-recovery-actions';
import { ClipboardModule } from "@angular/cdk/clipboard";
import { CdkDrag, CdkDragHandle, type CdkDragEnd } from '@angular/cdk/drag-drop';
import { ControlsVisibility } from '../player-controls/controls-visibility';
import { MiniPlayerChromeService } from './mini-player-chrome.service';
import { clampFloatingPlayerPosition } from './floating-player-position';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  untracked,
} from "@angular/core";
import { MatButtonModule } from "@angular/material/button";
import { MatIconModule } from "@angular/material/icon";
import { MatMenuModule } from "@angular/material/menu";
import { MatTooltipModule } from "@angular/material/tooltip";
import { TranslatePipe } from "@ngx-translate/core";
import {
  PLAYER_ENGINES,
  PLAYER_FACADE,
  getPlayerEngine,
  isManagedExternalPlayer,
  originalProviderPlayback,
} from "@arm-nator/player/core";
import type {
  BrowserViewBounds,
  PlayerEngineAvailability,
} from "@arm-nator/shared/interfaces";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import type {
  PlaybackDiagnostic,
  PlaybackFallbackRequest,
} from "../playback-diagnostics/playback-diagnostics.model";
import type { SeriesPlaybackNavigation } from "../portal-inline-player/series-playback-navigation";
import { WebPlayerViewComponent } from "../web-player-view/web-player-view.component";
import { hasStartedNativeSession } from "./workspace-player-native-session";
import { WorkspacePlayerStateService } from "./workspace-player-state.service";

const CODEC_ALIASES: Readonly<Record<string, string>> = {
  avc: "H.264",
  avc1: "H.264",
  av01: "AV1",
  av1: "AV1",
  h264: "H.264",
  h265: "HEVC",
  hevc: "HEVC",
  hev1: "HEVC",
  hvc1: "HEVC",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  theora: "Theora",
  vp08: "VP8",
  vp09: "VP9",
  vp8: "VP8",
  vp9: "VP9",
};

export interface WorkspaceNativeSupport {
  readonly supported: boolean;
  readonly reason?: string;
  readonly runtimePath?: string;
}

export interface WorkspacePlayerEngineAvailability {
  readonly id: VideoPlayer;
  readonly available: boolean;
  readonly detail: string;
}
/**
 * Native backends are independent. In particular, a working embedded MPV
 * runtime does not make KS Player selectable (or vice versa).
 */
export function getWorkspacePlayerEngineAvailability(
  engine: VideoPlayer,
  embeddedMpvSupport: WorkspaceNativeSupport | null,
  ksPlayerMetalSupport: WorkspaceNativeSupport | null,
  externalEngineAvailability: readonly PlayerEngineAvailability[] | null = null,
): WorkspacePlayerEngineAvailability {
  if (engine === VideoPlayer.Auto) {
    return { id: engine, available: true, detail: 'Capability-aware player selection and bounded recovery' };
  }

  if (engine === VideoPlayer.EmbeddedMpv) {
    const available = embeddedMpvSupport?.supported === true;
    return {
      id: engine,
      available,
      detail: available
        ? "Available"
        : (embeddedMpvSupport?.reason ?? "Checking embedded MPV support"),
    };
  }

  if (engine === VideoPlayer.KsPlayer) {
    const available = ksPlayerMetalSupport?.supported === true;
    return {
      id: engine,
      available,
      detail: available
        ? (ksPlayerMetalSupport?.runtimePath ?? "Available")
        : (ksPlayerMetalSupport?.reason ?? "Checking KS Player support"),
    };
  }

  if (isManagedExternalPlayer(engine)) {
    if (externalEngineAvailability === null) {
      return {
        id: engine,
        available: false,
        detail: "Checking external player availability",
      };
    }

    const availability = externalEngineAvailability.find(
      (item) => item.engine === engine,
    );
    return {
      id: engine,
      available: availability?.available === true,
      detail:
        availability?.path ??
        availability?.reason ??
        "Optional external player is unavailable",
    };
  }

  return { id: engine, available: true, detail: "Available" };
}

function safeMediaLabel(value: string | undefined): string | null {
  const label = value?.trim();
  if (
    !label ||
    [...label].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || code === 0xfffd;
    })
  ) {
    return null;
  }
  return label;
}

function formatCodecLabel(codec: string | undefined): string {
  const safeCodec = safeMediaLabel(codec);
  if (safeCodec) {
    return CODEC_ALIASES[safeCodec.toLowerCase()] ?? safeCodec;
  }
  return "—";
}

function formatMediaFormat(container: string | undefined): string {
  return safeMediaLabel(container) ?? "—";
}

function formatHwdecLabel(hwdec: string | undefined): string {
  const safeHwdec = safeMediaLabel(hwdec);
  if (!safeHwdec) {
    return "—";
  }

  const normalized = safeHwdec.toLowerCase();
  if (normalized === "no") {
    return "Software";
  }
  if (normalized === "videotoolbox") {
    return "VideoToolbox";
  }
  if (normalized === "videotoolbox-copy") {
    return "VideoToolbox Copy";
  }
  return safeHwdec;
}

@Component({
  selector: "app-workspace-player-host",
  imports: [
    CdkDrag,
    CdkDragHandle,
    ClipboardModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    TranslatePipe,
    WebPlayerViewComponent,
    PlaybackRecoveryMenuComponent,
  ],
  templateUrl: "./workspace-player-host.component.html",
  styleUrl: "./workspace-player-host.component.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [MiniPlayerChromeService],
})
export class WorkspacePlayerHostComponent {
  private readonly destroyRef = inject(DestroyRef);
  private readonly chrome = inject(MiniPlayerChromeService);
  private readonly floatingFrame = viewChild<ElementRef<HTMLElement>>('floatingFrame');
  readonly floatingPosition = signal({ x: 0, y: 0 });
  readonly dragging = signal(false);
  readonly headerMenuOpen = signal(false);
  readonly headerHovered = signal(false);
  private readonly keyboardFocus = signal(false);
  private geometryFrame: number | null = null;
  private readonly headerVisibility = new ControlsVisibility(() => this.canHideHeader());
  readonly dragPosition = computed(() => this.isMini() ? this.floatingPosition() : { x: 0, y: 0 });
  readonly collapsed = computed(() => this.isMini() && this.state.miniPlayerCollapsed());
  readonly headerVisible = computed(() => !this.isMini() || this.collapsed() ||
    !this.canHideHeader() || this.headerVisibility.visible() || this.chrome.controlsVisible());
  readonly nativeComposition = inject(NativeCompositionService);
  private readonly element = inject(ElementRef<HTMLElement>).nativeElement;
  private readonly player = inject(PLAYER_FACADE);
  private readonly playerSurface =
    viewChild<ElementRef<HTMLElement>>("playerSurface");
  private lastYoutubeBounds = "";
  private readonly embeddedMpvSupport = signal<WorkspaceNativeSupport | null>(
    null,
  );
  private readonly ksPlayerMetalSupport = signal<WorkspaceNativeSupport | null>(
    null,
  );
  private readonly externalEngineAvailability = signal<
    readonly PlayerEngineAvailability[] | null
  >(null);
  private readonly metalPlaybackFailure = signal<string | null>(null);

  readonly state = inject(WorkspacePlayerStateService);
  readonly discoverySelection=inject(DiscoverySelectionService);
  private readonly discoveryRouter=inject(Router);
  readonly alternativeVersions=computed(()=>{
    if(!this.discoverySelection.matches(this.state.playback()))return [];
    const selection=this.discoverySelection.selection();
    return selection?.versions.filter(version=>catalogueIdentityKey(version.identity)!==catalogueIdentityKey(selection.selected.identity))??[];
  });
  async chooseAlternativeVersion(version:DiscoveryVersion):Promise<void>{
    const selection=this.discoverySelection.selection();
    if(!selection || !this.alternativeVersions().includes(version))return;
    if (!this.discoverySelection.requestPlayback(version, this.state.playback()?.work)) return;
    const request = this.discoverySelection.playbackRequest();
    try { await this.state.close(); }
    catch {
      if (this.discoverySelection.playbackRequest() === request) this.discoverySelection.cancelPlaybackRequest();
      return;
    }
    if (this.discoverySelection.playbackRequest() !== request) return;
    if(this.state.playback() || (this.discoverySelection.selection() && this.discoverySelection.selection()!==selection)) {
      this.discoverySelection.cancelPlaybackRequest();
      return;
    }
    this.discoverySelection.select(selection.versions,version);
    try {
      if (!await this.discoveryRouter.navigate(version.navigation,{state:{...version.navigationState,title:version.originalTitle,imageUrl:version.posterUrl}})) this.discoverySelection.cancelPlaybackRequest();
    } catch {
      this.discoverySelection.cancelPlaybackRequest();
      this.discoverySelection.error.set('The selected version could not be opened.');
    }
  }
  private readonly playbackVersionsEffect = effect(() => {
    const playback = this.state.playback();
    untracked(() => { void this.discoverySelection.loadForPlayback(playback); });
  });
  readonly engines = PLAYER_ENGINES;
  readonly engineAvailability = computed(() =>
    this.engines.map((engine) => ({
      ...engine,
      ...getWorkspacePlayerEngineAvailability(
        engine.id,
        this.embeddedMpvSupport(),
        this.ksPlayerMetalSupport(),
        this.externalEngineAvailability(),
      ),
    })),
  );
  readonly recoveryHelp = signal<string | null>(null);
  private readonly credentialAvailability = signal({ loginCookies: false, portalCredentials: false });
  private readonly drmAvailable = signal(false);
  readonly recoveryEngines = computed(() => {
    const drm = this.state.playback()?.drm;
    return this.engineAvailability().map(engine => {
      const source = this.state.playback();
      const dash = source?.preparedProxy?.format === 'dash' || /\.mpd(?:[?#]|$)/i.test(source?.originalStreamUrl ?? source?.streamUrl ?? '');
      const compatible = !(dash && engine.id === VideoPlayer.ArtPlayer2) && (!drm || (drm.supported && (!drm.licenseServerUrl || this.drmAvailable()) && [VideoPlayer.Auto, VideoPlayer.ArtPlayer, VideoPlayer.Html5Player].includes(engine.id)));
      const different = engine.id === VideoPlayer.Auto ? !this.state.automaticMode() : engine.id !== this.state.engine();
      return { ...engine, available: engine.available && compatible && different,
        detail: !compatible ? 'This player cannot receive the configured DRM settings.' : !different ? 'Already selected' : engine.detail };
    });
  });
  readonly recoveryActions = computed(() => buildRecoveryActions({
    playback: this.state.recoveryBaseline() ?? this.state.playback() ?? { streamUrl: '', title: '' },
    canResolve: !!this.state.context()?.resolvePlayback,
    proxyAvailable: typeof window !== 'undefined' && window.electron?.platform !== 'web' && typeof window.electron?.prepareAutoPlayback === 'function',
    ...this.credentialAvailability(), drmAvailable: this.drmAvailable(),
    engines: this.recoveryEngines(), network: this.state.diagnostic()?.network,
    diagnosticCode: this.state.diagnostic()?.code,
  }));
  private readonly recoveryCapabilitiesEffect = effect((onCleanup) => {
    const playback = this.state.playback();
    const accountRef = playback?.recovery?.accountRef;
    this.credentialAvailability.set({ loginCookies: false, portalCredentials: false });
    this.drmAvailable.set(false);
    let current = true; onCleanup(() => { current = false; });
    if (accountRef) void window.electron?.getPlaybackRecoveryAvailability?.(accountRef)
      .then(value => { if (current) this.credentialAvailability.set(value); }).catch(() => {});
    const drm = playback?.drm;
    if (drm?.supported && drm.licenseServerUrl && typeof navigator !== 'undefined' && navigator.requestMediaKeySystemAccess) {
      void navigator.requestMediaKeySystemAccess(drm.licenseType, [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }])
        .then(() => { if (current) this.drmAvailable.set(true); }).catch(() => {});
    }
  });

  readonly selectedEngineBlockedReason = computed(() => {
    if (
      this.state.engine() === VideoPlayer.KsPlayer &&
      this.metalPlaybackFailure()
    ) {
      return this.metalPlaybackFailure();
    }

    const selectedEngine = this.engineAvailability().find(
      (engine) => engine.id === this.state.engine(),
    );
    return selectedEngine?.available === false ? selectedEngine.detail : null;
  });
  readonly isMini = computed(() => this.state.presentation() === "mini");
  readonly isYouTube = computed(() => this.state.youtube() !== null);
  readonly mediaTitle = computed(() => {
    const youtube = this.state.youtube();
    if (youtube) {
      return youtube.title || "YouTube";
    }
    const playback = this.state.playback();
    return playback?.title || playback?.streamUrl || "";
  });
  readonly automaticEngineLabelKey = computed(
    () => getPlayerEngine(this.state.engine()).labelKey,
  );
  readonly snapshot = this.state.runtimeSnapshot;
  private readonly activePlayerView = viewChild(WebPlayerViewComponent);
  readonly playbackNavigation = computed<SeriesPlaybackNavigation | null>(
    () => {
      const context = this.state.context();
      if (!context || (!context.onPrevious && !context.onNext)) {
        return null;
      }
      return {
        canPrevious: context.canPrevious === true,
        canNext: context.canNext === true,
        autoplayEnabled: context.autoplayNext === true,
      };
    },
  );
  private readonly youtubeSurfaceEffect = effect((onCleanup) => {
    this.state.youtube();
    this.state.miniPlayerCollapsed();
    this.state.miniPlayerGeometryRevision();
    const surface = this.playerSurface()?.nativeElement;
    if (!surface || !window.electron) {
      this.lastYoutubeBounds = "";
      return;
    }

    const sync = (): void => this.syncYoutubeSurface();
    const observer = new ResizeObserver(sync);
    observer.observe(surface);
    window.addEventListener("resize", sync);
    sync();

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      this.lastYoutubeBounds = "";
    });
  });
  readonly mediaSummary = computed(() => {
    const media = this.snapshot()?.media;
    if (!media) {
      return {
        resolution: "—",
        format: "—",
        codec: "—",
        hwdec: "—",
      };
    }
    return {
      resolution:
        media.width && media.height ? `${media.width}×${media.height}` : "—",
      format: formatMediaFormat(media.container),
      codec: formatCodecLabel(media.videoCodec),
      hwdec: formatHwdecLabel(media.hwdecCurrent),
    };
  });

  constructor() {
    effect(() => {
      const playback = this.state.playback();
      const youtube = this.state.youtube();
      this.state.presentation();
      this.state.miniPlayerCollapsed();
      untracked(() => {
        if (!playback && !youtube) {
          this.headerHovered.set(false);
          this.headerMenuOpen.set(false);
          this.keyboardFocus.set(false);
          this.dragging.set(false);
        }
        this.revealHeader();
      });
    });
    effect(() => {
      const canHide = this.canHideHeader();
      untracked(() => {
        if (canHide) this.headerVisibility.scheduleHide();
        else this.headerVisibility.reveal({ scheduleHide: false });
      });
    });
    effect((onCleanup) => {
      const frame = this.floatingFrame()?.nativeElement;
      if (!frame) return;
      const observer = new ResizeObserver(() => this.onFloatingGeometryChange());
      observer.observe(frame);
      window.addEventListener('resize', this.onWindowResize);
      onCleanup(() => {
        observer.disconnect();
        window.removeEventListener('resize', this.onWindowResize);
      });
    });
    this.destroyRef.onDestroy(() => {
      this.headerVisibility.dispose();
      if (this.geometryFrame !== null) cancelAnimationFrame(this.geometryFrame);
    });
    this.loadNativeEngineSupport();
    this.loadExternalEngineAvailability();
  }

  private readonly onWindowResize = () => this.onFloatingGeometryChange();

  private canHideHeader(): boolean {
    const snapshot = this.snapshot()?.state;
    const status = snapshot?.status;
    return this.isMini() && !this.collapsed() && !this.dragging() &&
      !this.headerMenuOpen() && !this.headerHovered() && !this.keyboardFocus() &&
      !this.state.recoveryBusy() && !this.state.stopped() &&
      !this.state.diagnostic() && !this.state.automaticFailure() &&
      !this.state.teardownFailure() && !this.state.recoveryFailure() &&
      !this.selectedEngineBlockedReason() && !this.state.automaticPreparing() &&
      !snapshot?.stalled &&
      (this.isYouTube() || status === 'playing');
  }

  revealHeader(): void { this.headerVisibility.reveal(); }

  onPlayerPointerDown(): void { this.keyboardFocus.set(false); this.revealHeader(); }

  onPlayerKeydown(): void { this.keyboardFocus.set(true); this.revealHeader(); }

  onPlayerFocusOut(event: FocusEvent): void {
    if (!(event.relatedTarget instanceof Node) || !this.floatingFrame()?.nativeElement.contains(event.relatedTarget)) {
      this.keyboardFocus.set(false);
    }
  }

  onDragStarted(): void { this.dragging.set(true); this.revealHeader(); }

  onDragEnded(event: CdkDragEnd): void {
    this.floatingPosition.set(event.source.getFreeDragPosition());
    this.dragging.set(false);
    this.revealHeader();
    this.onFloatingGeometryChange();
  }

  onFloatingGeometryChange(): void {
    if (this.geometryFrame !== null) return;
    this.geometryFrame = requestAnimationFrame(() => {
      this.geometryFrame = null;
      const frame = this.floatingFrame()?.nativeElement;
      if (frame && this.isMini() && !this.dragging()) {
        const position = this.floatingPosition();
        const next = clampFloatingPlayerPosition(position, frame.getBoundingClientRect(),
          { width: window.innerWidth, height: window.innerHeight });
        if (next.x !== position.x || next.y !== position.y) this.floatingPosition.set(next);
      }
      this.state.miniPlayerGeometryRevision.update(value => value + 1);
      this.syncYoutubeSurface();
    });
  }

  onTitleKeydown(event: KeyboardEvent): void {
    if (!this.isMini()) return;
    const step = event.shiftKey ? 40 : 10;
    const delta: Record<string, { x: number; y: number }> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step },
    };
    const move = delta[event.key];
    if (!move) return;
    this.onPlayerKeydown();
    event.preventDefault();
    event.stopPropagation();
    const frame = this.floatingFrame()?.nativeElement;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const position = this.floatingPosition();
    this.floatingPosition.set(clampFloatingPlayerPosition(
      { x: position.x + move.x, y: position.y + move.y },
      { left: rect.left + move.x, top: rect.top + move.y, width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    this.onFloatingGeometryChange();
  }

  isEngineActive(engine: VideoPlayer): boolean {
    if (engine === VideoPlayer.Auto) return this.state.automaticMode();
    return (
      !this.state.automaticMode() &&
      this.state.engine() === engine &&
      this.selectedEngineBlockedReason() === null
    );
  }

  async switchEngine(engine: VideoPlayer): Promise<void> {
    await this.executeRecovery({ id: 'engine', engine });
  }

  async openFallback(request: PlaybackFallbackRequest): Promise<void> {
    await this.player.openExternalPlayback(
      originalProviderPlayback(
        applyRecoveryAction(this.state.recoveryBaseline() ?? request.playback, 'retry'),
        this.state.currentPositionSeconds(),
      ),
      request.player,
    );
  }

  async restart(): Promise<void> { await this.executeRecovery({ id: 'retry' }); }

  async executeRecovery(selection: RecoverySelection): Promise<void> {
    if (!this.recoveryActions().find(action => action.id === selection.id)?.enabled || this.state.recoveryBusy()) return;
    const baseline = this.state.recoveryBaseline() ?? this.state.playback();
    if (!baseline) return;
    const engine = selection.engine ?? this.state.engine();
    if (selection.id === 'engine' && (!selection.engine || !this.recoveryEngines().find(item => item.id === selection.engine)?.available)) return;
    this.recoveryHelp.set(null);
    const automatic = this.state.automaticMode();
    const resolver = selection.id === 'fresh-link' ? this.state.context()?.resolvePlayback : undefined;
    const delayMs = selection.id === 'wait' ? Math.max(0, this.state.diagnostic()?.network?.retryAfterSeconds ?? 5) * 1000 : 0;
    await this.state.recoverPlayback(async request => {
      if (delayMs > 0) await waitForRecoveryRetry(delayMs, request.signal, seconds => this.state.recoveryCountdown.set(seconds));
      return resolver ? resolver(request) : applyRecoveryAction(baseline, selection.id);
    }, async (playback, context) => {
      this.state.activeRecoveryAction.set(selection.id);
      const forceProxy = ['login-cookies', 'portal-credentials', 'proxy', 'license-proxy'].includes(selection.id);
      if (selection.id === 'engine' && isManagedExternalPlayer(engine)) {
        await this.player.openExternalPlayback(playback, engine === VideoPlayer.VLC ? 'vlc' : 'mpv');
      } else if (playback.transport !== 'direct' && (forceProxy || engine === VideoPlayer.Auto || (selection.id !== 'engine' && automatic))) {
        await this.player.openAutomaticPlayback?.(playback, context);
      } else {
        await this.player.openInlinePlayback(playback, engine === VideoPlayer.Auto ? VideoPlayer.ArtPlayer : engine, context);
      }
    }, false, delayMs > 0 ? Infinity : 15_000);
  }

  async startOver(): Promise<void> {
    const automatic = this.state.automaticMode();
    if (!(await this.state.startOver())) return;
    const playback = this.state.playback();
    if (!playback) return;
    const original = {
      ...originalProviderPlayback(this.state.recoveryBaseline() ?? playback, 0),
      startTime: 0,
      resumePolicy: "start-over" as const,
    };
    if (automatic)
      await this.player.openAutomaticPlayback?.(
        original,
        this.state.context() ?? undefined,
      );
    else
      await this.player.openInlinePlayback(
        original,
        this.state.engine(),
        this.state.context() ?? undefined,
      );
  }

  onDiagnostic(issue: PlaybackDiagnostic | null, generation = this.state.reloadGeneration()): void {
    if (generation !== this.state.reloadGeneration() || (!issue && this.state.recoveryBusy())) return;
    if (issue?.network) issue = { ...issue, network: { ...issue.network, identity: this.state.recovery.identity, requestId: issue.network.requestId ?? crypto.randomUUID() } };
    this.state.onDiagnostic(issue);
    if (issue && !this.state.recoveryBusy()) {
      void this.player.handleAutomaticDiagnostic?.(issue).catch(error =>
        console.error('Playback recovery could not finish cleanup:', error));
    }
  }

  onTimeUpdate(event: { currentTime: number; duration: number }): void {
    this.state.onTimeUpdate(event);
  }

  onRuntimeSnapshot(
    snapshot: Parameters<WorkspacePlayerStateService["onRuntimeSnapshot"]>[0],
    generation = this.state.reloadGeneration(),
  ): void {
    if (generation !== this.state.reloadGeneration()) return;
    if (
      this.state.engine() === VideoPlayer.KsPlayer &&
      hasStartedNativeSession(snapshot.engine, "embedded-mpv") &&
      !this.metalPlaybackFailure()
    ) {
      const reason =
        snapshot.engine?.supportReason ?? "KS Player playback failed.";
      this.state.automaticReason.set(reason);
      void this.player.handleAutomaticDiagnostic?.({ code: 'media-decode-error', sourceUrl: this.state.playback()?.streamUrl, attemptToken: this.state.playback()?.playbackAttemptToken });
      return;
    }
    this.state.onRuntimeSnapshot(
      snapshot,
      generation,
      (position) =>
        this.activePlayerView()?.seekToConfirmedPosition(position) ?? false,
      this.activePlayerView()?.currentController() ?? undefined,
    );
    if (snapshot.state.status === 'error' && [VideoPlayer.EmbeddedMpv, VideoPlayer.KsPlayer].includes(this.state.engine())) {
      void this.player.handleAutomaticDiagnostic?.({ code: 'media-decode-error', sourceUrl: this.state.playback()?.streamUrl, attemptToken: this.state.playback()?.playbackAttemptToken });
    }
  }

  private getEngineAvailability(
    engine: VideoPlayer,
  ): WorkspacePlayerEngineAvailability {
    return getWorkspacePlayerEngineAvailability(
      engine,
      this.embeddedMpvSupport(),
      this.ksPlayerMetalSupport(),
      this.externalEngineAvailability(),
    );
  }

  private loadExternalEngineAvailability(): void {
    const electron =
      typeof window === "undefined" ? undefined : window.electron;
    if (typeof electron?.getPlayerEngineAvailability !== "function") {
      this.externalEngineAvailability.set([]);
      return;
    }

    void electron
      .getPlayerEngineAvailability()
      .then((availability) => this.externalEngineAvailability.set(availability))
      .catch(() => this.externalEngineAvailability.set([]));
  }

  private markExternalEngineUnavailable(
    engine: VideoPlayer,
    reason: string,
  ): void {
    this.externalEngineAvailability.update((current) => {
      const next = current ? [...current] : [];
      const existing = next.find((item) => item.engine === engine);
      if (existing) {
        existing.available = false;
        existing.reason = reason;
      } else {
        next.push({ engine, available: false, reason });
      }
      return next;
    });
  }

  private loadNativeEngineSupport(): void {
    if (typeof window === "undefined" || !window.electron) {
      this.embeddedMpvSupport.set({
        supported: false,
        reason: "Embedded MPV requires the Electron desktop app.",
      });
      this.ksPlayerMetalSupport.set({
        supported: false,
        reason: "KS Player requires the Electron desktop app.",
      });
      return;
    }

    const electron = window.electron;
    if (typeof electron.getEmbeddedMpvSupport !== "function") {
      this.embeddedMpvSupport.set({
        supported: false,
        reason: "Embedded MPV is unavailable in this build.",
      });
    } else {
      void electron
        .getEmbeddedMpvSupport()
        .then((support) => this.embeddedMpvSupport.set(support))
        .catch((error: unknown) =>
          this.embeddedMpvSupport.set({
            supported: false,
            reason: this.getErrorMessage(error),
          }),
        );
    }

    if (typeof electron.getKsPlayerMetalSupport !== "function") {
      this.ksPlayerMetalSupport.set({
        supported: false,
        reason: "KS Player is unavailable in this build.",
      });
    } else {
      void electron
        .getKsPlayerMetalSupport()
        .then((support) => this.ksPlayerMetalSupport.set(support))
        .catch((error: unknown) =>
          this.ksPlayerMetalSupport.set({
            supported: false,
            reason: this.getErrorMessage(error),
          }),
        );
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private syncYoutubeSurface(): void {
    if (!this.state.youtube() || !window.electron) {
      return;
    }

    const surface = this.playerSurface()?.nativeElement;
    if (!surface) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    const bounds: BrowserViewBounds = this.collapsed() ? { x: -100000, y: -100000, width: 1, height: 1 } : {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const key = Object.values(bounds).join(",");
    if (key === this.lastYoutubeBounds) {
      return;
    }
    this.lastYoutubeBounds = key;
    void window.electron.setBrowserViewBounds(bounds, "youtube-mini");
  }
}

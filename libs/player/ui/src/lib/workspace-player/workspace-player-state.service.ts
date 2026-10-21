import {PlaybackResourceService} from '../source-playback/playback-resource.service';
import { redactPlaybackErrorText } from "../playback-diagnostics/playback-diagnostics.util";
import type { RecoveryActionId } from "../playback-recovery/playback-recovery-actions";
import {
  PlaybackRecoveryCoordinator,
  originalProviderPlayback,
  matchRecoveryTrack,
} from "@arm-nator/player/core";
import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import type {
  AutomaticPlaybackFailure,
  PlayerOpenContext,
} from "@arm-nator/player/core";
import { PlaybackPositionService } from "@arm-nator/services";
import {
  BrowserMiniPlayerState,
  ConfirmedProgressWriter,
  InitialResumeCoordinator,
  TitlePreferenceCoordinator,
  type ViewingItem,
  viewingItemFromPlayback,
  BrowserViewState,
  ResolvedPortalPlayback,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import type { PlaybackDiagnostic } from "../playback-diagnostics/playback-diagnostics.model";
import type {
  PlayerController,
  PlayerRuntimeSnapshot,
} from "../player-controls/player-controls.model";
import {
  PlaybackTeardownRegistry,
  type PlaybackTeardown,
} from "./playback-teardown-registry";

export type WorkspacePlayerPresentation = "expanded" | "mini";

@Injectable({ providedIn: "root" })
export class WorkspacePlayerStateService {
  private readonly sourceResources=inject(PlaybackResourceService);
  withSourceCheckForeground<T>(action:()=>Promise<T>):Promise<T>{return this.sourceResources.withForeground(action);}

  private readonly playbackPositions = inject(PlaybackPositionService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly teardownRegistry = new PlaybackTeardownRegistry();
  private playbackRequestVersion = 0;
  private lastTimeUpdate: { currentTime: number; duration: number } | null =
    null;
  private progressGeneration = 0;
  private lastConfirmedAt = 0;
  private resumeGeneration = 0;
  private applyResumeSeek: ((position: number) => boolean) | undefined;
  private readonly resumeCoordinator =
    new InitialResumeCoordinator<ResolvedPortalPlayback>({
      resolve: async (playback, actualDuration) => {
        const bridge =
          typeof window === "undefined" ? undefined : window.electron;
        if (
          !playback.itemIdentity ||
          !bridge?.dbReconcileViewingItem ||
          !bridge.dbGetViewingResume
        )
          return null;
        await bridge.dbReconcileViewingItem(viewingItemFromPlayback(playback));
        return bridge.dbGetViewingResume(playback.itemIdentity, actualDuration);
      },
      seek: (position) => this.applyResumeSeek?.(position) ?? false,
      onError: (error) =>
        console.error("Viewing continuity could not be restored:", error),
    });
  private preferenceController: PlayerController | undefined;
  private unsubscribePreferences: (() => void) | undefined;
  readonly preferenceFailure = signal<string | null>(null);
  private viewingItem(playback: ResolvedPortalPlayback): ViewingItem {
    return viewingItemFromPlayback(playback);
  }
  private readonly titlePreferences =
    new TitlePreferenceCoordinator<ResolvedPortalPlayback>({
      load: async (playback) =>
        window.electron.dbGetTitlePreferences?.(this.viewingItem(playback)) ??
        null,
      save: async (playback, patch, confirmedAt) => {
        const result = await window.electron.dbSaveTitlePreferences?.(
          this.viewingItem(playback),
          patch,
          confirmedAt,
        );
        if (!result?.success)
          throw new Error("Title preferences could not be saved");
        this.preferenceFailure.set(null);
      },
      onError: (error) => {
        this.preferenceFailure.set(this.getErrorMessage(error));
        console.error(
          "Title preferences could not be applied or saved:",
          error,
        );
      },
    });
  private detachPreferences(): void {
    this.unsubscribePreferences?.();
    this.unsubscribePreferences = undefined;
    this.preferenceController = undefined;
    this.titlePreferences.begin(null);
  }
  private observePreferences(
    snapshot: PlayerRuntimeSnapshot,
    controller?: PlayerController,
  ): void {
    if (
      !controller ||
      !["playing", "paused", "ended"].includes(snapshot.state.status)
    )
      return;
    if (this.preferenceController !== controller) {
      this.unsubscribePreferences?.();
      this.preferenceController = controller;
      const generation = this.reloadGeneration();
      this.unsubscribePreferences = controller.observePreferences?.(
        (intent) => {
          if (
            generation !== this.reloadGeneration() ||
            this.preferenceController !== controller
          )
            return;
          this.titlePreferences.record(intent);
        },
      );
    }
    const capabilities = controller.capabilities();
    this.titlePreferences.observe(snapshot.state, {
      audio: capabilities.audioTracks
        ? (id) => controller.commands.setAudioTrack(id)
        : undefined,
      subtitle: capabilities.subtitles
        ? (id) => controller.commands.setSubtitleTrack(id)
        : undefined,
      settings: capabilities.subtitles
        ? (settings) => controller.commands.setSubtitleSettings(settings)
        : undefined,
    });
  }
  readonly persistenceFailure = signal<string | null>(null);
  private readonly progressWriter =
    new ConfirmedProgressWriter<ResolvedPortalPlayback>({
      save: (playback, progress) =>
        this.playbackPositions.saveViewingProgressOrThrow(playback, progress),
      onConfirmed: (_, progress) => {
        this.lastTimeUpdate = {
          currentTime: progress.positionSeconds,
          duration: progress.durationSeconds ?? 0,
        };
        this.lastConfirmedAt = progress.confirmedAt;
      },
      onSaved: (playback, progress) => {
        this.persistenceFailure.set(null);
        if (
          this.playback() === playback &&
          progress.confirmedAt === this.lastConfirmedAt
        ) {
          this.context()?.onTimeUpdate?.({
            currentTime: progress.positionSeconds,
            duration: progress.durationSeconds ?? 0,
            persistenceHandled: true,
          });
        }
      },
      onError: (error) => {
        const message = this.getErrorMessage(error);
        this.persistenceFailure.set(message);
        console.error("Confirmed playback progress could not be saved:", error);
      },
    });

  flushPlaybackProgress(): Promise<void> {
    return this.progressWriter.flush();
  }

  private beginProgressTracking(): void {
    const playback = this.playback();
    this.detachPreferences();
    this.preferenceFailure.set(null);
    this.titlePreferences.begin(
      typeof window !== "undefined" &&
        window.electron?.dbGetTitlePreferences &&
        playback?.itemIdentity &&
        !playback.isLive
        ? playback
        : null,
    );
    const canRestore =
      typeof window !== "undefined" &&
      !!window.electron?.dbGetViewingResume &&
      !!playback?.itemIdentity;
    this.resumeGeneration = this.resumeCoordinator.begin(
      canRestore ? playback : null,
      playback?.resumePolicy,
    );
    if (
      playback &&
      (playback.contentInfo || playback.itemIdentity) &&
      playback.isLive !== true
    )
      this.progressGeneration = this.progressWriter.begin(playback);
    else this.progressWriter.end();
  }

  readonly recovery = new PlaybackRecoveryCoordinator();
  readonly recoveryBusy = signal(false);
  readonly recoveryCountdown = signal<number | null>(null);
  readonly recoveryFailure = signal<string | null>(null);
  readonly recoveryBaseline = signal<ResolvedPortalPlayback | null>(null);
  readonly activeRecoveryAction = signal<RecoveryActionId>("retry");
  private recoveryCommitting = false;
  private recoveryRequestId = 0;
  private restorePaused = false;
  private readonly runtimeListeners = new Set<(snapshot: PlayerRuntimeSnapshot | null) => void>();
  subscribeRuntime(listener: (snapshot: PlayerRuntimeSnapshot | null) => void): () => void {
    this.runtimeListeners.add(listener);
    return () => this.runtimeListeners.delete(listener);
  }
  private notifyRuntime(snapshot: PlayerRuntimeSnapshot | null): void {
    for (const listener of this.runtimeListeners) listener(snapshot);
  }
  private recoveryRestore: { value: NonNullable<ResolvedPortalPlayback['recoveryState']>; until: number; base: boolean; audio: boolean; subtitle: boolean } | undefined;

  private adoptRecovery(
    playback: ResolvedPortalPlayback,
    context?: PlayerOpenContext,
  ): void {
    if (
      context?.recoveryIdentity &&
      this.recovery.isCurrent(context.recoveryIdentity)
    )
      return;
    this.recovery.beginSelection();
    this.activeRecoveryAction.set("retry");
    const baseline = originalProviderPlayback(playback);
    delete baseline.requestPolicy;
    delete baseline.transport;
    delete baseline.startPaused;
    this.recoveryBaseline.set(baseline);
    this.recoveryFailure.set(null);
  }

  cancelRecovery(): void {
    this.recovery.cancel();
    this.recoveryRequestId++;
    this.recoveryBusy.set(false);
    this.recoveryCountdown.set(null);
  }

  async recoverPlayback(
    resolve: NonNullable<PlayerOpenContext["resolvePlayback"]>,
    commit: (
      playback: ResolvedPortalPlayback,
      context: PlayerOpenContext,
    ) => Promise<void>,
    automatic = false,
    timeoutMs = 15_000,
    inlineOwner?: {
      playback: ResolvedPortalPlayback;
      context?: PlayerOpenContext;
      snapshot: () => PlayerRuntimeSnapshot | null;
    },
  ): Promise<boolean> {
    if (this.recoveryBusy()) return false;
    if (!automatic) this.recovery.beginAttempt();
    this.recoveryBusy.set(true);
    const recoveryRequestId = ++this.recoveryRequestId;
    this.recoveryFailure.set(null);
    const context = inlineOwner?.context ?? this.context();
    const current = inlineOwner?.playback ?? this.playback();
    const success = await this.recovery.run(
      resolve,
      async (resolved, identity) => {
        if (!this.recovery.isCurrent(identity)) return;
        const snapshot = inlineOwner?.snapshot() ?? this.runtimeSnapshot();
        const position = inlineOwner
          ? snapshot?.state.positionSeconds
          : this.lastTimeUpdate?.currentTime;
        const paused = snapshot?.state.status === "paused";
        const playback: ResolvedPortalPlayback = {
          ...originalProviderPlayback(resolved),
          title: resolved.title || current?.title || "",
          isLive: resolved.isLive ?? current?.isLive,
          itemIdentity: resolved.itemIdentity ?? current?.itemIdentity,
          seriesIdentity: resolved.seriesIdentity ?? current?.seriesIdentity,
          contentInfo: resolved.contentInfo ?? current?.contentInfo,
          work: resolved.work ?? current?.work,
          drm: resolved.drm ?? current?.drm,
          recovery: resolved.recovery ?? current?.recovery,
          recoveryState: snapshot ? {
            volume: snapshot.state.volume,
            playbackSpeed: snapshot.state.playbackSpeed,
            audio: snapshot.state.audioTracks.find(track => track.selected),
            subtitle: snapshot.state.subtitlesEnabled
              ? snapshot.state.subtitleTracks.find(track => track.selected)
              : 'off',
          } : current?.recoveryState,
          ...(current?.isLive !== true && position !== undefined
            ? {
                startTime: Math.max(0, position),
                resumePolicy: "start-over",
                startPaused: paused,
              }
            : {}),
        };
        if (playback.isLive) {
          delete playback.startTime;
          delete playback.startPaused;
        }
        this.recoveryCommitting = true;
        try {
          await commit(playback, { ...context, recoveryIdentity: identity });
          if (this.teardownFailure())
            throw new Error(
              "The previous playback session could not be released",
            );
        } finally {
          this.recoveryCommitting = false;
        }
      },
      automatic,
      timeoutMs,
    );
    // A superseding operation owns its own UI state.
    if (recoveryRequestId === this.recoveryRequestId) {
      this.recoveryBusy.set(false);
      this.recoveryCountdown.set(null);
      if (!success && (this.playback() === current || inlineOwner))
        this.recoveryFailure.set("PLAYBACK_RECOVERY.FAILED");
    }
    return success;
  }

  private retryInFlight = false;
  private retryController: AbortController | null = null;

  readonly playback = signal<ResolvedPortalPlayback | null>(null);
  readonly youtube = signal<BrowserMiniPlayerState | null>(null);
  readonly engine = signal<VideoPlayer>(VideoPlayer.ArtPlayer);
  readonly presentation = signal<WorkspacePlayerPresentation>("mini");
  readonly miniPlayerCollapsed = signal(false);
  readonly miniPlayerGeometryRevision = signal(0);
  readonly reloadGeneration = signal(0);
  readonly runtimeSnapshot = signal<PlayerRuntimeSnapshot | null>(null);
  readonly diagnostic = signal<PlaybackDiagnostic | null>(null);
  readonly context = signal<PlayerOpenContext | null>(null);
  readonly stopped = signal(false);
  readonly teardownFailure = signal<string | null>(null);
  readonly automaticMode = signal(false);
  readonly automaticPreparing = signal(false);
  readonly automaticReason = signal<string | null>(null);
  readonly automaticFailure = signal<PlaybackDiagnostic | null>(null);

  clearAutomaticMode(): void {
    this.automaticMode.set(false);
    this.automaticPreparing.set(false);
    this.automaticReason.set(null);
    this.automaticFailure.set(null);
  }

  currentPositionSeconds(): number | undefined {
    return this.lastTimeUpdate?.currentTime;
  }

  beginAutomaticPlayback(
    playback: ResolvedPortalPlayback,
    token: number,
    context?: PlayerOpenContext,
  ): void {
    if (!this.isPlaybackTransitionCurrent(token)) return;
    void this.progressWriter.flush();
    this.adoptRecovery(playback, context);
    this.playback.set(playback);
    this.miniPlayerCollapsed.set(false);
    this.context.set(context ?? null);
    this.lastTimeUpdate = null;
    this.automaticMode.set(true);
    this.automaticPreparing.set(true);
    this.automaticFailure.set(null);
    this.automaticReason.set(null);
    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.stopped.set(false);
    this.beginProgressTracking();
  }

  failAutomaticPlayback(
    failure: AutomaticPlaybackFailure<PlayerOpenContext>,
  ): void {
    if (
      failure.token === null ||
      !this.isPlaybackTransitionCurrent(failure.token)
    )
      return;
    this.playback.set(failure.playback);
    this.context.set(failure.context ?? null);
    this.automaticPreparing.set(false);
    const diagnostic: PlaybackDiagnostic = {
      code:
        failure.error.status === 401 || failure.error.status === 403
          ? "provider-rejected"
          : failure.error.code.startsWith("unsupported")
            ? "unsupported-container"
            : "network-error",
      source: "source",
      sourceUrl: failure.playback.streamUrl,
      container: "unknown",
      audioCodecs: [],
      videoCodecs: [],
      details: redactPlaybackErrorText(
        `${failure.error.code}${failure.error.status === null ? "" : ` (HTTP ${failure.error.status})`}: ${failure.error.message}`,
      ),
      network: { status: failure.error.status, resourceKind: "manifest" },
      externalFallbackRecommended: failure.error.status !== 401 && failure.error.status !== 403 &&
        ['unsupported-format', 'unsupported-container', 'unsupported-codec', 'media-decode-error', 'recovery-exhausted'].includes(failure.error.code),
    };
    this.automaticFailure.set(diagnostic);
    this.diagnostic.set(diagnostic);
  }

  reportAutomaticCleanupFailure(error: unknown, token: number): void {
    if (!this.isPlaybackTransitionCurrent(token)) return;
    this.automaticPreparing.set(false);
    this.teardownFailure.set(this.getErrorMessage(error));
  }

  constructor() {
    this.destroyRef.onDestroy(this.sourceResources.registerBlocker(()=>!!this.youtube()||this.automaticPreparing()||this.recoveryBusy()||!!this.playback()&&!this.stopped()));
    this.destroyRef.onDestroy(() => {
      this.cancelPendingRetry();
      this.cancelRecovery();
      this.progressWriter.end();
      this.resumeCoordinator.begin(null);
      this.detachPreferences();
    });
    if (typeof window === "undefined" || !window.electron) {
      return;
    }

    const unsubscribeFlush = window.electron.onPlaybackProgressFlush?.(
      async () => {
        await this.flushPlaybackProgress();
        return this.persistenceFailure();
      },
    );
    if (unsubscribeFlush) this.destroyRef.onDestroy(unsubscribeFlush);
    const unsubscribe = window.electron.onBrowserViewUpdate((state) =>
      this.handleBrowserViewUpdate(state),
    );
    this.destroyRef.onDestroy(unsubscribe);
  }

  registerPlaybackTeardown(
    teardown: PlaybackTeardown,
    options: { repeatable?: boolean } = {},
  ): () => void {
    return this.teardownRegistry.register(teardown, options);
  }

  async prepareForPlayback(): Promise<number | null> {
    const requestVersion = ++this.playbackRequestVersion;
    this.cancelPendingRetry();
    if (!this.recoveryCommitting) this.cancelRecovery();
    this.progressWriter.end();
    this.resumeGeneration = this.resumeCoordinator.begin(null);
    this.detachPreferences();
    try {
      const transition = await this.sourceResources.withForeground(()=>this.teardownRegistry.prepareForPlayback());
      if (transition === null || requestVersion !== this.playbackRequestVersion)
        return null;
      await this.closeYoutubePlayback(false, requestVersion);
      if (requestVersion !== this.playbackRequestVersion) return null;
      this.teardownFailure.set(null);
      return transition;
    } catch (error) {
      if (requestVersion === this.playbackRequestVersion) {
        this.teardownFailure.set(this.getErrorMessage(error));
      }
      return null;
    }
  }

  isPlaybackTransitionCurrent(transition: number): boolean {
    return this.teardownRegistry.isCurrent(transition);
  }

  async open(
    playback: ResolvedPortalPlayback,
    engine: VideoPlayer,
    context?: PlayerOpenContext,
    transition?: number,
  ): Promise<boolean> {
    const currentTransition = transition ?? (await this.prepareForPlayback());
    if (
      currentTransition === null ||
      !this.teardownRegistry.isCurrent(currentTransition)
    ) {
      return false;
    }

    const replacingPlayback = this.playback() !== null;
    if (replacingPlayback) {
      void this.progressWriter.flush();
    }
    this.adoptRecovery(playback, context);
    this.playback.set(playback);
    this.restorePaused = playback.startPaused === true;
    this.recoveryRestore = playback.recoveryState ? { value: playback.recoveryState, until: Date.now() + 5000, base: false, audio: false, subtitle: false } : undefined;
    this.miniPlayerCollapsed.set(false);
    this.engine.set(engine);
    this.context.set(context ?? null);
    this.lastTimeUpdate = null;
    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.stopped.set(false);
    if (!replacingPlayback) {
      this.presentation.set("mini");
    }
    this.beginProgressTracking();
    this.reloadGeneration.update((value) => value + 1);
    return true;
  }

  async switchEngine(engine: VideoPlayer): Promise<boolean> {
    if (engine === this.engine()) {
      return true;
    }
    const playback = this.playback();
    const resumeAt = this.lastTimeUpdate?.currentTime;
    const transition = await this.prepareForPlayback();
    if (transition === null || !this.teardownRegistry.isCurrent(transition)) {
      return false;
    }
    if (
      playback &&
      playback.isLive !== true &&
      typeof resumeAt === "number" &&
      Number.isFinite(resumeAt)
    ) {
      this.playback.set({ ...playback, startTime: Math.max(0, resumeAt) });
    }
    this.engine.set(engine);
    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.stopped.set(false);
    this.beginProgressTracking();
    this.reloadGeneration.update((value) => value + 1);
    return true;
  }

  async restart(): Promise<void> {
    const playback = this.playback();
    if (!playback || this.retryInFlight) {
      return;
    }

    const transition = await this.prepareForPlayback();
    if (transition === null || !this.isPlaybackTransitionCurrent(transition)) {
      return;
    }

    const onRetry = this.context()?.onRetry;
    if (onRetry) {
      const controller = new AbortController();
      this.retryController = controller;
      this.retryInFlight = true;
      void Promise.resolve()
        .then(() =>
          this.isPlaybackTransitionCurrent(transition)
            ? onRetry(controller.signal)
            : undefined,
        )
        .catch(() => undefined)
        .finally(() => {
          if (this.retryController === controller) {
            this.retryController = null;
            this.retryInFlight = false;
          }
        });
      return;
    }

    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.stopped.set(false);
    this.beginProgressTracking();
    this.reloadGeneration.update((value) => value + 1);
  }

  async stop(): Promise<void> {
    this.activeRecoveryAction.set("retry");
    const transition = await this.prepareForPlayback();
    if (transition === null || !this.isPlaybackTransitionCurrent(transition)) {
      return;
    }
    if (this.playback()) {
      this.automaticPreparing.set(false);
      this.stopped.set(true);
      this.notifyRuntime(null);
    }
  }

  readonly viewingActionPending = signal(false);

  async markFinished(): Promise<void> {
    await this.applyViewingAction("finished");
  }
  async startOver(): Promise<boolean> {
    return this.applyViewingAction("reset");
  }

  private async applyViewingAction(
    action: "finished" | "reset",
  ): Promise<boolean> {
    const playback = this.playback();
    if (
      !playback ||
      playback.isLive ||
      (!playback.itemIdentity && !playback.contentInfo) ||
      this.viewingActionPending()
    )
      return false;
    this.viewingActionPending.set(true);
    const position = this.lastTimeUpdate;
    const context = this.context();
    try {
      const transition = await this.prepareForPlayback();
      if (transition === null || !this.isPlaybackTransitionCurrent(transition))
        return false;
      this.stopped.set(true);
      this.automaticPreparing.set(false);
      await this.flushPlaybackProgress();
      const confirmedAt = Math.max(Date.now(), this.lastConfirmedAt + 1);
      try {
        await this.playbackPositions.saveViewingProgressOrThrow(playback, {
          action,
          confirmedAt,
          positionSeconds:
            action === "reset" ? 0 : (position?.currentTime ?? 0),
          durationSeconds:
            position && position.duration > 0 ? position.duration : undefined,
        });
        this.persistenceFailure.set(null);
        if (
          this.isPlaybackTransitionCurrent(transition) &&
          this.playback() === playback
        )
          context?.onTimeUpdate?.({
            currentTime:
              action === "reset"
                ? 0
                : (position?.duration ?? position?.currentTime ?? 0),
            duration: position?.duration ?? 0,
            persistenceHandled: true,
            action,
          });
      } catch (error) {
        this.persistenceFailure.set(this.getErrorMessage(error));
        console.error("Viewing action could not be saved:", error);
      }
      if (
        !this.isPlaybackTransitionCurrent(transition) ||
        this.playback() !== playback
      )
        return false;
      if (action === "reset") {
        this.playback.set({
          ...playback,
          startTime: 0,
          resumePolicy: "start-over",
        });
        this.lastTimeUpdate = null;
        this.runtimeSnapshot.set(null);
        this.diagnostic.set(null);
        // The host re-resolves the original stream before starting a fresh engine.
      }
      return true;
    } finally {
      this.viewingActionPending.set(false);
    }
  }

  minimize(): void {
    if (this.playback() || this.youtube()) {
      this.miniPlayerCollapsed.set(false);
      this.presentation.set("mini");
    }
  }

  expand(): void {
    if (this.playback() || this.youtube()) {
      this.miniPlayerCollapsed.set(false);
      this.presentation.set("expanded");
    }
  }

  collapseToBar(): void {
    if (this.playback() || this.youtube()) {
      this.presentation.set('mini');
      this.miniPlayerCollapsed.set(true);
    }
  }

  restoreMiniPlayer(): void {
    this.miniPlayerCollapsed.set(false);
    this.presentation.set('mini');
  }

  async close(): Promise<void> {
    const wasYoutube = this.youtube() !== null;
    const transition = await this.prepareForPlayback();
    if (transition === null || !this.isPlaybackTransitionCurrent(transition)) {
      return;
    }
    if (wasYoutube && this.router.url.includes("/workspace/youtube")) {
      void this.router.navigateByUrl("/workspace/dashboard");
    }

    this.closePlaybackState();
  }

  closeAfterPlaybackTransition(transition: number): boolean {
    if (!this.isPlaybackTransitionCurrent(transition)) {
      return false;
    }
    this.closePlaybackState();
    return true;
  }

  private closePlaybackState(): void {
    this.miniPlayerCollapsed.set(false);
    this.cancelRecovery();
    this.recoveryBaseline.set(null);
    this.activeRecoveryAction.set("retry");
    const onClosed = this.context()?.onClosed;
    this.progressWriter.end();
    this.playback.set(null);
    this.notifyRuntime(null);
    this.context.set(null);
    this.lastTimeUpdate = null;
    this.runtimeSnapshot.set(null);
    this.diagnostic.set(null);
    this.stopped.set(false);
    this.clearAutomaticMode();
    onClosed?.();
  }

  onRuntimeSnapshot(
    snapshot: PlayerRuntimeSnapshot,
    generation = this.reloadGeneration(),
    seek?: (position: number) => boolean,
    controller?: PlayerController,
  ): void {
    if (generation !== this.reloadGeneration() || this.stopped()) return;
    this.runtimeSnapshot.set(snapshot);
    this.notifyRuntime(snapshot);
    this.recovery.observe(
      snapshot.state.positionSeconds,
      snapshot.state.stalled ? "loading" : snapshot.state.status,
      snapshot.state.seeking,
    );
    if (
      this.restorePaused &&
      controller &&
      ["playing", "paused"].includes(snapshot.state.status)
    ) {
      this.restorePaused = false;
      if (snapshot.state.status === "playing") controller.commands.togglePlay();
    }
    this.observePreferences(snapshot, controller);
    this.restoreRecoveryControls(snapshot, controller);
    if (
      !snapshot.state.seeking &&
      ["playing", "paused", "ended"].includes(snapshot.state.status) &&
      Number.isFinite(snapshot.state.positionSeconds) &&
      snapshot.state.positionSeconds >= 0
    ) {
      // Direct play has no catalogue identity, but still needs a confirmed clock for engine handoff.
      this.lastTimeUpdate = {
        currentTime: snapshot.state.positionSeconds,
        duration: snapshot.state.durationSeconds ?? 0,
      };
    }
    this.applyResumeSeek = seek;
    if (
      !this.resumeCoordinator.accept(this.resumeGeneration, {
        positionSeconds: snapshot.state.positionSeconds,
        durationSeconds: snapshot.state.durationSeconds,
        status: snapshot.state.status,
        seeking: snapshot.state.seeking,
      })
    )
      return;
    this.progressWriter.observe(this.progressGeneration, {
      positionSeconds: snapshot.state.positionSeconds,
      durationSeconds: snapshot.state.durationSeconds,
      status: snapshot.state.status,
      seeking: snapshot.state.seeking,
    });
  }

  private restoreRecoveryControls(snapshot: PlayerRuntimeSnapshot, controller?: PlayerController): void {
    const restore = this.recoveryRestore;
    if (!restore || !controller || !['playing', 'paused'].includes(snapshot.state.status)) return;
    if (!restore.base) {
      restore.base = true;
      if (controller.capabilities().volume) controller.commands.setVolume(restore.value.volume);
      if (controller.capabilities().playbackSpeed) controller.commands.setPlaybackSpeed(restore.value.playbackSpeed);
    }
    for (const kind of ['audio', 'subtitle'] as const) {
      if (restore[kind]) continue;
      const target = restore.value[kind];
      if (!target || target === 'off') {
        restore[kind] = true;
        if (kind === 'subtitle' && target === 'off' && controller.capabilities().subtitles) controller.commands.setSubtitleTrack(-1);
        continue;
      }
      const tracks = kind === 'audio' ? snapshot.state.audioTracks : snapshot.state.subtitleTracks;
      const id = matchRecoveryTrack(target, tracks);
      if (id !== null) {
        restore[kind] = true;
        if (kind === 'audio') controller.commands.setAudioTrack(id);
        else controller.commands.setSubtitleTrack(id);
      } else if (Date.now() >= restore.until) {
        restore[kind] = true;
        this.preferenceFailure.set(`The selected ${kind} track is unavailable in this player; using its default.`);
      }
    }
    if (restore.audio && restore.subtitle) this.recoveryRestore = undefined;
  }

  onDiagnostic(diagnostic: PlaybackDiagnostic | null): void {
    if (diagnostic?.network) this.recovery.noteFailure(diagnostic.network);
    this.diagnostic.set(diagnostic);
  }

  // Runtime snapshots carry pause/seek/status confirmation; raw timeupdate is
  // also fired while seeking and must never become saved history.
  onTimeUpdate(event: { currentTime: number; duration: number }): void {
    void event; // Only confirmed runtime snapshots may enter history.
  }

  onEnded(): void {
    const context = this.context();
    context?.onEnded?.();
    if (context?.autoplayNext && context.canNext) {
      context.onNext?.();
    }
  }

  previous(): void {
    if (this.context()?.canPrevious) {
      this.context()?.onPrevious?.();
    }
  }

  next(): void {
    if (this.context()?.canNext) {
      this.context()?.onNext?.();
    }
  }

  private handleBrowserViewUpdate(state: BrowserViewState): void {
    if (state.status === "closed" && this.youtube()) {
      this.youtube.set(null);
      this.presentation.set("mini");
      if (this.router.url.includes("/workspace/youtube")) {
        void this.router.navigateByUrl("/workspace/dashboard");
      }
      return;
    }

    if (state.miniPlayer) {
      void this.replaceWithYoutube(state);
      return;
    }

    if (!this.youtube() || state.mode !== "youtube") {
      return;
    }

    this.youtube.set(null);
    this.presentation.set("mini");
    if (!this.router.url.includes("/workspace/youtube")) {
      void this.router.navigateByUrl("/workspace/youtube");
    }
  }

  private async closeYoutubePlayback(
    navigate = false,
    requestVersion = this.playbackRequestVersion,
  ): Promise<void> {
    const youtubeToClose = this.youtube();
    if (!youtubeToClose) return;

    await window.electron?.closeBrowserView("youtube", true);
    if (
      requestVersion !== this.playbackRequestVersion ||
      this.youtube() !== youtubeToClose
    )
      return;
    this.youtube.set(null);
    this.presentation.set("mini");
    if (navigate && this.router.url.includes("/workspace/youtube")) {
      void this.router.navigateByUrl("/workspace/dashboard");
    }
  }

  private async replaceWithYoutube(state: BrowserViewState): Promise<void> {
    const requestVersion = ++this.playbackRequestVersion;
    const oldYoutube = this.youtube();
    this.cancelPendingRetry();
    let transition: number | null;
    try {
      transition = await this.sourceResources.withForeground(()=>this.teardownRegistry.prepareForPlayback());
    } catch (error) {
      if (requestVersion !== this.playbackRequestVersion) return;
      this.teardownFailure.set(this.getErrorMessage(error));
      try {
        await window.electron?.closeBrowserView("youtube", true);
      } catch {
        return;
      }
      if (
        requestVersion === this.playbackRequestVersion &&
        this.youtube() === oldYoutube
      ) {
        this.youtube.set(null);
        this.presentation.set("mini");
      }
      return;
    }
    if (transition === null || requestVersion !== this.playbackRequestVersion)
      return;

    const alreadyInYoutubePlayer = this.youtube() !== null;
    if (this.playback()) {
      void this.progressWriter.flush();
      this.context()?.onClosed?.();
      this.playback.set(null);
      this.context.set(null);
      this.lastTimeUpdate = null;
      this.runtimeSnapshot.set(null);
      this.diagnostic.set(null);
      this.stopped.set(false);
    }

    this.clearAutomaticMode();
    this.youtube.set(state.miniPlayer ?? null);
    this.miniPlayerCollapsed.set(false);
    if (!alreadyInYoutubePlayer) {
      this.presentation.set("mini");
    }
  }

  private cancelPendingRetry(): void {
    this.retryController?.abort();
    this.retryController = null;
    this.retryInFlight = false;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

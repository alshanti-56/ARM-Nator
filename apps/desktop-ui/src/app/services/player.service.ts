import { Injectable, inject, DestroyRef } from "@angular/core";
import { MatDialog } from "@angular/material/dialog";
import { ExternalPlayerInfoDialogComponent } from "@arm-nator/player/ui/external-player-info-dialog";
import { WorkspacePlayerStateService } from "@arm-nator/player/ui";
import { DataService } from "@arm-nator/services";
import {
  ExternalPlayerSession,
  OPEN_MPV_PLAYER,
  OPEN_VLC_PLAYER,
  PlayerContentInfo,
  ResolvedPortalPlayback,
  resolveDefaultVideoPlayer,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";
import type { ExternalPlayerName } from "@arm-nator/shared/interfaces";
import {
  AutomaticPlaybackController,
  queryAutomaticNativeSupport,
  originalProviderPlayback,
  isInlinePlayer,
  PlayerFacade,
  type PlayerOpenContext,
  browserPlaybackPreparation,
  PlaybackEnginePreferences,
  MediaCompanionClient,
  mediaCompanionCredentials,
} from "@arm-nator/player/core";
import { SettingsStore } from "./settings-store.service";

@Injectable({
  providedIn: "root",
})
export class PlayerService implements PlayerFacade {
  private dialog = inject(MatDialog);
  private dataService = inject(DataService);
  private settingsStore = inject(SettingsStore);
  private workspacePlayer = inject(WorkspacePlayerStateService);

  private readonly destroyRef = inject(DestroyRef);
  private readonly enginePreferences = new PlaybackEnginePreferences<VideoPlayer>({
    getItem: key => { try { return window.localStorage?.getItem(key) ?? null; } catch { return null; } },
    setItem: (key, value) => { try { window.localStorage?.setItem(key, value); } catch { /* Storage is optional. */ } },
    removeItem: key => { try { window.localStorage?.removeItem(key); } catch { /* Storage is optional. */ } },
  });
  private preferenceScope(playback: ResolvedPortalPlayback, media: {format: string; container?: string; videoCodecs?: readonly string[]; audioCodecs?: readonly string[]}) {
    return {
      sourceIdentity: playback.itemIdentity?.playlistId ?? playback.contentInfo?.playlistId ?? playback.recovery?.accountRef ?? playback.originalStreamUrl ?? playback.streamUrl,
      live: playback.isLive === true,
      media: JSON.stringify([media.format, media.container, media.videoCodecs, media.audioCodecs]),
      runtime: typeof navigator === 'undefined' ? 'test' : navigator.userAgent,
    };
  }

  private readonly companionSessions = new Map<string, { client: MediaCompanionClient; id: string }>();
  private readonly companionPreparations = new Map<string, { abort: AbortController; client: MediaCompanionClient }>();
  private companionClient(): MediaCompanionClient | null {
    const options = this.settingsStore.getSettings().mediaCompanion;
    const paired = mediaCompanionCredentials.get();
    if (!options?.enabled || !paired || paired.baseUrl.replace(/\/+$/, '') !== options.baseUrl.replace(/\/+$/, '')) return null;
    return new MediaCompanionClient(paired);
  }
  private browserPlayback(): boolean {
    return !window.electron?.prepareAutoPlayback || window.electron?.platform === 'web';
  }

  private selectionStartedAt = 0;
  private recordReliabilityEvent(reason: string, engine = this.workspacePlayer.engine()): void {
    void window.electron?.recordAutomaticPlaybackDecision?.({
      sourceUrl: this.automatic.originalPlayback?.streamUrl ?? '',
      engine, reason,
    }).catch(() => undefined);
  }

  private readonly automatic = new AutomaticPlaybackController<PlayerOpenContext>({
    prepareForPlayback: () => this.workspacePlayer.prepareForPlayback(),
    isPlaybackTransitionCurrent: token => this.workspacePlayer.isPlaybackTransitionCurrent(token),
    registerTeardown: dispose => this.workspacePlayer.registerPlaybackTeardown(dispose),
    companionAvailable: () => this.browserPlayback() && this.companionClient() !== null,
    conversionAllowed: () => this.settingsStore.getSettings().mediaCompanion?.allowConversion === true,
    getBrowserCodecs: media => {
      if (typeof document === 'undefined') return {};
      const video = document.createElement('video');
      const codecs: Record<string, boolean> = {};
      for (const codec of [...media.videoCodecs ?? [], ...media.audioCodecs ?? []]) {
        const mime = /^(vp0?[89]|av01|opus|vorbis)/i.test(codec) ? 'video/webm' : 'video/mp4';
        codecs[codec] = !!video.canPlayType(`${mime}; codecs="${codec}"`);
      }
      return codecs;
    },
    prepare: async (url, headers, isLive, attemptId, policy, options) => {
      const prepare = window.electron?.prepareAutoPlayback;
      if (!prepare || window.electron?.platform === "web") {
        const mode = options?.processingMode ?? 'direct';
        if (mode === 'direct') return { ok: true as const, session: browserPlaybackPreparation(url) };
        const client = this.companionClient();
        if (!client) return { ok: false as const, error: { code: 'resource-error', status: null, message: 'Configure and pair the optional media companion to use this recovery.' } };
        const abort = new AbortController();
        this.companionPreparations.set(attemptId, {abort, client});
        try {
          const session = await client.prepare({ url, headers, isLive, mode, startTime: mode === 'proxy' ? undefined : options?.startTime,
            audioOnly: mode === 'convert' ? true : undefined,
            allowConversion: this.settingsStore.getSettings().mediaCompanion?.allowConversion === true,
          }, abort.signal);
          const id = session.id;
          this.companionSessions.set(id, {client, id: session.id});
          return { ok: true as const, session };
        } catch {
          return { ok: false as const, error: { code: 'resource-error', status: null, message: 'The media companion could not prepare this stream. Check pairing, provider allowlist, and processing support.' } };
        } finally { if (!abort.signal.aborted) this.companionPreparations.delete(attemptId); }
      }
      return prepare(url, headers, isLive, attemptId, policy);
    },
    cancel: async attemptId => {
      const pending = this.companionPreparations.get(attemptId);
      if (pending) {
        pending.abort.abort();
        await pending.client.drainPending();
        if (this.companionPreparations.get(attemptId) === pending) this.companionPreparations.delete(attemptId);
      }
      const cancel = window.electron?.cancelAutoPlaybackPreparation;
      if (!cancel || window.electron?.platform === "web") return;
      await cancel(attemptId);
    },
    release: async sessionId => {
      const companion = this.companionSessions.get(sessionId);
      if (companion) {
        await companion.client.release(companion.id);
        this.companionSessions.delete(sessionId);
        return;
      }
      const release = window.electron?.releaseAutoPlaybackSession;
      if (!release || sessionId.startsWith("direct:") || window.electron?.platform === "web") return;
      await release(sessionId);
    },
    getNativeSupport: async () => ({ ...await queryAutomaticNativeSupport({
      embeddedMpv: !this.browserPlayback() && window.electron?.getEmbeddedMpvSupport ? () => window.electron.getEmbeddedMpvSupport() : undefined,
      ksPlayer: !this.browserPlayback() && window.electron?.getKsPlayerMetalSupport ? () => window.electron.getKsPlayerMetalSupport() : undefined,
    }), nativeHls: typeof document !== 'undefined' && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl') }),
    getRememberedEngine: (playback, media) => this.enginePreferences.getCompatible(this.preferenceScope(playback, media)) ?? undefined,
    rememberEngine: (playback, media, engine) => {
      this.enginePreferences.rememberVerifiedSuccess(this.preferenceScope(playback, media), engine, true);
      this.recordReliabilityEvent(`Confirmed playback progress after ${Math.max(0, Date.now() - this.selectionStartedAt)} ms; mode ${media.processingMode ?? 'proxy'}.`, engine);
    },
    invalidateEngine: (playback, media) => { this.enginePreferences.invalidateOnFailure(this.preferenceScope(playback, media), 'decoder'); },
    canRenew: (playback, context) => !!context?.resolvePlayback && playback.recovery?.providerLinkRenewable !== false,
    renewPlayback: (_playback, context, signal) => context!.resolvePlayback!({ signal, reason: 'media-auth-failure' }),
    snapshotPlayback: playback => {
      const snapshot = this.workspacePlayer.runtimeSnapshot();
      return { ...playback, startTime: playback.isLive ? undefined : this.workspacePlayer.currentPositionSeconds() ?? playback.startTime,
        startPaused: snapshot?.state.status === 'paused', resumePolicy: 'start-over',
        recoveryState: snapshot ? {
          volume: snapshot.state.volume, playbackSpeed: snapshot.state.playbackSpeed,
          audio: snapshot.state.audioTracks.find(track => track.selected),
          subtitle: snapshot.state.subtitlesEnabled ? snapshot.state.subtitleTracks.find(track => track.selected) : 'off',
        } : playback.recoveryState };
    },
    onRecovery: reason => { this.workspacePlayer.automaticReason.set(reason); this.recordReliabilityEvent(reason); },
    onPreparing: (playback, token, context) => this.workspacePlayer.beginAutomaticPlayback(playback, token, context),
    startPlayback: async (playback, engine, context, token) => {
      if (await this.workspacePlayer.open(playback, engine, context, token)) {
        this.workspacePlayer.automaticPreparing.set(false);
      }
    },
    showFailure: failure => {
      this.workspacePlayer.failAutomaticPlayback(failure);
      this.recordReliabilityEvent(`Playback stopped: ${failure.error.code}; status ${failure.error.status ?? 'unknown'}.`);
    },
    onCleanupFailure: (error, token) => this.workspacePlayer.reportAutomaticCleanupFailure(error, token),
    onDecision: decision => {
      this.workspacePlayer.automaticReason.set(decision.reason);
      const active = this.automatic.activePlayback;
      void window.electron?.recordAutomaticPlaybackDecision?.({
        sourceUrl: active?.originalUrl ?? this.automatic.originalPlayback?.streamUrl ?? "",
        sessionId: active?.preparedPlayback.preparedProxy?.id,
        engine: decision.engine, reason: decision.reason,
      }).catch(() => undefined);
    },
  });

  constructor() {
    const poll = setInterval(() => { void this.automatic.poll().catch(() => undefined); }, 500);
    (poll as unknown as { unref?: () => void }).unref?.();
    this.destroyRef.onDestroy(() => { clearInterval(poll); this.automatic.invalidate(); });
    const unsubscribe = this.workspacePlayer.subscribeRuntime(snapshot => {
      const playback = this.workspacePlayer.playback();
      if (!playback || this.workspacePlayer.stopped()) { this.automatic.invalidate(); return; }
      if (!snapshot) return;
      this.automatic.observeProgress({
        mediaTimeSeconds: snapshot.state.positionSeconds,
        presentedFrames: snapshot.media?.presentedFrames, frameReady: snapshot.media?.frameReady,
        audioOnly: snapshot.media?.audioOnly, paused: snapshot.state.status === 'paused',
        seeking: snapshot.state.seeking, ended: snapshot.state.status === 'ended',
      }, playback.streamUrl);
    });
    this.destroyRef.onDestroy(unsubscribe);
  }

  async openAutomaticPlayback(playback: ResolvedPortalPlayback, context?: PlayerOpenContext): Promise<void> {
    const original = originalProviderPlayback(playback);
    this.selectionStartedAt = Date.now();
    try {
      await this.automatic.open(original, context);
    } catch (error) {
      // A cleanup rejection remains registered for retry. Do not start another transport.
      console.error("Automatic playback could not finish cleanup:", error);
    }
  }

  handleAutomaticDiagnostic(issue: { attemptToken?: number; code: string; sourceUrl?: string; network?: {status: number | null; retryAfterSeconds?: number} }): Promise<boolean> {
    return this.automatic.handleDiagnostic({ ...issue, status: issue.network?.status, retryAfterMs: issue.network?.retryAfterSeconds === undefined ? undefined : issue.network.retryAfterSeconds * 1000, positionSeconds: this.workspacePlayer.currentPositionSeconds() }).catch(error => {
      console.error("Automatic decoder fallback could not finish cleanup:", error);
      return false;
    });
  }

  isEmbeddedPlayer(isLive = false): boolean {
    return isInlinePlayer(this.getDefaultPlayer(isLive));
  }

  openPlayer(
    streamUrl: string,
    title: string,
    thumbnail?: string | null,
    hideExternalInfoDialog = true,
    isLiveContent = false,
    userAgent?: string,
    referer?: string,
    origin?: string,
    contentInfo?: unknown,
    startTime?: number,
    headers?: Record<string, string>,
  ): Promise<ExternalPlayerSession | void> {
    return this.openResolvedPlayback(
      {
        streamUrl,
        title,
        thumbnail,
        isLive: isLiveContent,
        startTime,
        contentInfo: contentInfo as PlayerContentInfo | undefined,
        headers,
        userAgent,
        referer,
        origin,
      },
      hideExternalInfoDialog,
    );
  }

  async openResolvedPlayback(
    playback: ResolvedPortalPlayback,
    hideExternalInfoDialog = true,
    context?: PlayerOpenContext,
  ): Promise<ExternalPlayerSession | void> {
    const player = this.workspacePlayer.automaticMode() ? VideoPlayer.Auto : this.getDefaultPlayer(playback.isLive === true);

    if (player === VideoPlayer.Auto) {
      await this.openAutomaticPlayback(playback, context);
      return;
    }

    if (player === VideoPlayer.MPV) {
      if (!hideExternalInfoDialog) {
        this.dialog.open(ExternalPlayerInfoDialogComponent);
      }
      return await this.openExternalPlayback(playback, "mpv");
    } else if (player === VideoPlayer.VLC) {
      if (!hideExternalInfoDialog) {
        this.dialog.open(ExternalPlayerInfoDialogComponent);
      }
      return await this.openExternalPlayback(playback, "vlc");
    }

    await this.openInlinePlayback(playback, player, context);
    return;
  }

  openInlinePlayback(
    playback: ResolvedPortalPlayback,
    engine = this.getDefaultPlayer(playback.isLive === true),
    context?: PlayerOpenContext,
    transition?: number,
  ): Promise<void> {
    if (engine === VideoPlayer.Auto) return this.openAutomaticPlayback(playback, context);
    this.selectionStartedAt = Date.now();
    return this.automatic.open(originalProviderPlayback(playback), context, engine)
      .then(() => {
        // Manual selection still uses managed preparation/recovery. Keep its
        // terminal diagnostic when preparation fails before a driver mounts.
        this.workspacePlayer.automaticMode.set(false);
      });
  }

  async openExternalPlayback(
    playback: ResolvedPortalPlayback,
    player: ExternalPlayerName,
    transition?: number,
  ): Promise<ExternalPlayerSession | void> {
    this.automatic.invalidate();
    playback = originalProviderPlayback(playback);
    const currentTransition =
      transition ?? (await this.workspacePlayer.prepareForPlayback());
    if (
      currentTransition === null ||
      !this.workspacePlayer.isPlaybackTransitionCurrent(currentTransition)
    ) {
      return;
    }

    const ipcEvent = player === "mpv" ? OPEN_MPV_PLAYER : OPEN_VLC_PLAYER;
    let closed = false;
    let closePromise: Promise<void> | null = null;
    const teardown = async (): Promise<void> => {
      if (closed) {
        return;
      }
      if (closePromise) {
        return closePromise;
      }

      const close = async (): Promise<void> => {
        const session = await launchPromise.catch(() => undefined);
        if (!session?.id || session.status === "closed") {
          closed = true;
          return;
        }
        const closeSession = window.electron?.closeExternalPlayerSession;
        if (!closeSession) {
          throw new Error("External player teardown IPC is unavailable.");
        }
        const result = await closeSession(session.id);
        if (result?.status !== "closed") {
          throw new Error("External player did not acknowledge session closure.");
        }
        closed = true;
      };

      const pending = close().catch((error: unknown) => {
        closePromise = null;
        throw error;
      });
      closePromise = pending;
      return pending;
    };
    const unregisterTeardown = this.workspacePlayer.registerPlaybackTeardown(
      teardown,
    );

    const launchPromise = Promise.resolve().then(() =>
      this.dataService.sendIpcEvent<ExternalPlayerSession>(ipcEvent, {
        url: playback.streamUrl,
        title: playback.title,
        thumbnail: playback.thumbnail,
        "user-agent": playback.userAgent,
        referer: playback.referer,
        origin: playback.origin,
        headers: playback.headers,
        contentInfo: playback.contentInfo,
        startTime: playback.startTime,
        subtitleUrl: playback.subtitleUrl,
      }),
    );
    let session: ExternalPlayerSession;
    try {
      session = await launchPromise;
    } catch (error) {
      unregisterTeardown();
      throw error;
    }
    if (
      closed ||
      !this.workspacePlayer.isPlaybackTransitionCurrent(currentTransition)
    ) {
      await teardown();
      return;
    }
    if (!session?.id) {
      unregisterTeardown();
      return session;
    }

    this.workspacePlayer.closeAfterPlaybackTransition(currentTransition);
    return session;
  }

  private getDefaultPlayer(isLive: boolean): VideoPlayer {
    const player = resolveDefaultVideoPlayer(this.settingsStore.getSettings(), isLive);
    return player;
  }
}

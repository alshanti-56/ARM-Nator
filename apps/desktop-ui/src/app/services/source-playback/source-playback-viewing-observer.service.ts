import { DestroyRef, Injectable, inject } from "@angular/core";
import {
  SourcePlaybackRepositoryService,
  SourcePlaybackStoreService,
} from "@arm-nator/services";
import { WorkspacePlayerStateService } from "@arm-nator/player/ui";
import type {
  SourceEvidenceWrite,
  ResolvedPortalPlayback,
  SourcePlaybackReason,
} from "@arm-nator/shared/interfaces";
import type { AutomaticPlaybackError } from "@arm-nator/player/core";
import {
  SourceViewingSession,
  sourceViewingIdentity,
} from "./source-viewing-session";
@Injectable({ providedIn: "root" })
export class SourcePlaybackViewingObserverService {
  private readonly player = inject(WorkspacePlayerStateService);
  private readonly repository = inject(SourcePlaybackRepositoryService);
  private readonly store = inject(SourcePlaybackStoreService);
  private pendingSelection: {
    playback: ResolvedPortalPlayback;
    error?: AutomaticPlaybackError;
  } | null = null;
  private sequence = 0;
  private selection: {
    playback: ResolvedPortalPlayback;
    session: SourceViewingSession;
    terminalGeneration?: number;
  } | null = null;
  private writes = Promise.resolve();
  private stop: (() => void) | null = null;
  private get available() {
    return (
      typeof window !== "undefined" &&
      window.electron?.platform !== "web" &&
      typeof window.electron?.dbSaveSourcePlaybackEvidence === "function"
    );
  }
  beginSelection(playback: ResolvedPortalPlayback, recovering = false): void {
    if (
      recovering &&
      this.selection &&
      this.sameItem(this.selection.playback, playback)
    )
      return;
    const sequence = ++this.sequence;
    this.selection = null;
    this.pendingSelection = { playback };
    const identity = sourceViewingIdentity(playback);
    if (!identity || !this.available) return;
    const startedAt = Date.now(),
      id = crypto.randomUUID();
    void this.repository
      .read([identity.sourceId])
      .then((snapshots) => {
        if (sequence !== this.sequence) return;
        const revision = snapshots[0]?.revision;
        if (!revision) return;
        this.selection = {
          playback,
          session: new SourceViewingSession({
            id,
            key: {
              sourceId: identity.sourceId,
              revision,
              category: identity.category,
            },
            itemId: identity.itemId,
            title: playback.title,
            startedAt,
          }),
        };
        const pending = this.pendingSelection;
        this.pendingSelection = null;
        if (pending?.error) this.terminal(playback, pending.error);
      })
      .catch(() =>
        this.store.persistenceFailure.set(
          "Playback evidence could not be loaded. Try again.",
        ),
      );
  }
  stopSelection(): void {
    this.sequence++;
    this.selection = null;
    this.pendingSelection = null;
  }
  private sameItem(
    a: ResolvedPortalPlayback,
    b: ResolvedPortalPlayback,
  ): boolean {
    const one = sourceViewingIdentity(a),
      two = sourceViewingIdentity(b);
    return (
      !!one &&
      !!two &&
      one.sourceId === two.sourceId &&
      one.category === two.category &&
      one.itemId === two.itemId
    );
  }
  terminal(
    playback: ResolvedPortalPlayback,
    error: AutomaticPlaybackError,
  ): void {
    const current = this.selection;
    if (!current) {
      if (
        this.pendingSelection &&
        this.sameItem(this.pendingSelection.playback, playback)
      )
        this.pendingSelection.error = error;
      return;
    }
    if (!this.sameItem(current.playback, playback)) return;
    const reason: SourcePlaybackReason =
      error.status === 401 || error.status === 403
        ? "provider-rejected"
        : error.status === 404 || error.status === 410
          ? "item-unavailable"
          : error.code.startsWith("unsupported")
            ? "unsupported-media"
            : error.code === "recovery-exhausted"
              ? "stalled"
              : error.status === 429
                ? "provider-throttled"
                : "network-unknown";
    const conclusive =
      reason === "provider-rejected" ||
      reason === "item-unavailable" ||
      reason === "stalled";
    current.terminalGeneration = this.player.reloadGeneration();
    const write = current.session.terminal(
      reason,
      conclusive,
      this.player.engine(),
      Date.now(),
    );
    if (write) this.save(write, current.session);
  }
  start(): () => void {
    if (this.stop) return this.stop;
    if (!this.available) return () => undefined;
    const unsubscribe = this.player.subscribeRuntime((snapshot) => {
      const current = this.selection;
      if (!current) return;
      if (!snapshot || this.player.stopped()) {
        current.session.resetWindow();
        return;
      }
      const playback = this.player.playback();
      if (!playback || !this.sameItem(current.playback, playback)) return;
      if (
        current.session.finished &&
        current.terminalGeneration !== this.player.reloadGeneration()
      ) {
        this.beginSelection(playback);
        return;
      }
      const generation = String(this.player.reloadGeneration());
      const write = current.session.observe(
        {
          generation,
          atMs: Date.now(),
          positionSeconds: snapshot.state.positionSeconds,
          playing: snapshot.state.status === "playing",
          stalled: snapshot.state.stalled,
          seeking: snapshot.state.seeking === true,
          presentedFrames: snapshot.media?.presentedFrames,
          frameReady: snapshot.media?.frameReady,
          audioOnly: snapshot.media?.audioOnly,
          audioReady: snapshot.media?.audioReady,
        },
        generation,
        snapshot.engine?.engine ?? this.player.engine(),
      );
      if (write) this.save(write, current.session);
    });
    this.stop = () => {
      unsubscribe();
      this.stopSelection();
      this.stop = null;
    };
    return this.stop;
  }
  private save(
    write: SourceEvidenceWrite,
    session: SourceViewingSession,
  ): void {
    this.writes = this.writes.then(async () => {
      try {
        if ((await this.repository.write(write)) === "saved")
          await this.store.refreshSaved([
            ...new Set([
              ...this.store.snapshots().keys(),
              write.attempt.key.sourceId,
            ]),
          ]);
      } catch {
        session.retryQualification();
        this.store.persistenceFailure.set(
          "Playback evidence could not be saved. Try again.",
        );
      }
    });
  }
  drain(): Promise<void> {
    return this.writes;
  }
  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }
}

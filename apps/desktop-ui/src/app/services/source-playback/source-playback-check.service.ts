import { DestroyRef, Injectable, effect, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
import {
  SOURCE_PLAYBACK_POLICY as P,
  getPlaylistSourceType,
  sourceEvidenceKey,
  type SourceEvidenceKey,
  type SourcePlaybackSampler,
} from "@arm-nator/shared/interfaces";
import {
  SourcePlaybackRepositoryService,
  SourcePlaybackStoreService,
  PlaylistsService,
  type SourcePlaybackActivity,
  type SourcePlaybackFacade,
} from "@arm-nator/services";
import {
  PlaybackResourceService,
  SourcePlaybackProbeService,
} from "@arm-nator/player/ui";
import { XtreamSourcePlaybackSamplerService } from "@arm-nator/providers/xtream/data-access";
import { SourcePlaybackOwnershipService } from "./source-playback-ownership.service";
import { runPersistedSourceCheck } from "./source-playback-check-runner";
@Injectable({ providedIn: "root" })
export class SourcePlaybackCheckService implements SourcePlaybackFacade {
  readonly available = signal(
    typeof window !== "undefined" &&
      window.electron?.platform !== "web" &&
      typeof window.electron?.dbSaveSourcePlaybackEvidence === "function",
  );
  readonly activity = signal<SourcePlaybackActivity>({ state: "idle" });
  private readonly repository = inject(SourcePlaybackRepositoryService);
  private readonly store = inject(SourcePlaybackStoreService);
  private readonly resources = inject(PlaybackResourceService);
  private readonly probe = inject(SourcePlaybackProbeService);
  private readonly xtream = inject(XtreamSourcePlaybackSamplerService);
  private readonly playlists = inject(PlaylistsService);
  private readonly queue = new Map<string, SourceEvidenceKey>();
  private readonly queueChanged = signal(0);
  private running = false;
  private active: AbortController | null = null;
  constructor() {
    const destroy = inject(DestroyRef);
    destroy.onDestroy(inject(SourcePlaybackOwnershipService).start());
    destroy.onDestroy(() => {
      this.active?.abort();
      this.queue.clear();
    });
    effect(() => {
      this.queueChanged();
      if (!this.available() || this.resources.isBlocked() || this.running)
        return;
      const next = this.queue.values().next().value;
      if (next) {
        this.queue.delete(sourceEvidenceKey(next));
        void this.runCheck(next, "manual", new AbortController().signal).catch(
          () => undefined,
        );
      }
    });
  }
  requestCheck(key: SourceEvidenceKey): Promise<void> {
    if (!this.available()) return Promise.resolve();
    if (
      this.activity().state === "checking" &&
      this.activity().key &&
      sourceEvidenceKey(this.activity().key!) === sourceEvidenceKey(key)
    )
      return Promise.resolve();
    this.queue.set(sourceEvidenceKey(key), key);
    this.activity.set({
      state: this.resources.isBlocked() ? "deferred" : "queued",
      key,
    });
    this.queueChanged.update((v) => v + 1);
    return Promise.resolve();
  }
  supportedCategories(
    _sourceType: string,
  ): readonly ("live" | "movies" | "series")[] {
    return ["live"];
  }
  async runCheck(
    key: SourceEvidenceKey,
    origin: "manual" | "background",
    parent: AbortSignal,
  ): Promise<void> {
    if (this.running || !this.available()) return;
    this.running = true;
    const abort = new AbortController();
    this.active = abort;
    let acknowledge!: () => void, deny!: (reason: unknown) => void;
    const drained = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      deny = reject;
    });
    void drained.catch(() => undefined);
    const lease = this.resources.tryAcquireBackground(() => {
      abort.abort();
      return drained;
    });
    if (!lease) {
      this.running = false;
      this.active = null;
      this.activity.set({ state: "deferred", key });
      return;
    }
    const signal = AbortSignal.any([parent, abort.signal, lease.signal]);
    this.activity.set({ state: "checking", key });
    try {
      const source = await firstValueFrom(
        this.playlists.getPlaylistById(key.sourceId),
      );
      signal.throwIfAborted();
      const sourceType = source ? getPlaylistSourceType(source) : null;
      const sampler: SourcePlaybackSampler | null =
        sourceType === "xtream" && key.category === "live" ? this.xtream : null;
      if (!sampler) {
        const now = Date.now();
        await this.repository.write({
          attempt: {
            checkId: crypto.randomUUID(),
            key,
            origin,
            startedAt: now,
            completedAt: now,
            samples: [],
            reason: "unsupported-category",
          },
        });
      } else
        await runPersistedSourceCheck(
          key,
          origin,
          signal,
          {
            select: (s) => sampler.select(key.sourceId, key.category, s),
            resolve: (candidate, s) =>
              sampler.resolve(key.sourceId, candidate, s),
            probe: (playback, s) => this.probe.probe(playback, s),
            drain: () => this.probe.drain(),
          },
          this.repository,
        );
      await this.store.refreshSaved([
        ...new Set([...this.store.snapshots().keys(), key.sourceId]),
      ]);
    } catch (error) {
      if (!signal.aborted) {
        this.store.persistenceFailure.set(
          "Playback evidence could not be saved. Try again.",
        );
        this.activity.set({ state: "deferred", key, reason: "save-failed" });
      }
    } finally {
      try {
        await this.probe.drain();
        acknowledge();
        await lease.release();
        if (this.activity().state === "checking")
          this.activity.set({ state: "idle" });
      } catch (error) {
        deny(error);
        this.activity.set({
          state: "teardown-pending",
          key,
          reason: "teardown-pending",
        });
      }
      this.active = null;
      this.running = false;
      this.queueChanged.update((v) => v + 1);
    }
  }
  cancelSource(sourceId: string): void {
    for (const [id, key] of this.queue)
      if (key.sourceId === sourceId) this.queue.delete(id);
    if (this.activity().key?.sourceId === sourceId) this.active?.abort();
  }
}

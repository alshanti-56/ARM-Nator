import {
  SourcePlaybackAccountService,
  sourceAccountAtCapacity,
} from "./source-playback-account.service";
import { DestroyRef, Injectable, effect, inject, signal } from "@angular/core";
import { firstValueFrom } from "rxjs";
import {
  SOURCE_PLAYBACK_POLICY as P,
  getPlaylistSourceType,
  sourceEvidenceKey,
  type SourceEvidenceKey,
  type SourcePlaybackSampler,
  type PlaylistMeta,
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
import { SourceCheckQueue } from "./source-check-queue";
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
  private readonly account = inject(SourcePlaybackAccountService);
  private readonly xtream = inject(XtreamSourcePlaybackSamplerService);
  private readonly playlists = inject(PlaylistsService);
  private readonly queue = new SourceCheckQueue();
  private readonly providers = new Map<string, string>();
  private activeDone: Promise<void> = Promise.resolve();
  private activeKey: SourceEvidenceKey | null = null;
  private manualTimer: ReturnType<typeof setTimeout> | undefined;
  readonly busyVersion = signal(0);
  get busySourceIds() {
    this.busyVersion();
    return this.queue.busy;
  }
  setSources(sources: readonly PlaylistMeta[]) {
    this.providers.clear();
    for (const s of sources) {
      try {
        const url = new URL(s.serverUrl || s.portalUrl || s.url || "");
        this.providers.set(
          s._id,
          url.origin + url.pathname.replace(/\/+$/, ""),
        );
      } catch {
        this.providers.set(s._id, s._id);
      }
    }
  }
  providerDue(): Map<string, number> {
    const byProvider = new Map<string, number>();
    for (const s of this.store.snapshots().values()) {
      const until = Math.max(
        0,
        ...Object.entries(s.nextEligibleAt)
          .filter(
            ([category]) =>
              (s.inconclusiveCounts[category as "live" | "movies" | "series"] ??
                0) > 0,
          )
          .map(([, at]) => at ?? 0),
      );
      const provider = this.providers.get(s.sourceId) ?? s.sourceId;
      byProvider.set(provider, Math.max(byProvider.get(provider) ?? 0, until));
    }
    return new Map(
      [...this.providers].map(([id, p]) => [id, byProvider.get(p) ?? 0]),
    );
  }
  async beginSourceOperation(sourceId: string): Promise<() => void> {
    this.queue.beginOperation(sourceId);
    this.busyVersion.update((v) => v + 1);
    this.cancelSource(sourceId);
    try {
      if (this.activeKey?.sourceId === sourceId) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.activeDone,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error("Source check cleanup is still pending")),
                P.cleanupMs,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      this.queue.endOperation(sourceId);
      this.busyVersion.update((v) => v + 1);
      throw error;
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.queue.endOperation(sourceId);
      this.busyVersion.update((v) => v + 1);
      this.queueChanged.update((v) => v + 1);
    };
  }
  retainKeys(keys: readonly SourceEvidenceKey[]) {
    this.queue.retain(keys);
    if (
      this.activeKey &&
      !keys.some(
        (k) => sourceEvidenceKey(k) === sourceEvidenceKey(this.activeKey!),
      )
    )
      this.active?.abort();
  }
  private readonly queueChanged = signal(0);
  private running = false;
  private active: AbortController | null = null;
  constructor() {
    const destroy = inject(DestroyRef);
    destroy.onDestroy(inject(SourcePlaybackOwnershipService).start());
    destroy.onDestroy(() => {
      this.active?.abort();
      clearTimeout(this.manualTimer);
    });
    effect(() => {
      this.queueChanged();
      if (!this.available() || this.resources.isBlocked() || this.running)
        return;
      const due = this.providerDue();
      const next = this.queue.take(this.busySourceIds, due, Date.now());
      clearTimeout(this.manualTimer);
      if (this.queue.size) {
        const upcoming = [...due.values()].filter((at) => at > Date.now());
        if (upcoming.length)
          this.manualTimer = setTimeout(
            () => this.queueChanged.update((v) => v + 1),
            Math.min(
              2147483647,
              Math.max(1, Math.min(...upcoming) - Date.now()),
            ),
          );
      }
      if (next) {
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
    this.queue.request(key);
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
    return _sourceType === "xtream" ? ["live", "movies", "series"] : [];
  }
  async runCheck(
    key: SourceEvidenceKey,
    origin: "manual" | "background",
    parent: AbortSignal,
  ): Promise<void> {
    if (
      this.running ||
      !this.available() ||
      this.busySourceIds.has(key.sourceId) ||
      (this.providerDue().get(key.sourceId) ?? 0) > Date.now()
    )
      return;
    this.running = true;
    const abort = new AbortController();
    this.active = abort;
    let acknowledge!: () => void, deny!: (reason: unknown) => void;
    const drained = new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      deny = reject;
    });
    void drained.catch(() => undefined);
    this.activeDone = drained;
    this.activeKey = key;
    const lease = this.resources.tryAcquireBackground(() => {
      abort.abort();
      return drained;
    });
    if (!lease) {
      acknowledge();
      this.activeKey = null;
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
        sourceType === "xtream" ? this.xtream : null;
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
            prepare: async (s) =>
              sourceAccountAtCapacity(
                await this.account.read(key.sourceId, key.revision, s),
              )
                ? "provider-busy"
                : null,
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
      this.activeKey = null;
      this.running = false;
      this.queueChanged.update((v) => v + 1);
    }
  }
  cancelSource(sourceId: string): void {
    this.queue.cancel(sourceId);
    if (this.activeKey?.sourceId === sourceId) this.active?.abort();
  }
}

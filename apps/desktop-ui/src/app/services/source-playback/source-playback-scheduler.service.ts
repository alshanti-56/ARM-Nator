import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { Store } from "@ngrx/store";
import { selectAllPlaylistsMeta } from "@arm-nator/providers/shared/playlist-state";
import { PlaybackResourceService } from "@arm-nator/player/ui";
import { nextSourceCheck } from "@arm-nator/player/core";
import { SourcePlaybackStoreService } from "@arm-nator/services";
import {
  SOURCE_PLAYBACK_POLICY as P,
  getPlaylistSourceType,
  sourceEvidenceKey,
  type SourceEvidenceKey,
} from "@arm-nator/shared/interfaces";
import { SourcePlaybackCheckService } from "./source-playback-check.service";
@Injectable({ providedIn: "root" })
export class SourcePlaybackSchedulerService {
  private readonly checks = inject(SourcePlaybackCheckService);
  private readonly evidence = inject(SourcePlaybackStoreService);
  private readonly resources = inject(PlaybackResourceService);
  private readonly sources = inject(Store).selectSignal(selectAllPlaylistsMeta);
  private readonly wake = signal(0);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleSince: number | null = null;
  private last: string | null = null;
  private stop: (() => void) | null = null;
  start(): () => void {
    if (this.stop) return this.stop;
    if (!this.checks.available()) return () => undefined;
    const sourceEffect = effect(() => {
      const sources = this.sources();
      this.checks.setSources(sources);
      untracked(() => void this.evidence.load(sources.map((s) => s._id)));
    });
    const runEffect = effect(() => {
      this.wake();
      clearTimeout(this.timer);
      const sources = this.sources(),
        snapshots = this.evidence.snapshots();
      const activity = this.checks.activity();
      const busy = this.checks.busySourceIds;
      const keys: SourceEvidenceKey[] = sources.flatMap((source) => {
        const saved = snapshots.get(source._id);
        return saved
          ? this.checks
              .supportedCategories(getPlaylistSourceType(source))
              .map((category) => ({
                sourceId: source._id,
                revision: saved.revision,
                category,
              }))
          : [];
      });
      untracked(() => this.checks.retainKeys(keys));
      if (
        activity.state === "checking" ||
        activity.state === "teardown-pending"
      )
        return;
      if (this.resources.isBlocked()) {
        this.idleSince = null;
        return;
      }
      const now = Date.now();
      this.idleSince ??= now;
      const providerDue = this.checks.providerDue();
      const due = new Map(
        keys.map((key) => [
          sourceEvidenceKey(key),
          Math.max(
            snapshots.get(key.sourceId)?.nextEligibleAt[key.category] ?? 0,
            providerDue.get(key.sourceId) ?? 0,
          ),
        ]),
      );
      const next = nextSourceCheck(
        {
          keys,
          supported: ["live", "movies", "series"],
          due,
          busySourceIds: busy,
          occupied: false,
          idleSince: this.idleSince,
          lastServedKey: this.last,
        },
        now,
      );
      if (next) {
        this.last = sourceEvidenceKey(next);
        untracked(
          () =>
            void this.checks.runCheck(
              next,
              "background",
              new AbortController().signal,
            ),
        );
        return;
      }
      const eligible = keys.filter((k) => !busy.has(k.sourceId));
      if (!eligible.length) return;
      const nextAt = Math.max(
        this.idleSince + P.idleMs,
        Math.min(...eligible.map((k) => due.get(sourceEvidenceKey(k)) ?? 0)),
      );
      this.timer = setTimeout(
        () => this.wake.update((v) => v + 1),
        Math.min(2147483647, Math.max(1, nextAt - now)),
      );
    });
    const operations = new Map<string, () => void>();
    const unsubscribe = window.electron?.onDbOperationEvent?.((event) => {
      if (!event.playlistId) return;
      const id = event.operationId ?? `${event.operation}:${event.playlistId}`;
      if (event.status === "started" && !operations.has(id)) {
        operations.set(id, () => undefined);
        void this.checks
          .beginSourceOperation(event.playlistId)
          .then((release) => {
            if (operations.has(id)) operations.set(id, release);
            else release();
          });
      } else if (["completed", "error", "cancelled"].includes(event.status)) {
        operations.get(id)?.();
        operations.delete(id);
        this.wake.update((v) => v + 1);
        void this.evidence.load(this.sources().map((s) => s._id));
      }
    });
    this.stop = () => {
      sourceEffect.destroy();
      runEffect.destroy();
      clearTimeout(this.timer);
      unsubscribe?.();
      for (const release of operations.values()) release();
      this.stop = null;
    };
    return this.stop;
  }
  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop?.());
  }
}

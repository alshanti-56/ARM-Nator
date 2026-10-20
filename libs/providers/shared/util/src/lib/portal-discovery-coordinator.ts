import { catalogueIdentityKey } from "@arm-nator/shared/interfaces";
import type {
  DiscoveryVersion,
  PortalSearchContinuation,
  PortalSearchPage,
  PortalSearchSourceStatus,
} from "@arm-nator/shared/interfaces";
export interface DiscoveryPortal {
  playlistId: string;
  providerName: string;
}
export interface PortalDiscoverySnapshot {
  versions: DiscoveryVersion[];
  statuses: PortalSearchSourceStatus[];
}
export type PortalPageLoader = (
  source: DiscoveryPortal,
  query: string,
  page: PortalSearchContinuation,
  signal: AbortSignal,
) => Promise<PortalSearchPage>;
interface QueuedPortal {
  epoch: number;
  source: DiscoveryPortal;
  pages: PortalSearchContinuation[];
  resolve: () => void;
}

/** Explicit jobs only: typing cancels a run, and never implicitly submits one. */
export class PortalDiscoveryCoordinator {
  private epoch = 0;
  private query = "";
  private active = 0;
  private queue: QueuedPortal[] = [];
  private controllers = new Set<AbortController>();
  private versions = new Map<string, DiscoveryVersion>();
  private statuses = new Map<string, PortalSearchSourceStatus>();
  private sources = new Map<string, DiscoveryPortal>();
  constructor(
    private readonly load: PortalPageLoader,
    private readonly changed: () => void,
    private readonly deadlineMs = 10_000,
  ) {}
  get snapshot(): PortalDiscoverySnapshot {
    return {
      versions: [...this.versions.values()],
      statuses: [...this.statuses.values()].map((s) => ({
        ...s,
        continuation: [...s.continuation],
      })),
    };
  }
  cancel(clear = true): void {
    ++this.epoch;
    for (const controller of this.controllers) controller.abort();
    for (const queued of this.queue) queued.resolve();
    this.queue = [];
    if (clear) {
      this.versions.clear();
      this.statuses.clear();
      this.sources.clear();
    } else
      for (const status of this.statuses.values())
        if (status.state === "searching" || status.state === "idle")
          status.state = "cancelled";
    this.changed();
  }
  async search(
    sources: readonly DiscoveryPortal[],
    query: string,
    types: readonly ("movie" | "series" | "live")[],
  ): Promise<void> {
    this.cancel();
    this.query = query.trim();
    if (!this.query || !types.length) return;
    const unique = [...new Map(sources.map((s) => [s.playlistId, s])).values()];
    const jobs = unique.map((source) => {
      this.sources.set(source.playlistId, source);
      const pages = [...new Set(types)].map((contentType) => ({
        contentType,
        page: 1,
      }));
      this.statuses.set(source.playlistId, {
        ...source,
        state: "idle",
        resultCount: 0,
        continuation: pages,
      });
      return this.enqueue(source, pages);
    });
    this.changed();
    await Promise.all(jobs);
  }
  async continue(playlistId: string): Promise<void> {
    const status = this.statuses.get(playlistId),
      source = this.sources.get(playlistId);
    if (
      !source ||
      !status?.continuation.length ||
      status.state === "searching" ||
      status.state === "idle"
    )
      return;
    await this.enqueue(source, [...status.continuation]);
  }
  private enqueue(
    source: DiscoveryPortal,
    pages: PortalSearchContinuation[],
  ): Promise<void> {
    return new Promise((resolve) => {
      const status = this.statuses.get(source.playlistId);
      if (status) status.state = "idle";
      this.queue.push({ epoch: this.epoch, source, pages, resolve });
      this.pump();
    });
  }
  private pump(): void {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.epoch !== this.epoch) {
        job.resolve();
        continue;
      }
      ++this.active;
      void this.run(job).finally(() => {
        --this.active;
        job.resolve();
        this.pump();
      });
    }
  }
  private async run(job: QueuedPortal): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const status = this.statuses.get(job.source.playlistId)!;
    const current = () =>
      job.epoch === this.epoch && !controller.signal.aborted;
    let timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      controller.abort();
    }, this.deadlineMs);
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(
          new Error(
            timeout
              ? "Portal search exceeded its 10 second deadline"
              : "Portal search cancelled",
          ),
        );
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    status.state = "searching";
    this.changed();
    const continuations: PortalSearchContinuation[] = [];
    try {
      for (let index = 0; index < job.pages.length; index++) {
        const page = job.pages[index];
        status.continuation = [...continuations, ...job.pages.slice(index)];
        const result = await Promise.race([
          this.load(job.source, this.query, page, controller.signal),
          aborted,
        ]);
        if (!current()) return;
        const incoming = new Map<string, DiscoveryVersion>();
        for (const version of result.versions) {
          if (version.identity.sourceType !== 'stalker' || version.identity.playlistId !== job.source.playlistId) throw new Error('Portal returned a mismatched source identity');
          const key = catalogueIdentityKey(version.identity);
          if (!this.versions.has(key)) incoming.set(key, version);
        }
        if (this.versions.size + incoming.size > 5000) throw new Error('Search result limit reached; refine the query to load more');
        if (page.page > 1 && result.versions.length > 0 && incoming.size === 0) throw new Error('Portal returned a repeated page; previous results retained');
        for (const [key, version] of incoming) this.versions.set(key, version);
        if (result.continuation) continuations.push(result.continuation);
        status.resultCount = [...this.versions.values()].filter(
          (v) => v.identity.playlistId === job.source.playlistId,
        ).length;
        status.continuation = [...continuations, ...job.pages.slice(index + 1)];
        this.changed();
      }
      status.state = continuations.length ? "partial" : "complete";
      status.error = undefined;
    } catch (error) {
      if (job.epoch !== this.epoch) return;
      status.state = "error";
      status.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", rejectAbort);
      this.controllers.delete(controller);
      if (job.epoch === this.epoch) this.changed();
    }
  }
}

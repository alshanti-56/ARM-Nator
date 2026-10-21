import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import {
  DatabaseService,
  PlaylistsService,
  SourcePlaybackRepositoryService,
} from "@arm-nator/services";
import {
  buildXtreamSavedPlaybackHeaders,
  XtreamUrlService,
} from "./services/xtream-url.service";
import {
  XtreamApiService,
  type XtreamCredentials,
  type XtreamRequestOptions,
} from "./services/xtream-api.service";
import type {
  Playlist,
  SourcePlaybackCandidate,
  SourcePlaybackCategory,
  SourcePlaybackSampler,
  ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
@Injectable({ providedIn: "root" })
export class XtreamSourcePlaybackSamplerService implements SourcePlaybackSampler {
  private readonly db = inject(DatabaseService);
  private readonly playlists = inject(PlaylistsService);
  private readonly api = inject(XtreamApiService);
  private readonly urls = inject(XtreamUrlService);
  private readonly repository = inject(SourcePlaybackRepositoryService);
  private async source(id: string): Promise<Playlist> {
    const source = await firstValueFrom(this.playlists.getPlaylistById(id));
    if (!source?.serverUrl || !source.username || !source.password)
      throw Error("Source credentials are unavailable");
    return source;
  }
  private credentials(source: Playlist): XtreamCredentials {
    return {
      serverUrl: source.serverUrl ?? "",
      username: source.username ?? "",
      password: source.password ?? "",
    };
  }
  async select(
    sourceId: string,
    category: SourcePlaybackCategory,
    signal: AbortSignal,
  ): Promise<readonly SourcePlaybackCandidate[]> {
    signal.throwIfAborted();
    if (category !== "live") return [];
    const saved = (await this.repository.read([sourceId]))[0];
    const preferred = saved?.latest
      .find((o) => o.key.category === category)
      ?.samples.find((s) => s.outcome === "played")?.itemId;
    const cached = await this.db.getSourcePlaybackCandidates({
      sourceId,
      category,
      limit: 3,
      cursor: saved?.cursor[category],
      preferredItemId: preferred,
    });
    signal.throwIfAborted();
    if (cached.length) return cached;
    const source = await this.source(sourceId);
    const credentials = this.credentials(source);
    return this.request(signal, async (options) => {
      const known = await this.db.hasXtreamCategories(sourceId, category);
      const groups = known
        ? (await this.db.getXtreamCategories(sourceId, category))
            .filter((c) => !c.hidden)
            .map((c) => ({
              category_id: String(c.xtream_id),
              category_name: c.name,
            }))
        : await this.api.getCategories(credentials, category, options);
      signal.throwIfAborted();
      const items: SourcePlaybackCandidate[] = [];
      for (const group of groups
        .filter(
          (g) => !(source.hiddenGroupTitles ?? []).includes(g.category_name),
        )
        .slice(0, 3)) {
        signal.throwIfAborted();
        const rows = await this.api.getLiveStreams(credentials, {
          ...options,
          categoryId: String(group.category_id),
        });
        signal.throwIfAborted();
        for (const row of rows) {
          if (
            row.stream_id == null ||
            items.some((i) => i.itemId === String(row.stream_id))
          )
            continue;
          items.push({
            itemId: String(row.stream_id),
            title: row.name || "Sample channel",
            category,
            categoryId: String(group.category_id),
            cursor: String(row.stream_id),
          });
          if (items.length >= 3) return items;
        }
      }
      return items;
    });
  }
  async resolve(
    sourceId: string,
    candidate: SourcePlaybackCandidate,
    signal: AbortSignal,
  ): Promise<ResolvedPortalPlayback> {
    signal.throwIfAborted();
    const source = await this.source(sourceId);
    signal.throwIfAborted();
    const credentials = this.credentials(source),
      url = this.urls.constructLiveUrl(credentials, Number(candidate.itemId));
    if (!url) throw Error("Sample link is unavailable");
    const headers = buildXtreamSavedPlaybackHeaders(source);
    return {
      streamUrl: url,
      title: candidate.title,
      isLive: true,
      headers,
      userAgent: source.userAgent,
      referer: source.referrer,
      origin: source.origin,
      requestPolicy: { accountRef: sourceId, portalCredentials: true },
    };
  }
  private async request<T>(
    signal: AbortSignal,
    operation: (options: XtreamRequestOptions) => Promise<T>,
  ): Promise<T> {
    const sessionId = `source-samples-${crypto.randomUUID()}`;
    let cancellation: Promise<boolean> | null = null;
    const abort = () => {
      cancellation ??= this.api.cancelSession(sessionId);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const result = await operation({
        sessionId,
        requestId: crypto.randomUUID(),
        requireArray: true,
        suppressErrorLog: true,
      });
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      if (cancellation) await cancellation;
    }
  }
}

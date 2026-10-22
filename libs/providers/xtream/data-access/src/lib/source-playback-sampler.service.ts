import {
  readSourceSampleCursor,
  sourceSampleCursor,
  rotateSourceRows,
} from "@arm-nator/shared/interfaces";
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
  XtreamSerieEpisode,
} from "@arm-nator/shared/interfaces";
@Injectable({ providedIn: "root" })
export class XtreamSourcePlaybackSamplerService implements SourcePlaybackSampler {
  selectionCursor: string | undefined;
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
    this.selectionCursor = undefined;
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
    if (cached.length)
      return category === "series"
        ? this.episodeCandidates(sourceId, cached, signal)
        : cached;
    const source = await this.source(sourceId);
    const credentials = this.credentials(source);
    const selected = await this.request(signal, async (options) => {
      const known = await this.db.hasXtreamCategories(sourceId, category);
      const groups = known
        ? (await this.db.getXtreamCategories(sourceId, category))
            .filter((c) => !c.hidden)
            .map((c) => ({
              category_id: String(c.xtream_id),
              category_name: c.name,
            }))
        : await this.api.getCategories(
            credentials,
            category === "movies" ? "vod" : category,
            options,
          );
      signal.throwIfAborted();
      const items: SourcePlaybackCandidate[] = [];
      const cursor = readSourceSampleCursor(saved?.cursor[category]);
      const visible = groups.filter(
        (g) => !(source.hiddenGroupTitles ?? []).includes(g.category_name),
      );
      const ordered = rotateSourceRows(
        visible,
        (g) => String(g.category_id),
        cursor?.group,
        true,
      );
      for (const [index, group] of ordered.slice(0, 3).entries()) {
        this.selectionCursor = sourceSampleCursor(
          String(ordered[(index + 1) % ordered.length].category_id),
          1,
          "",
        );
        signal.throwIfAborted();
        const filtered = { ...options, categoryId: String(group.category_id) };
        const rows =
          category === "live"
            ? await this.api.getLiveStreams(credentials, filtered)
            : category === "movies"
              ? await this.api.getVodStreams(credentials, filtered)
              : await this.api.getSeriesStreams(credentials, filtered);
        signal.throwIfAborted();
        const idOf = (row: (typeof rows)[number]) =>
          String("series_id" in row ? row.series_id : row.stream_id);
        const current =
          cursor?.group === String(group.category_id) ? cursor.item : undefined;
        const preferredHere =
          preferred && rows.some((r) => idOf(r) === preferred)
            ? preferred
            : undefined;
        if (
          !preferredHere &&
          ordered.length > 1 &&
          current &&
          idOf(rows[rows.length - 1] ?? ({} as (typeof rows)[number])) ===
            current
        )
          continue;
        for (const row of rotateSourceRows(
          rows,
          idOf,
          preferredHere ?? current,
          !!preferredHere,
        )) {
          const id = "series_id" in row ? row.series_id : row.stream_id;
          if (id == null || items.some((i) => i.itemId === String(id)))
            continue;
          items.push({
            itemId: String(id),
            title: row.name || "Sample channel",
            category,
            categoryId: String(group.category_id),
            cursor: sourceSampleCursor(
              String(group.category_id),
              1,
              String(id),
            ),
          });
          if (items.length >= 3) return items;
        }
      }
      return items;
    });
    return category === "series"
      ? this.episodeCandidates(sourceId, selected, signal)
      : selected;
  }
  async resolve(
    sourceId: string,
    candidate: SourcePlaybackCandidate,
    signal: AbortSignal,
  ): Promise<ResolvedPortalPlayback> {
    signal.throwIfAborted();
    const source = await this.source(sourceId);
    signal.throwIfAborted();
    await this.assertEligible(sourceId, candidate, source, signal);
    const credentials = this.credentials(source);
    let url = "";
    if (candidate.category === "live")
      url = this.urls.constructLiveUrl(credentials, Number(candidate.itemId));
    else if (candidate.category === "movies") {
      const details = await this.request(signal, (o) =>
        this.api.getVodInfo(credentials, candidate.itemId, o),
      );
      if (details.movie_data?.container_extension)
        url = this.urls.constructVodUrl(credentials, details);
    } else {
      const details = await this.request(signal, (o) =>
        this.api.getSeriesInfo(credentials, candidate.itemId, o),
      );
      const episode = Object.values(details?.episodes ?? {})
        .flat()
        .find((e) => String(e.id) === candidate.episodeId);
      if (!episode)
        throw Object.assign(Error("Sample episode is unavailable"), {
          status: 404,
        });
      if (episode.container_extension)
        url = this.urls.constructEpisodeUrl(credentials, episode);
    }
    signal.throwIfAborted();
    if (!url)
      throw Object.assign(Error("Sample media format is unavailable"), {
        reason: "unsupported-media",
      });
    const headers = buildXtreamSavedPlaybackHeaders(source);
    return {
      streamUrl: url,
      title: candidate.title,
      isLive: candidate.category === "live",
      headers,
      userAgent: source.userAgent,
      referer: source.referrer,
      origin: source.origin,
      requestPolicy: { accountRef: sourceId, portalCredentials: true },
    };
  }
  private async assertEligible(
    sourceId: string,
    candidate: SourcePlaybackCandidate,
    source: Playlist,
    signal: AbortSignal,
  ): Promise<void> {
    const known = await this.db.hasXtreamCategories(
      sourceId,
      candidate.category,
    );
    const groups = known
      ? (await this.db.getXtreamCategories(sourceId, candidate.category))
          .filter((c) => !c.hidden)
          .map((c) => ({
            category_id: String(c.xtream_id),
            category_name: c.name,
          }))
      : await this.request(signal, (o) =>
          this.api.getCategories(
            this.credentials(source),
            candidate.category === "movies" ? "vod" : candidate.category,
            o,
          ),
        );
    signal.throwIfAborted();
    const group = groups.find(
      (g) => String(g.category_id) === candidate.categoryId,
    );
    if (
      !group ||
      (source.hiddenGroupTitles ?? []).includes(group.category_name)
    )
      throw Object.assign(Error("Sample category is unavailable"), {
        status: 404,
      });
  }
  private async episodeCandidates(
    sourceId: string,
    candidates: readonly SourcePlaybackCandidate[],
    signal: AbortSignal,
  ): Promise<readonly SourcePlaybackCandidate[]> {
    const source = await this.source(sourceId);
    const credentials = this.credentials(source);
    const selected: SourcePlaybackCandidate[] = [];
    await this.request(signal, async (options) => {
      for (const candidate of candidates.slice(0, 3)) {
        signal.throwIfAborted();
        const details = await this.api.getSeriesInfo(
          credentials,
          candidate.itemId,
          options,
        );
        signal.throwIfAborted();
        const episode = Object.values(details?.episodes ?? {})
          .flat()
          .filter(
            (e): e is XtreamSerieEpisode => !!e?.id && !!e.container_extension,
          )
          .sort(
            (a, b) =>
              Number(a.season) - Number(b.season) ||
              Number(a.episode_num) - Number(b.episode_num),
          )[0];
        if (episode)
          selected.push({
            ...candidate,
            episodeId: String(episode.id),
            title: episode.title || candidate.title,
          });
      }
    });
    return selected;
  }
  private request<T>(
    signal: AbortSignal,
    operation: (options: XtreamRequestOptions) => Promise<T>,
  ): Promise<T> {
    return xtreamSourceRequest(this.api, signal, operation);
  }
}
export async function xtreamSourceRequest<T>(
  api: XtreamApiService,
  signal: AbortSignal,
  operation: (options: XtreamRequestOptions) => Promise<T>,
): Promise<T> {
  const sessionId = `source-samples-${crypto.randomUUID()}`;
  let cancellation: Promise<boolean> | null = null;
  const abort = () => {
    cancellation ??= api.cancelSession(sessionId);
    void cancellation.catch(() => undefined);
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

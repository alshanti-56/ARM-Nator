import {
  readSourceSampleCursor,
  sourceSampleCursor,
  rotateSourceRows,
} from "@arm-nator/shared/interfaces";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";
import {
  PlaylistsService,
  SourcePlaybackRepositoryService,
} from "@arm-nator/services";
import type {
  SourcePlaybackSampler,
  SourcePlaybackCandidate,
  SourcePlaybackCategory,
  ResolvedPortalPlayback,
  PlaylistMeta,
} from "@arm-nator/shared/interfaces";
import {
  StalkerSourcePlaybackContextService,
  type StalkerSourceContext,
} from "./source-playback-context.service";
import {
  buildStalkerExternalPlaybackHeaders,
  isCrossOriginStalkerStream,
} from "./stalker-live-playback.utils";
import { resolveStalkerStaticPlaybackUrl } from "./stores/utils/stalker-link-semantics.utils";
import { resolveStalkerPlaybackUrl } from "./stores/utils/stalker-playback-command.utils";
interface Row {
  id?: string | number;
  name?: string;
  title?: string;
  cmd?: string;
  series?: Array<string | number>;
  is_series?: unknown;
  category_id?: string;
  genre_id?: string;
  use_http_tmp_link?: unknown;
  use_load_balancing?: unknown;
}
export function sourcePortalRows(value: unknown): Row[] {
  const js = (value as { js?: unknown } | null)?.js;
  const rows = Array.isArray(js) ? js : (js as { data?: unknown } | null)?.data;
  return Array.isArray(rows)
    ? rows.filter((r): r is Row => !!r && typeof r === "object")
    : [];
}
const portalType = (category: SourcePlaybackCategory) =>
  category === "live" ? "itv" : category === "movies" ? "vod" : "series";
function missing(): never {
  throw Object.assign(Error("Sample item is unavailable"), { status: 404 });
}
@Injectable({ providedIn: "root" })
export class StalkerSourcePlaybackSamplerService implements SourcePlaybackSampler {
  selectionCursor: string | undefined;
  private readonly repository = inject(SourcePlaybackRepositoryService, {
    optional: true,
  });
  private readonly playlists = inject(PlaylistsService);
  private readonly context = inject(StalkerSourcePlaybackContextService);
  private async source(id: string, signal: AbortSignal): Promise<PlaylistMeta> {
    const source = await firstValueFrom(this.playlists.getPlaylistById(id));
    signal.throwIfAborted();
    if (!source) missing();
    return source;
  }
  private async groups(
    context: StalkerSourceContext,
    category: SourcePlaybackCategory,
  ): Promise<Row[]> {
    const type = portalType(category);
    const groups = sourcePortalRows(
      await context.request({
        type,
        action: type === "itv" ? "get_genres" : "get_categories",
      }),
    );
    return groups.filter(
      (g) =>
        g.id != null &&
        String(g.id) !== "*" &&
        String(g.id) !== "0" &&
        !(context.playlist.hiddenStalkerCategoryIds?.[type] ?? []).includes(
          String(g.id),
        ) &&
        !(context.playlist.hiddenGroupTitles ?? []).includes(
          g.title ?? g.name ?? "",
        ),
    );
  }
  private async page(
    context: StalkerSourceContext,
    category: SourcePlaybackCategory,
    categoryId: string,
    page = 1,
  ): Promise<Row[]> {
    const type = portalType(category);
    return sourcePortalRows(
      await context.request({
        type,
        action: "get_ordered_list",
        p: page,
        ...(type === "itv"
          ? { genre: categoryId, fav: 0 }
          : { category: categoryId }),
      }),
    );
  }
  async select(
    sourceId: string,
    category: SourcePlaybackCategory,
    signal: AbortSignal,
  ): Promise<readonly SourcePlaybackCandidate[]> {
    this.selectionCursor = undefined;
    const saved = (await this.repository?.read([sourceId]))?.[0];
    const cursor = readSourceSampleCursor(saved?.cursor[category]);
    const latest = saved?.latest.find((o) => o.key.category === category);
    const success = latest?.samples.find((s) => s.outcome === "played")?.itemId;
    const preferred = category === "series" && success ? cursor?.item : success;
    const source = await this.source(sourceId, signal);
    return this.context.run(source, signal, async (context) => {
      const groups = rotateSourceRows(
          await this.groups(context, category),
          (g) => String(g.id),
          cursor?.group,
          true,
        ),
        items: SourcePlaybackCandidate[] = [];
      let pages = 0;
      for (const [index, group] of groups.slice(0, 3).entries()) {
        signal.throwIfAborted();
        const categoryId = String(group.id);
        if (pages >= 3) break;
        this.selectionCursor = sourceSampleCursor(
          String(groups[(index + 1) % groups.length].id),
          1,
          "",
        );
        let page = cursor?.group === categoryId ? cursor.page : 1;
        let rows = await this.page(context, category, categoryId, page);
        pages++;
        const current = cursor?.group === categoryId ? cursor.item : undefined;
        const preferredHere =
          preferred && rows.some((r) => String(r.id) === preferred)
            ? preferred
            : undefined;
        if (
          !preferredHere &&
          current &&
          String(rows.at(-1)?.id) === current &&
          pages < 3
        ) {
          const next = await this.page(context, category, categoryId, page + 1);
          pages++;
          if (
            next.length &&
            !next.every((n) => rows.some((r) => String(r.id) === String(n.id)))
          ) {
            rows = next;
            page++;
          } else if (groups.length > 1) continue;
          else if (page > 1 && pages < 3) {
            rows = await this.page(context, category, categoryId, 1);
            page = 1;
            pages++;
          }
        }
        for (const row of rotateSourceRows(
          rows,
          (r) => String(r.id),
          preferredHere ?? (page === cursor?.page ? current : undefined),
          !!preferredHere,
        )) {
          if (row.id == null || items.some((i) => i.itemId === String(row.id)))
            continue;
          if (
            category === "movies" &&
            (row.is_series === true || Number(row.is_series) === 1)
          )
            continue;
          const candidate: SourcePlaybackCandidate = {
            itemId: String(row.id),
            title: row.name ?? row.title ?? "Sample",
            category,
            categoryId,
            cursor: sourceSampleCursor(categoryId, page, String(row.id)),
          };
          if (category === "series") {
            const seasons = sourcePortalRows(
              await context.request({
                type: "series",
                action: "get_ordered_list",
                movie_id: String(row.id),
                p: 1,
              }),
            );
            const season = seasons.find(
              (s) =>
                s.id != null &&
                s.series?.some(
                  (n) => Number.isFinite(Number(n)) && Number(n) > 0,
                ),
            );
            const episode = season?.series
              ?.map(Number)
              .find((n) => Number.isFinite(n) && n > 0);
            if (!season || !episode) continue;
            candidate.episodeId = JSON.stringify([String(season.id), episode]);
            candidate.title = `${candidate.title} · ${season.name ?? "Season"} · ${episode}`;
          }
          items.push(candidate);
          if (items.length === 3) return items;
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
    const source = await this.source(sourceId, signal);
    return this.context.run(source, signal, async (context) => {
      const groups = await this.groups(context, candidate.category);
      if (!groups.some((g) => String(g.id) === candidate.categoryId)) missing();
      const rows = await this.page(
        context,
        candidate.category,
        candidate.categoryId,
        readSourceSampleCursor(candidate.cursor)?.page ?? 1,
      );
      const row = rows.find((r) => String(r.id) === candidate.itemId);
      if (!row) missing();
      let cmd = row.cmd ?? "",
        episode: number | undefined;
      if (candidate.category === "series") {
        let identity: unknown;
        try {
          identity = JSON.parse(candidate.episodeId ?? "");
        } catch {
          missing();
        }
        if (!Array.isArray(identity) || identity.length !== 2) missing();
        const seasons = sourcePortalRows(
          await context.request({
            type: "series",
            action: "get_ordered_list",
            movie_id: candidate.itemId,
            p: 1,
          }),
        );
        const season = seasons.find((s) => String(s.id) === identity[0]);
        episode = Number(identity[1]);
        if (
          !season ||
          !Number.isFinite(episode) ||
          episode <= 0 ||
          !season.series?.some((n) => Number(n) === episode)
        )
          missing();
        cmd = season.cmd ?? cmd;
      }
      if (!cmd && candidate.category === "movies") {
        const files = sourcePortalRows(
          await context.request({
            type: "vod",
            action: "get_ordered_list",
            movie_id: candidate.itemId,
            p: 1,
          }),
        );
        if (files[0]?.id != null) cmd = `/media/file_${files[0].id}.mpg`;
      }
      if (!cmd) missing();
      let url =
        episode === undefined
          ? resolveStalkerStaticPlaybackUrl(row, cmd)
          : null;
      if (!url) {
        const link = await context.request<{
          js?: { cmd?: string; error?: string };
          cmd?: string;
        }>({
          type: episode === undefined ? portalType(candidate.category) : "vod",
          action: "create_link",
          cmd,
          disable_ad: 0,
          download: 0,
          ...(episode === undefined ? {} : { series: String(episode) }),
        });
        if (link.js?.error) missing();
        url = resolveStalkerPlaybackUrl(
          context.playlist.portalUrl ?? "",
          cmd,
          link.js?.cmd ?? link.cmd ?? "",
        );
      }
      if (!url) missing();
      return {
        streamUrl: url,
        title: candidate.title,
        isLive: candidate.category === "live",
        headers: buildStalkerExternalPlaybackHeaders(
          context.playlist,
          context.token,
          url,
        ),
        requestPolicy: {
          accountRef: sourceId,
          portalCredentials: !isCrossOriginStalkerStream(context.playlist, url),
        },
      };
    });
  }
}

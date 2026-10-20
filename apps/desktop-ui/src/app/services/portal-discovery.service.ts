import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";
import { PlaybackPositionService, PlaylistsService } from "@arm-nator/services";
import { StalkerSessionService } from "@arm-nator/providers/stalker/data-access";
import {
  catalogueIdentityKey,
  playbackDiscoveryVersion,
  matchingPlaybackVersions,
  xtreamDiscoveryVersion,
  displayProviderTitle,
  trustedWorkIds,
} from "@arm-nator/shared/interfaces";
import type {
  DiscoveryRanking,
  ResolvedPortalPlayback,
  GlobalSearchResult,
  DiscoveryVersion,
  PortalSearchContinuation,
  PortalSearchPage,
  PlaylistMeta,
} from "@arm-nator/shared/interfaces";
import type {
  DiscoveryPortal,
  PortalDiscoveryAdapter,
} from "@arm-nator/providers/shared/util";

@Injectable({ providedIn: "root" })
export class AppPortalDiscoveryService implements PortalDiscoveryAdapter {
  private readonly playlists = inject(PlaylistsService);
  private readonly session = inject(StalkerSessionService);
  private readonly positions = inject(PlaybackPositionService);
  private readonly versionsCacheKey = "discovery.known-versions.v1";
  private cachedVersions: Promise<DiscoveryVersion[]> | null = null;
  private versionWrites: Promise<void> = Promise.resolve();

  private remembered(): Promise<DiscoveryVersion[]> {
    return (this.cachedVersions ??= (async () => {
      const value = await window.electron.dbGetAppState(this.versionsCacheKey);
      if (!value) return [];
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed))
        throw new Error("Invalid saved version choices");
      return parsed.slice(-1000).filter((value): value is DiscoveryVersion => {
        if (!value || typeof value !== "object") return false;
        const row = value as DiscoveryVersion;
        try {
          catalogueIdentityKey(row.identity);
        } catch {
          return false;
        }
        return (
          ["movie", "series"].includes(row.contentType) &&
          typeof row.originalTitle === "string" &&
          typeof row.providerName === "string" &&
          Array.isArray(row.navigation) &&
          row.navigation.every((part) => typeof part === "string")
        );
      });
    })());
  }

  rememberVersions(versions: readonly DiscoveryVersion[]): Promise<void> {
    const incoming = versions.filter(
      (version) =>
        version.contentType !== "live" && version.navigation.length > 0,
    );
    const write = this.versionWrites
      .catch(() => undefined)
      .then(async () => {
        const saved = await this.remembered();
        const rows = new Map(
          saved.map((version) => [
            catalogueIdentityKey(version.identity),
            version,
          ]),
        );
        for (const version of incoming) {
          const key = catalogueIdentityKey(version.identity);
          rows.delete(key);
          // Search navigation state is unnecessary for movie/series detail routes.
          const { navigationState: _navigationState, ...safe } = version;
          rows.set(key, safe);
        }
        const bounded = [...rows.values()].slice(-1000);
        const result = await window.electron.dbSetAppState(
          this.versionsCacheKey,
          JSON.stringify(bounded),
        );
        if (!result.success) throw new Error("Unable to save version choices");
        this.cachedVersions = Promise.resolve(bounded);
      });
    this.versionWrites = write;
    return write;
  }

  async versions(
    playback: ResolvedPortalPlayback,
    known: readonly DiscoveryVersion[],
  ): Promise<DiscoveryVersion[]> {
    const seed = playbackDiscoveryVersion(playback);
    if (!seed) return [];
    const [playlists, saved, history] = await Promise.all([
      firstValueFrom(this.playlists.getAllPlaylists()),
      this.remembered(),
      this.positions.getViewingHistory(),
    ]);
    const available = new Map(playlists.map((row) => [row._id, row]));
    const key = catalogueIdentityKey(seed.identity);
    const candidates: DiscoveryVersion[] = [];
    let current =
      known.find((v) => catalogueIdentityKey(v.identity) === key) ??
      saved.find((v) => catalogueIdentityKey(v.identity) === key) ??
      seed;
    if (seed.identity.sourceType === "xtream") {
      const row = await window.electron.dbGetContentByXtreamId(
        Number(seed.identity.providerItemId),
        seed.identity.playlistId,
        seed.contentType,
      );
      if (row) {
        // The catalogue retains provider title/year tags used by the search grouper.
        current = {
          ...seed,
          originalTitle: row.title,
          categoryId: String(row.category_id),
          work: {
            ...seed.work!,
            ...xtreamDiscoveryVersion({
              ...row,
              source_type: "xtream",
              content_type: seed.contentType,
              type: seed.contentType,
              playlist_id: seed.identity.playlistId,
              playlist_name:
                available.get(seed.identity.playlistId)?.title ??
                seed.providerName,
            } as GlobalSearchResult).work,
          },
        };
      }
    }
    const terms = [
      ...new Set(
        [current.work?.title, seed.work?.title]
          .filter((value): value is string => !!value)
          .map((title) =>
            displayProviderTitle(title, current.work?.releaseYear),
          )
          .filter(Boolean),
      ),
    ];
    for (const term of terms) {
      for (let offset = 0; offset < 5000; offset += 500) {
        const page = await window.electron.dbGlobalSearch(
          term,
          [seed.contentType],
          true,
          ["xtream"],
          { limit: 500, offset },
        );
        candidates.push(
          ...page.map((row) =>
            xtreamDiscoveryVersion(row as GlobalSearchResult),
          ),
        );
        if (page.length < 500) break;
      }
    }
    const indexedCurrent = candidates.find(
      (v) => catalogueIdentityKey(v.identity) === key,
    );
    if (indexedCurrent)
      current = {
        ...current,
        categoryId: indexedCurrent.categoryId,
        navigation: indexedCurrent.navigation,
      };
    const historical = new Map(
      history.map((row) => [
        catalogueIdentityKey(row.item.seriesIdentity ?? row.item.identity),
        row.item.work.kind === "episode" ? row.item.work.series : row.item.work,
      ]),
    );
    const enrich = (version: DiscoveryVersion): DiscoveryVersion => {
      const work = historical.get(catalogueIdentityKey(version.identity));
      return work?.trustedIds && version.work
        ? {
            ...version,
            work: {
              ...version.work,
              trustedIds: {
                ...version.work.trustedIds,
                ...trustedWorkIds(work),
              },
            },
          }
        : version;
    };
    current = enrich(current);
    if (seed.work)
      current = {
        ...current,
        work: {
          ...current.work!,
          trustedIds: {
            ...current.work?.trustedIds,
            ...trustedWorkIds(seed.work),
          },
        },
      };
    current.providerName =
      available.get(seed.identity.playlistId)?.title ?? current.providerName;
    // Portal matches come only from explicit past searches; opening playback never queries portals.
    const portalKnown = saved.filter(
      (v) => v.identity.sourceType === "stalker",
    );
    return matchingPlaybackVersions(
      current,
      [...candidates, ...portalKnown, ...known]
        .filter((v) => available.has(v.identity.playlistId))
        .map(enrich),
    );
  }

  private ordered(rows: PlaylistMeta[]): PlaylistMeta[] {
    return [...rows].sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) -
          (b.position ?? Number.MAX_SAFE_INTEGER) || a._id.localeCompare(b._id),
    );
  }
  async sources(): Promise<DiscoveryPortal[]> {
    const rows = await firstValueFrom(this.playlists.getAllPlaylists());
    return this.ordered(rows)
      .filter((row) => !!row.portalUrl && !!row.macAddress)
      .map((row) => ({ playlistId: row._id, providerName: row.title }));
  }
  async page(
    source: DiscoveryPortal,
    query: string,
    page: PortalSearchContinuation,
    signal: AbortSignal,
  ): Promise<PortalSearchPage> {
    const playlist = await firstValueFrom(
      this.playlists.getPlaylistById(source.playlistId),
    );
    if (signal.aborted)
      throw new DOMException("Portal search cancelled", "AbortError");
    if (!playlist?.portalUrl || !playlist.macAddress)
      throw new Error("This portal is no longer available");
    const type =
      page.contentType === "movie"
        ? "vod"
        : page.contentType === "live"
          ? "itv"
          : "series";
    const response =
      await this.session.makeAuthenticatedRequest<PortalSearchPage>(
        playlist,
        {
          type,
          action: "get_ordered_list",
          category: "*",
          search: query,
          p: page.page,
          JsHttpRequest: "1-xml",
        },
        true,
        {
          signal,
          timeoutMs: 10_000,
          discovery: {
            playlistId: source.playlistId,
            providerName: source.providerName,
            page,
          },
        },
      );
    return response;
  }
  async ranking(version: DiscoveryVersion): Promise<DiscoveryRanking> {
    const [rows, history, preferences] = await Promise.all([
      firstValueFrom(this.playlists.getAllPlaylists()),
      this.positions.getViewingHistory(),
      version.work
        ? window.electron.dbGetTitlePreferences?.({
            identity: version.identity,
            work: version.work,
          })
        : null,
    ]);
    const successfulAt: Record<string, number> = {};
    for (const row of history) {
      // Successful playback is recorded independently of resume position.
      if (row.raw.successfulAt) {
        successfulAt[catalogueIdentityKey(row.item.identity)] =
          row.raw.successfulAt;
        if (row.item.seriesIdentity) {
          const key = catalogueIdentityKey(row.item.seriesIdentity);
          successfulAt[key] = Math.max(
            successfulAt[key] ?? 0,
            row.raw.successfulAt,
          );
        }
      }
    }
    return {
      sourceOrder: this.ordered(rows).map((row) => row._id),
      successfulAt,
      language: preferences?.audio?.language,
    };
  }
}

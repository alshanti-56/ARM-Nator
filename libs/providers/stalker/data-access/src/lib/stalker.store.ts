import { computed, Injectable, signal } from '@angular/core';
import { DataService } from '@arm-nator/services';
import {
    PlaylistMeta,
    ResolvedPortalPlayback,
    STALKER_REQUEST,
} from '@arm-nator/shared/interfaces';
import { StalkerCategoryItem, StalkerItvChannel } from './models';
import { isStalkerAuthorizationFailure } from './stalker-response-classification';
import {
    buildStalkerExternalPlaybackHeaders,
    getStalkerPortalOrigin,
    isCrossOriginStalkerStream,
    STALKER_STREAM_USER_AGENT,
} from './stalker-live-playback.utils';

export type StalkerContentType = 'itv' | 'vod' | 'series';
export type StalkerCatalogRow = StalkerItvChannel & Record<string, unknown>;

interface StalkerResponse {
    js?: {
        data?: unknown;
        total_items?: number | string;
        max_page_items?: number | string;
        token?: string;
        cmd?: string;
        error?: string;
    };
    cmd?: string;
}

@Injectable({ providedIn: 'root' })
export class StalkerStore {
    private token = '';
    private tokenPlaylistId = '';
    private tokenIdentity = '';
    private authenticationPromise: Promise<string> | null = null;
    private authenticationKey = '';
    private requestVersion = 0;
    private page = 1;
    private readonly totalItems = signal(0);
    private loadingPromise: Promise<void> | null = null;
    private seriesRequestVersion = 0;

    readonly currentPlaylist = signal<PlaylistMeta | undefined>(undefined);
    readonly selectedContentType = signal<StalkerContentType>('itv');
    readonly selectedCategoryId = signal<string | null>(null);
    readonly selectedItem = signal<StalkerCatalogRow | null>(null);
    readonly getCategoryResource = signal<StalkerCategoryItem[]>([]);
    readonly getPaginatedContent = signal<StalkerCatalogRow[]>([]);
    readonly seriesSeasons = signal<StalkerCatalogRow[]>([]);
    readonly seriesEpisodes = signal<StalkerCatalogRow[]>([]);
    readonly isPaginatedContentLoading = signal(false);
    readonly isSeriesSeasonsLoading = signal(false);
    readonly isSeriesEpisodesLoading = signal(false);
    readonly loadError = signal<string | null>(null);
    readonly hasMoreContent = computed(
        () => this.getPaginatedContent().length < this.totalItems()
    );

    readonly totalContentItems = this.totalItems.asReadonly();

    constructor(private readonly data: DataService) {}

    setCurrentPlaylist(playlist?: PlaylistMeta): void {
        if (playlist?._id === this.currentPlaylist()?._id) {
            return;
        }

        this.requestVersion += 1;
        this.loadingPromise = null;
        this.token = '';
        this.tokenPlaylistId = '';
        this.tokenIdentity = '';
        this.authenticationPromise = null;
        this.authenticationKey = '';
        this.currentPlaylist.set(playlist);
        this.resetContent();
        this.loadError.set(null);
    }

    setSelectedContentType(type: StalkerContentType): void {
        if (this.selectedContentType() === type) {
            return;
        }
        this.selectedContentType.set(type);
        this.selectedCategoryId.set(null);
        this.setSelectedItem(null);
        this.resetContent();
    }

    setSelectedCategory(id: string | null): void {
        const currentCategory = this.selectedCategoryId() ?? '*';
        const nextCategory = id ?? '*';
        if (currentCategory === nextCategory) {
            return;
        }

        this.selectedCategoryId.set(id);
        this.page = 1;
        this.setSelectedItem(null);

        // ITV is loaded once and filtered locally. This makes category changes
        // instant and avoids repeating a 11K-channel request per click.
        if (this.selectedContentType() !== 'itv') {
            this.getPaginatedContent.set([]);
            void this.loadContent();
        }
    }

    setSelectedItem(item: StalkerCatalogRow | null): void {
        const previousKey = this.entityKey(this.selectedItem());
        const nextKey = this.entityKey(item);
        if (previousKey !== nextKey) {
            this.seriesRequestVersion += 1;
            this.seriesSeasons.set([]);
            this.seriesEpisodes.set([]);
        }
        this.selectedItem.set(item);
    }

    clearSelectedItem(): void {
        this.seriesRequestVersion += 1;
        this.selectedItem.set(null);
        this.seriesSeasons.set([]);
        this.seriesEpisodes.set([]);
        this.isSeriesSeasonsLoading.set(false);
        this.isSeriesEpisodesLoading.set(false);
    }

    setSearchPhrase(_phrase: string): void {}

    resetCategories(): void {
        this.getCategoryResource.set([]);
    }

    preloadItvChannels(): void {
        void this.loadContent();
    }

    preloadSelectedContent(): void {
        void this.loadContent();
    }

    loadMore(): void {
        if (
            this.selectedContentType() !== 'itv' &&
            !this.isPaginatedContentLoading() &&
            this.hasMoreContent()
        ) {
            this.page += 1;
            void this.loadContent(true);
        }
    }

    async loadContentItem(
        type: Exclude<StalkerContentType, 'itv'>,
        itemId: string
    ): Promise<StalkerCatalogRow | null> {
        const playlist = this.currentPlaylist();
        const normalizedItemId = itemId.trim();
        if (!playlist || !normalizedItemId) return null;

        try {
            const cachedItem = this.getPaginatedContent().find((row) =>
                this.matchesEntity(row, normalizedItemId)
            );
            if (cachedItem) {
                this.setSelectedItem(cachedItem);
                return cachedItem;
            }

            await this.authenticate(playlist);
            const catalogResponse = await this.request(
                playlist,
                'get_ordered_list',
                {
                    type,
                    category: this.selectedCategoryId() ?? '*',
                    p: 1,
                }
            );
            let catalogItem = this.rowsFrom(catalogResponse).find((row) =>
                this.matchesEntity(row, normalizedItemId)
            );
            const totalItems = Number(catalogResponse.js?.total_items ?? 0);
            const reportedPageSize = Number(
                catalogResponse.js?.max_page_items ??
                    this.rowsFrom(catalogResponse).length
            );
            const pageSize = Number.isFinite(reportedPageSize) && reportedPageSize > 0
                ? reportedPageSize
                : Math.max(1, this.rowsFrom(catalogResponse).length);
            const maxPages = Math.min(
                50,
                totalItems > 0 ? Math.ceil(totalItems / pageSize) : 1
            );
            for (
                let page = 2;
                !catalogItem && page <= maxPages;
                page += 1
            ) {
                const nextPage = await this.request(
                    playlist,
                    'get_ordered_list',
                    {
                        type,
                        category: this.selectedCategoryId() ?? '*',
                        p: page,
                    }
                );
                const pageRows = this.rowsFrom(nextPage);
                catalogItem = pageRows.find((row) =>
                    this.matchesEntity(row, normalizedItemId)
                );
                if (pageRows.length === 0) break;
            }
            if (catalogItem) {
                this.setSelectedItem(catalogItem);
                return catalogItem;
            }

            // A regular-series detail request returns its seasons, not the
            // catalog item itself. Do not mistake a season row for the show.
            const response = await this.request(
                playlist,
                'get_ordered_list',
                {
                    type,
                    movie_id: this.portalMovieId(normalizedItemId),
                    p: 1,
                }
            );
            const detailRows = this.rowsFrom(response);
            const item = detailRows.find((row) =>
                this.matchesEntity(row, normalizedItemId) &&
                (type === 'vod' || !this.isSeasonRow(row))
            ) ??
                (type === 'series'
                    ? this.createSeriesDeepLinkItem(detailRows, normalizedItemId)
                    : null);
            if (item) this.setSelectedItem(item);
            return item ?? null;
        } catch (cause) {
            this.loadError.set(this.errorMessage(cause));
            return null;
        }
    }

    async loadSeriesSeasons(
        item: StalkerCatalogRow,
        requestType: 'series' | 'vod' = 'series'
    ): Promise<StalkerCatalogRow[]> {
        const playlist = this.currentPlaylist();
        if (!playlist) return [];

        const itemKey = this.entityKey(item);
        const requestVersion = ++this.seriesRequestVersion;
        this.seriesSeasons.set([]);
        this.seriesEpisodes.set([]);
        this.isSeriesSeasonsLoading.set(true);

        try {
            const response = await this.request(playlist, 'get_ordered_list', {
                type: requestType,
                movie_id: this.portalMovieId(item),
                p: 1,
            });
            if (!this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                return [];
            }

            const rows = this.rowsFrom(response);
            const result = this.filterRowsForParent(
                rows.filter((row) => this.isSeasonRow(row)),
                item
            );
            this.seriesSeasons.set(result);
            return result;
        } catch (cause) {
            if (this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                this.loadError.set(this.errorMessage(cause));
            }
            return [];
        } finally {
            if (this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                this.isSeriesSeasonsLoading.set(false);
            }
        }
    }

    async loadSeriesEpisodes(
        item: StalkerCatalogRow,
        season: StalkerCatalogRow,
        requestType: 'series' | 'vod' = 'series'
    ): Promise<StalkerCatalogRow[]> {
        const playlist = this.currentPlaylist();
        if (!playlist) return [];

        const itemKey = this.entityKey(item);
        const seasonKey = this.seasonId(season);
        const requestVersion = ++this.seriesRequestVersion;
        this.seriesEpisodes.set([]);
        this.isSeriesEpisodesLoading.set(true);

        const regularEpisodes = this.createRegularSeriesEpisodes(
            item,
            season
        );
        if (regularEpisodes) {
            if (this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                this.seriesEpisodes.set(regularEpisodes);
                this.isSeriesEpisodesLoading.set(false);
            }
            return regularEpisodes;
        }

        try {
            const response = await this.request(playlist, 'get_ordered_list', {
                type: requestType === 'series' ? 'vod' : requestType,
                movie_id: this.portalMovieId(item),
                season_id: seasonKey,
                p: 1,
            });
            if (!this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                return [];
            }

            const episodes = this.filterRowsForParent(
                this.rowsFrom(response).filter((row) =>
                    this.isEpisodeRow(row)
                ),
                item,
                seasonKey
            );
            this.seriesEpisodes.set(episodes);
            return episodes;
        } catch (cause) {
            if (this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                this.loadError.set(this.errorMessage(cause));
            }
            return [];
        } finally {
            if (this.isCurrentSeriesRequest(itemKey, requestVersion)) {
                this.isSeriesEpisodesLoading.set(false);
            }
        }
    }

    async resolveItvPlayback(item: StalkerCatalogRow): Promise<ResolvedPortalPlayback> {
        const playlist = this.currentPlaylist();
        if (!playlist?.portalUrl || !playlist.macAddress) {
            throw new Error('Stalker portal credentials are missing');
        }

        const command = String(item.cmd ?? item['url'] ?? item.id ?? '').trim();
        if (!command) {
            throw new Error('This item has no playable stream command');
        }

        const episodeNumber = this.episodeNumber(item);
        const response = await this.request(playlist, 'create_link', {
            cmd: command,
            type: this.selectedContentType() === 'series' ? 'vod' : this.selectedContentType(),
            ...(episodeNumber === undefined ? {} : { series: episodeNumber }),
        });
        const streamUrl = String(response?.js?.cmd ?? response?.cmd ?? '').trim();
        if (!streamUrl) {
            throw new Error(response?.js?.error || 'The portal did not return a playback URL');
        }

        const effectivePlaylist = playlist;
        const normalizedStreamUrl = this.normalizeStreamUrl(
            streamUrl,
            effectivePlaylist.portalUrl ?? playlist.portalUrl
        );
        const headers = buildStalkerExternalPlaybackHeaders(
            effectivePlaylist,
            this.token,
            normalizedStreamUrl
        );
        const crossOriginStream = isCrossOriginStalkerStream(
            effectivePlaylist,
            normalizedStreamUrl
        );
        const portalOrigin = getStalkerPortalOrigin(effectivePlaylist);
        const parentId = this.numericContentId(item);
        const isEpisode = episodeNumber !== undefined;

        return {
            streamUrl: normalizedStreamUrl,
            title: this.playbackTitle(item),
            thumbnail: this.readString(item, 'cover', 'stream_icon', 'logo'),
            isLive: this.selectedContentType() === 'itv',
            userAgent:
                headers['User-Agent'] ||
                effectivePlaylist.userAgent ||
                STALKER_STREAM_USER_AGENT,
            headers,
            referer: crossOriginStream
                ? undefined
                : effectivePlaylist.referrer || portalOrigin,
            origin: crossOriginStream
                ? undefined
                : effectivePlaylist.origin || portalOrigin,
            contentInfo:
                this.selectedContentType() === 'itv'
                    ? undefined
                    : {
                          playlistId: effectivePlaylist._id,
                          contentXtreamId: isEpisode
                              ? this.episodeTrackingId(item, episodeNumber)
                              : parentId,
                          contentType: isEpisode ? 'episode' : 'vod',
                          seriesXtreamId: isEpisode ? parentId : undefined,
                          seasonNumber: isEpisode
                              ? this.seasonNumber(item)
                              : undefined,
                          episodeNumber,
                      },
        };
    }

    private async loadContent(append = false): Promise<void> {
        const playlist = this.currentPlaylist();
        if (!playlist?.portalUrl || !playlist.macAddress) {
            this.loadError.set('Stalker portal credentials are missing for this source.');
            return;
        }

        if (this.loadingPromise) {
            return this.loadingPromise;
        }

        const version = this.requestVersion;
        this.isPaginatedContentLoading.set(true);
        this.loadError.set(null);

        this.loadingPromise = this.loadContentRequest(playlist, append, version)
            .catch((cause) => {
                if (version === this.requestVersion) {
                    this.loadError.set(this.errorMessage(cause));
                }
            })
            .finally(() => {
                if (version === this.requestVersion) {
                    this.isPaginatedContentLoading.set(false);
                }
                this.loadingPromise = null;
            });

        return this.loadingPromise;
    }

    private async loadContentRequest(
        playlist: PlaylistMeta,
        append: boolean,
        version: number
    ): Promise<void> {
        await this.authenticate(playlist);
        const type = this.selectedContentType();
        const categories = await this.request(
            playlist,
            type === 'itv' ? 'get_genres' : 'get_categories',
            { type }
        );
        const categoryRows = this.rowsFrom(categories).map((row) => ({
            category_id: String(row.id ?? row.category_id ?? '*'),
            category_name: String(row.title ?? row['category_name'] ?? row.name ?? 'Uncategorized'),
            type,
            censored: Boolean(row['censored']),
        }));

        let response: StalkerResponse;
        if (type === 'itv') {
            response = await this.request(playlist, 'get_all_channels', { type });
            if (this.rowsFrom(response).length === 0) {
                response = await this.request(
                    playlist,
                    'get_ordered_list',
                    { type, p: 1, category: '*' }
                );
            }
        } else {
            response = await this.request(
                playlist,
                'get_ordered_list',
                {
                    type,
                    p: this.page,
                    category: this.selectedCategoryId() ?? '*',
                }
            );
        }

        if (version !== this.requestVersion) return;
        const rows = this.rowsFrom(response);
        if (rows.length === 0) {
            throw new Error(response?.js?.error || 'The Stalker portal returned no content.');
        }

        this.getCategoryResource.set(categoryRows);
        const reportedTotal = Number(response?.js?.total_items ?? rows.length);
        const existingRows = this.getPaginatedContent();
        const nextRows = append ? [...existingRows, ...rows] : rows;
        this.totalItems.set(
            Number.isFinite(reportedTotal)
                ? Math.max(reportedTotal, nextRows.length)
                : nextRows.length
        );
        this.getPaginatedContent.set(nextRows);
    }

    private request(
        playlist: PlaylistMeta,
        action: string,
        params: Record<string, string | number>,
        token?: string
    ): Promise<StalkerResponse> {
        const requestToken =
            token ??
            (this.tokenPlaylistId === playlist._id &&
            this.tokenIdentity === this.playlistIdentity(playlist)
                ? this.token
                : '');
        return this.sendRequest(playlist, action, params, requestToken).then(
            async (response) => {
                if (
                    action !== 'handshake' &&
                    action !== 'get_profile' &&
                    isStalkerAuthorizationFailure(response)
                ) {
                    await this.authenticate(playlist);
                    return this.sendRequest(
                        playlist,
                        action,
                        params,
                        this.currentTokenFor(playlist)
                    );
                }
                return response;
            }
        );
    }

    private sendRequest(
        playlist: PlaylistMeta,
        action: string,
        params: Record<string, string | number>,
        token: string
    ): Promise<StalkerResponse> {
        const portalUrl = playlist.portalUrl!.replace(/\/+$/, '');
        const url = portalUrl.endsWith('.php')
            ? playlist.portalUrl!
            : `${portalUrl}/portal.php`;
        return Promise.resolve(
            this.data.sendIpcEvent(STALKER_REQUEST, {
                url,
                macAddress: playlist.macAddress,
                serialNumber: playlist.stalkerSerialNumber || (playlist as any).serialNumber,
                token,
                params: { ...params, action },
            })
        );
    }

    private rowsFrom(response: StalkerResponse | undefined): StalkerCatalogRow[] {
        const data = response?.js?.data;
        if (Array.isArray(data)) return data as StalkerCatalogRow[];
        if (Array.isArray(response?.js)) return response.js as unknown as StalkerCatalogRow[];
        return [];
    }

    private async authenticate(playlist: PlaylistMeta): Promise<string> {
        const key = `${playlist._id}:${this.playlistIdentity(playlist)}`;
        if (this.authenticationPromise && this.authenticationKey === key) {
            return this.authenticationPromise;
        }

        this.authenticationKey = key;
        this.authenticationPromise = (async () => {
            const auth = await this.request(playlist, 'handshake', { type: 'stb' }, '');
            const token = String(auth?.js?.token ?? '');
            if (!token) {
                throw new Error(auth?.js?.error || 'Stalker authentication failed');
            }
            this.token = token;
            this.tokenPlaylistId = playlist._id;
            this.tokenIdentity = this.playlistIdentity(playlist);
            await this.request(playlist, 'get_profile', {}, token);
            return token;
        })().finally(() => {
            this.authenticationPromise = null;
            this.authenticationKey = '';
        });

        return this.authenticationPromise;
    }

    private playlistIdentity(playlist: PlaylistMeta): string {
        return [
            playlist.portalUrl ?? '',
            playlist.macAddress ?? '',
            playlist.stalkerSerialNumber ?? (playlist as any).serialNumber ?? '',
        ]
            .map((value) => String(value).trim().toLowerCase())
            .join('|');
    }

    private currentTokenFor(playlist: PlaylistMeta): string {
        return this.tokenPlaylistId === playlist._id &&
            this.tokenIdentity === this.playlistIdentity(playlist)
            ? this.token
            : '';
    }

    private portalMovieId(row: StalkerCatalogRow | string): string {
        const raw =
            typeof row === 'string'
                ? row
                : String(
                      row.movie_id ??
                          row.series_id ??
                          row.id ??
                          row.stream_id ??
                          ''
                  );
        return raw.split(':')[0].trim();
    }

    private seasonId(row: StalkerCatalogRow): string {
        return String(row['season_id'] ?? row.id ?? '').trim();
    }

    private entityKey(row: StalkerCatalogRow | null): string {
        return row ? this.portalMovieId(row) : '';
    }

    private matchesEntity(row: StalkerCatalogRow, requestedId: string): boolean {
        const requested = this.portalMovieId(requestedId);
        return this.entityKey(row) === requested;
    }

    private isCurrentSeriesRequest(
        itemKey: string,
        requestVersion: number
    ): boolean {
        return (
            requestVersion === this.seriesRequestVersion &&
            itemKey === this.entityKey(this.selectedItem())
        );
    }

    private isSeasonRow(row: StalkerCatalogRow): boolean {
        return (
            row['is_season'] === true ||
            Array.isArray(row['series']) ||
            row['season_number'] !== undefined
        );
    }

    private createSeriesDeepLinkItem(
        rows: StalkerCatalogRow[],
        requestedId: string
    ): StalkerCatalogRow | null {
        const season = rows.find(
            (row) =>
                this.matchesEntity(row, requestedId) && this.isSeasonRow(row)
        );
        if (!season) return null;

        const title = this.readString(
            season,
            'series_title',
            'series_name',
            'o_name'
        );
        return {
            ...season,
            id: this.portalMovieId(requestedId),
            series_id: this.portalMovieId(requestedId),
            name: title || `Series ${this.portalMovieId(requestedId)}`,
            o_name: title || `Series ${this.portalMovieId(requestedId)}`,
        };
    }

    private isEpisodeRow(row: StalkerCatalogRow): boolean {
        return (
            row['is_episode'] === true ||
            row['episode_num'] !== undefined ||
            row['series_number'] !== undefined
        );
    }

    private createRegularSeriesEpisodes(
        item: StalkerCatalogRow,
        season: StalkerCatalogRow
    ): StalkerCatalogRow[] | null {
        const rawEpisodes = season['series'];
        if (!Array.isArray(rawEpisodes)) {
            return null;
        }

        const parentId = this.portalMovieId(item);
        const seasonKey = this.seasonId(season);
        const command = String(season.cmd ?? '').trim();

        return rawEpisodes
            .map((rawEpisode) => {
                const source =
                    rawEpisode && typeof rawEpisode === 'object'
                        ? (rawEpisode as Record<string, unknown>)
                        : {};
                const episodeNumber = Number(
                    source['episode_num'] ??
                        source['series_number'] ??
                        rawEpisode
                );
                return { source, episodeNumber };
            })
            .filter(({ episodeNumber }) => Number.isFinite(episodeNumber))
            .map(({ source, episodeNumber }) => ({
                ...season,
                ...source,
                id: `${parentId}:${seasonKey}:${episodeNumber}`,
                name:
                    String(source['name'] ?? source['title'] ?? '').trim() ||
                    `Episode ${episodeNumber}`,
                o_name:
                    String(source['o_name'] ?? source['name'] ?? source['title'] ?? '').trim() ||
                    `Episode ${episodeNumber}`,
                cmd: command,
                series_title: String(item['o_name'] ?? item.name ?? '').trim(),
                series_id: parentId,
                season_id: seasonKey,
                episode_num: episodeNumber,
                series_number: episodeNumber,
                is_episode: true,
                is_regular_series_episode: true,
            }));
    }

    private episodeNumber(row: StalkerCatalogRow): number | undefined {
        const raw = row['series_number'] ?? row['episode_num'];
        if (raw === undefined || raw === null || String(raw).trim() === '') {
            return undefined;
        }

        const number = Number(raw);
        return Number.isFinite(number) ? number : undefined;
    }

    private seasonNumber(row: StalkerCatalogRow): number | undefined {
        const raw = row['season_number'] ?? row['season_id'];
        if (raw === undefined || raw === null) return undefined;

        const parts = String(raw).split(':');
        const number = Number(parts[parts.length - 1]);
        return Number.isFinite(number) ? number : undefined;
    }

    private playbackTitle(row: StalkerCatalogRow): string {
        const title = this.readString(row, 'o_name', 'name', 'title');
        const seriesTitle = this.readString(row, 'series_title', 'series_name');
        return seriesTitle && this.episodeNumber(row) !== undefined
            ? `${seriesTitle} - ${title}`
            : title || 'Live TV';
    }

    private readString(row: StalkerCatalogRow, ...keys: string[]): string {
        for (const key of keys) {
            const value = row[key];
            if (value !== null && value !== undefined && String(value).trim()) {
                return String(value).trim();
            }
        }
        return '';
    }

    private numericContentId(row: StalkerCatalogRow): number {
        const raw = this.portalMovieId(row);
        const numeric = Number(raw);
        return Number.isSafeInteger(numeric) && numeric > 0
            ? numeric
            : this.stableNumericId(raw || String(row.id ?? 'content'));
    }

    private episodeTrackingId(
        row: StalkerCatalogRow,
        episodeNumber: number | undefined
    ): number {
        return this.stableNumericId(
            `${this.portalMovieId(row)}:${this.seasonNumber(row) ?? 0}:${episodeNumber ?? 0}`
        );
    }

    private stableNumericId(value: string): number {
        let hash = 0;
        for (let index = 0; index < value.length; index += 1) {
            hash = (hash * 31 + value.charCodeAt(index)) | 0;
        }
        return Math.abs(hash) || 1;
    }

    private filterRowsForParent(
        rows: StalkerCatalogRow[],
        item: StalkerCatalogRow,
        seasonKey?: string
    ): StalkerCatalogRow[] {
        const parentId = this.portalMovieId(item);
        return rows.filter((row) => {
            const rowParent = String(
                row['movie_id'] ?? row['series_id'] ?? row['video_id'] ?? ''
            ).trim();
            const rowSeason = String(
                row['season_id'] ?? row['season'] ?? ''
            ).trim();
            if (rowParent && this.portalMovieId(rowParent) !== parentId) {
                return false;
            }
            if (seasonKey && rowSeason && rowSeason !== seasonKey) {
                return false;
            }
            return true;
        });
    }

    private normalizeStreamUrl(streamUrl: string, portalUrl: string): string {
        const trimmed = streamUrl.trim();
        const commandPrefix = trimmed.indexOf(' ');
        const candidate =
            commandPrefix > 0
                ? trimmed.slice(commandPrefix + 1).trim()
                : trimmed;
        if (/^https?:\/\//i.test(candidate)) return candidate;
        try {
            return new URL(candidate, portalUrl).toString();
        } catch {
            return candidate;
        }
    }

    private errorMessage(cause: unknown): string {
        return cause instanceof Error ? cause.message : String(cause);
    }

    private resetContent(): void {
        this.seriesRequestVersion += 1;
        this.page = 1;
        this.totalItems.set(0);
        this.getPaginatedContent.set([]);
        this.seriesSeasons.set([]);
        this.seriesEpisodes.set([]);
        this.isSeriesSeasonsLoading.set(false);
        this.isSeriesEpisodesLoading.set(false);
    }
}

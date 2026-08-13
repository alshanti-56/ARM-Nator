/* eslint-disable max-lines */
import {
    PortalActivityType,
    PortalFavoriteItem,
    PortalRecentItem,
} from '@arm-nator/shared/interfaces';
import {
    buildXtreamCollectionUid,
    CollectionContentType,
    CollectionSourceType,
    UnifiedCollectionItem,
} from '../collection/unified-collection-item.interface';
import { CollectionScope } from '../collection/scope-toggle.service';

export interface WorkspaceNavigationTarget {
    link: string[];
    state?: Record<string, unknown>;
}

export const OPEN_LIVE_COLLECTION_ITEM_STATE_KEY = 'openLiveCollectionItem';
export const OPEN_COLLECTION_DETAIL_STATE_KEY = 'openCollectionDetailItem';
export const COLLECTION_VIEW_STATE_KEY = 'collectionViewState';

export interface OpenLiveCollectionItemState {
    contentType: 'live';
    sourceType: CollectionSourceType;
    playlistId: string;
    itemId: string;
    title?: string;
    imageUrl?: string | null;
}

export interface OpenCollectionDetailItemState {
    item: UnifiedCollectionItem;
    seriesResume?: SeriesResumeTarget;
}

export interface SeriesResumeTarget {
    seriesXtreamId: number;
    contentXtreamId: number;
    seasonNumber: number;
    episodeNumber: number;
}

export interface CollectionViewState {
    selectedContentType?: CollectionContentType;
    scope?: CollectionScope;
}

export function getRecentItemNavigation(
    item: PortalRecentItem,
    seriesResume?: SeriesResumeTarget | null
): WorkspaceNavigationTarget {
    if (item.type === 'live') {
        return buildLiveCollectionNavigationTarget({
            mode: 'recent',
            sourceType: normalizeCollectionSourceType(item.source) ?? 'xtream',
            playlistId: item.playlist_id,
            itemId: item.xtream_id ?? item.id,
            title: item.title,
            imageUrl: item.poster_url,
        });
    }

    const collectionItem = buildDashboardCollectionDetailItem(item);
    if (collectionItem) {
        const detailItem =
            item.source === 'xtream' &&
            item.type === 'series' &&
            seriesResume
                ? {
                      ...collectionItem,
                      uid: buildXtreamCollectionUid(
                          item.playlist_id,
                          'series',
                          seriesResume.seriesXtreamId
                      ),
                      xtreamId: seriesResume.seriesXtreamId,
                  }
                : collectionItem;
        return buildGlobalCollectionDetailNavigationTarget(
            'recent',
            detailItem,
            item.type === 'series' ? seriesResume : null
        );
    }

    return buildXtreamNavigationTarget({
        playlistId: item.playlist_id,
        type: item.type,
        categoryId: item.category_id,
        itemId: item.xtream_id,
        title: item.title,
        imageUrl: item.poster_url,
    });
}

export function getGlobalFavoriteNavigation(
    item: PortalFavoriteItem
): WorkspaceNavigationTarget {
    if (item.type === 'live') {
        return buildLiveCollectionNavigationTarget({
            mode: 'favorites',
            sourceType: normalizeCollectionSourceType(item.source) ?? 'xtream',
            playlistId: item.playlist_id,
            itemId: item.xtream_id ?? item.id,
            title: item.title,
            imageUrl: item.poster_url,
        });
    }

    const collectionItem = buildDashboardCollectionDetailItem(item);
    if (collectionItem) {
        return buildGlobalCollectionDetailNavigationTarget(
            'favorites',
            collectionItem
        );
    }

    return buildXtreamNavigationTarget({
        playlistId: item.playlist_id,
        type: item.type,
        categoryId: item.category_id,
        itemId: item.xtream_id,
        title: item.title,
        imageUrl: item.poster_url,
    });
}

export function buildXtreamNavigationTarget(params: {
    playlistId: string;
    type: PortalActivityType;
    categoryId?: string | number | null;
    itemId?: string | number | null;
    title?: string;
    imageUrl?: string | null;
}): WorkspaceNavigationTarget {
    const link = buildXtreamItemLink(params);
    const routeType = toXtreamRouteType(params.type);

    if (routeType !== 'live') {
        return { link };
    }

    const streamId = Number(toPathSegment(params.itemId));
    if (!Number.isFinite(streamId) || streamId <= 0) {
        return { link };
    }

    return {
        link,
        state: {
            openXtreamLiveItemId: streamId,
            openXtreamLiveTitle: params.title || '',
            openXtreamLivePoster: params.imageUrl || '',
        },
    };
}

export function buildLiveCollectionNavigationTarget(params: {
    mode: 'favorites' | 'recent';
    sourceType: CollectionSourceType;
    playlistId: string;
    itemId?: string | number | null;
    title?: string;
    imageUrl?: string | null;
}): WorkspaceNavigationTarget {
    return {
        link: buildCollectionRoute(
            params.sourceType,
            params.playlistId,
            params.mode
        ),
        state: {
            [OPEN_LIVE_COLLECTION_ITEM_STATE_KEY]:
                buildOpenLiveCollectionItemState(params),
        },
    };
}

export function buildGlobalCollectionDetailNavigationTarget(
    mode: 'favorites' | 'recent',
    item: UnifiedCollectionItem,
    seriesResume?: SeriesResumeTarget | null
): WorkspaceNavigationTarget {
    return {
        link: [
            '/workspace',
            mode === 'favorites' ? 'global-favorites' : 'global-recent',
        ],
        state: {
            [OPEN_COLLECTION_DETAIL_STATE_KEY]:
                buildOpenCollectionDetailItemState(item, seriesResume),
        },
    };
}

export function buildCollectionViewState(params: {
    selectedContentType?: CollectionContentType | null;
    scope?: CollectionScope | null;
}): CollectionViewState | null {
    const selectedContentType = normalizeCollectionContentType(
        params.selectedContentType
    );
    const scope = normalizeCollectionScope(params.scope);

    if (!selectedContentType && !scope) {
        return null;
    }

    return {
        ...(selectedContentType ? { selectedContentType } : {}),
        ...(scope ? { scope } : {}),
    };
}

export function getCollectionViewState(
    state: unknown
): CollectionViewState | null {
    const record = toStateRecord(state);
    const candidate = toStateRecord(record?.[COLLECTION_VIEW_STATE_KEY]);

    return buildCollectionViewState({
        selectedContentType: candidate?.[
            'selectedContentType'
        ] as CollectionContentType | null,
        scope: candidate?.['scope'] as CollectionScope | null,
    });
}

export function buildOpenCollectionDetailItemState(
    item: UnifiedCollectionItem,
    seriesResume?: SeriesResumeTarget | null
): OpenCollectionDetailItemState {
    const normalizedResume = normalizeSeriesResumeTarget(seriesResume);
    return {
        item: normalizeCollectionDetailItem(item) ?? item,
        ...(normalizedResume ? { seriesResume: normalizedResume } : {}),
    };
}

export function getOpenCollectionDetailItemState(
    state: unknown
): OpenCollectionDetailItemState | null {
    const record = toStateRecord(state);
    const candidate = toStateRecord(record?.[OPEN_COLLECTION_DETAIL_STATE_KEY]);
    const item = normalizeCollectionDetailItem(candidate?.['item']);
    const seriesResume = normalizeSeriesResumeTarget(
        candidate?.['seriesResume']
    );

    return item
        ? {
              item,
              ...(item.contentType === 'series' && seriesResume
                  ? { seriesResume }
                  : {}),
          }
        : null;
}

export function buildOpenLiveCollectionItemState(params: {
    sourceType: CollectionSourceType;
    playlistId: string;
    itemId?: string | number | null;
    title?: string;
    imageUrl?: string | null;
}): OpenLiveCollectionItemState {
    return {
        contentType: 'live',
        sourceType: params.sourceType,
        playlistId: params.playlistId,
        itemId: toPathSegment(params.itemId),
        title: params.title,
        imageUrl: params.imageUrl,
    };
}

export function getOpenLiveCollectionItemState(
    state: unknown
): OpenLiveCollectionItemState | null {
    const record = toStateRecord(state);
    const candidate = record?.[OPEN_LIVE_COLLECTION_ITEM_STATE_KEY];
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }

    const sourceType = toPathSegment(
        (candidate as Record<string, unknown>)['sourceType']
    ) as CollectionSourceType;
    const playlistId = toPathSegment(
        (candidate as Record<string, unknown>)['playlistId']
    );
    const itemId = toPathSegment(
        (candidate as Record<string, unknown>)['itemId']
    );

    if (
        !playlistId ||
        !itemId ||
        sourceType !== 'xtream'
    ) {
        return null;
    }

    return {
        contentType: 'live',
        sourceType,
        playlistId,
        itemId,
        title: toOptionalPathSegment(
            (candidate as Record<string, unknown>)['title']
        ),
        imageUrl: toOptionalPathSegment(
            (candidate as Record<string, unknown>)['imageUrl']
        ),
    };
}

export function buildXtreamItemLink(params: {
    playlistId: string;
    type: PortalActivityType;
    categoryId?: string | number | null;
    itemId?: string | number | null;
}): string[] {
    const routeType = toXtreamRouteType(params.type);
    const categoryId = toPathSegment(params.categoryId);
    const itemId = toPathSegment(params.itemId);

    if (routeType === 'live') {
        return ['/workspace', 'xtreams', params.playlistId, 'live'];
    }

    if (categoryId && itemId) {
        return [
            '/workspace',
            'xtreams',
            params.playlistId,
            routeType,
            categoryId,
            itemId,
        ];
    }

    if (categoryId) {
        return [
            '/workspace',
            'xtreams',
            params.playlistId,
            routeType,
            categoryId,
        ];
    }

    return ['/workspace', 'xtreams', params.playlistId, routeType];
}

export function getUnifiedCollectionNavigation(
    item: UnifiedCollectionItem
): WorkspaceNavigationTarget | null {
    if (item.sourceType === 'xtream') {
        return buildXtreamNavigationTarget({
            playlistId: item.playlistId,
            type: item.contentType,
            categoryId: item.categoryId,
            itemId: item.xtreamId,
            title: item.name,
            imageUrl: item.posterUrl ?? item.logo ?? null,
        });
    }

    return null;
}

export function clearNavigationStateKeys(keys: string[]): void {
    try {
        const state = toStateRecord(window.history.state);
        if (!state) {
            return;
        }

        const nextState = { ...state };
        let changed = false;
        keys.forEach((key) => {
            if (key in nextState) {
                delete nextState[key];
                changed = true;
            }
        });

        if (changed) {
            window.history.replaceState(nextState, document.title);
        }
    } catch {
        // no-op
    }
}

export function matchesOpenLiveCollectionItem(
    item: UnifiedCollectionItem,
    target: OpenLiveCollectionItemState
): boolean {
    if (
        item.contentType !== 'live' ||
        item.sourceType !== target.sourceType ||
        item.playlistId !== target.playlistId
    ) {
        return false;
    }

    const targetId = toPathSegment(target.itemId);
    const sourceItemId = getLastSegment(item.uid, '::') ?? '';
    const candidates = [
        sourceItemId,
        item.xtreamId,
        item.contentId,
    ]
        .map((value) => toPathSegment(value))
        .filter(Boolean);

    if (candidates.includes(targetId)) {
        return true;
    }

    const normalizedTargetTitle = target.title?.trim().toLowerCase();
    return Boolean(
        normalizedTargetTitle &&
        item.name.trim().toLowerCase() === normalizedTargetTitle
    );
}

function getLastSegment(value: string, separator: string): string | undefined {
    const segments = value.split(separator);
    return segments.length > 0 ? segments[segments.length - 1] : undefined;
}

function normalizeCollectionContentType(
    value: CollectionContentType | null | undefined
): CollectionContentType | null {
    return value === 'live' || value === 'movie' || value === 'series'
        ? value
        : null;
}

function normalizeCollectionScope(
    value: CollectionScope | null | undefined
): CollectionScope | null {
    return value === 'playlist' || value === 'all' ? value : null;
}

function normalizeCollectionSourceType(
    value: unknown
): CollectionSourceType | null {
    return value === 'xtream' ? value : null;
}

function buildDashboardCollectionDetailItem(
    item: PortalFavoriteItem | PortalRecentItem
): UnifiedCollectionItem | null {
    if (
        item.type === 'live' ||
        item.source !== 'xtream'
    ) {
        return null;
    }

    if (item.source === 'xtream') {
        return normalizeCollectionDetailItem({
            uid: buildXtreamCollectionUid(
                item.playlist_id,
                item.type,
                item.xtream_id
            ),
            name: item.title,
            contentType: item.type,
            sourceType: 'xtream',
            playlistId: item.playlist_id,
            playlistName: item.playlist_name ?? '',
            posterUrl: item.poster_url ?? null,
            xtreamId: toOptionalNumber(item.xtream_id),
            contentId: toOptionalNumber(item.id),
            categoryId: item.category_id,
            addedAt: 'added_at' in item ? item.added_at : undefined,
            viewedAt: 'viewed_at' in item ? item.viewed_at : undefined,
        });
    }

    return null;
}

export function toXtreamRouteType(
    type: PortalActivityType
): 'live' | 'vod' | 'series' {
    return type === 'movie' ? 'vod' : type;
}

function toPathSegment(value: unknown): string {
    return String(value ?? '').trim();
}

function toOptionalPathSegment(value: unknown): string | undefined {
    const normalized = toPathSegment(value);
    return normalized ? normalized : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
    const rawValue = String(value ?? '').trim();
    if (!rawValue) {
        return undefined;
    }

    const normalized = Number(rawValue);
    return Number.isFinite(normalized) ? normalized : undefined;
}

function normalizeSeriesResumeTarget(
    candidate: unknown
): SeriesResumeTarget | null {
    const record = toStateRecord(candidate);
    if (!record) {
        return null;
    }

    const seriesXtreamId = toOptionalNumber(record['seriesXtreamId']);
    const contentXtreamId = toOptionalNumber(record['contentXtreamId']);
    const seasonNumber = toOptionalNumber(record['seasonNumber']);
    const episodeNumber = toOptionalNumber(record['episodeNumber']);

    if (
        !Number.isInteger(seriesXtreamId) ||
        (seriesXtreamId ?? 0) <= 0 ||
        !Number.isInteger(contentXtreamId) ||
        (contentXtreamId ?? 0) <= 0 ||
        !Number.isInteger(seasonNumber) ||
        (seasonNumber ?? -1) < 0 ||
        !Number.isInteger(episodeNumber) ||
        (episodeNumber ?? -1) < 0
    ) {
        return null;
    }

    return {
        seriesXtreamId: seriesXtreamId as number,
        contentXtreamId: contentXtreamId as number,
        seasonNumber: seasonNumber as number,
        episodeNumber: episodeNumber as number,
    };
}

function normalizeCollectionDetailItem(
    candidate: unknown
): UnifiedCollectionItem | null {
    const record = toStateRecord(candidate);
    if (!record) {
        return null;
    }

    const contentType = toPathSegment(record['contentType']);
    const sourceType = normalizeCollectionSourceType(record['sourceType']);
    const uid = toPathSegment(record['uid']);
    const name = toPathSegment(record['name']);
    const playlistId = toPathSegment(record['playlistId']);

    if (
        !uid ||
        !name ||
        !playlistId ||
        !sourceType ||
        (contentType !== 'movie' && contentType !== 'series') ||
        sourceType !== 'xtream'
    ) {
        return null;
    }

    return {
        uid,
        name,
        contentType,
        sourceType,
        playlistId,
        playlistName: toPathSegment(record['playlistName']),
        posterUrl:
            toOptionalPathSegment(record['posterUrl']) ??
            toOptionalPathSegment(record['logo']) ??
            null,
        logo: toOptionalPathSegment(record['logo']) ?? null,
        xtreamId: toOptionalNumber(record['xtreamId']),
        contentId: toOptionalNumber(record['contentId']),
        categoryId: toOptionalPathSegment(record['categoryId']),
        rating: toOptionalPathSegment(record['rating']),
        addedAt: toOptionalPathSegment(record['addedAt']),
        viewedAt: toOptionalPathSegment(record['viewedAt']),
        position: toOptionalNumber(record['position']),
    };
}

function buildCollectionRoute(
    sourceType: CollectionSourceType,
    playlistId: string,
    mode: 'favorites' | 'recent'
): string[] {
    if (sourceType === 'xtream') {
        return ['/workspace', 'xtreams', playlistId, mode];
    }

    return ['/workspace', 'xtreams', playlistId, mode];
}

function toStateRecord(state: unknown): Record<string, unknown> | null {
    return state && typeof state === 'object'
        ? (state as Record<string, unknown>)
        : null;
}

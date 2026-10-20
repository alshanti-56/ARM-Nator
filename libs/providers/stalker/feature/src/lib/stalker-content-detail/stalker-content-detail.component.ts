import {
    ChangeDetectionStrategy,
    Component,
    DestroyRef,
    computed,
    effect,
    inject,
    signal,
    untracked,
} from '@angular/core';
import { Location, UpperCasePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { MatIcon } from '@angular/material/icon';
import { TranslatePipe } from '@ngx-translate/core';
import { SafePipe } from '@arm-nator/pipes';
import { TmdbEnrichmentService, type TmdbEpisode } from '@arm-nator/services';
import {
    DetailActionsTemplateDirective,
    DetailMetaTemplateDirective,
    DetailTagsTemplateDirective,
    PortalDetailShellComponent,
} from '@arm-nator/ui/components';
import {
    PORTAL_PLAYER as PORTAL_PLAYER_TOKEN,
    resolveCatalogueOrigin,
    DiscoverySelectionService,
} from '@arm-nator/providers/shared/util';
import {
    StalkerCatalogRow,
    StalkerContentType,
    StalkerStore,
} from '@arm-nator/providers/stalker/data-access';
import {
    isStalkerSeriesFlag,
    resolveEnrichmentSeasonNumber,
    ResolvedPortalPlayback,
    TmdbEnrichedCastMember,
    youtubeEmbedUrl,
} from '@arm-nator/shared/interfaces';
import { createStalkerPlaybackRecoveryContext } from '../stalker-playback-recovery';

type DetailContentType = Exclude<StalkerContentType, 'itv'>;

@Component({
    selector: 'app-stalker-content-detail',
    standalone: true,
    imports: [
        DetailActionsTemplateDirective,
        DetailMetaTemplateDirective,
        DetailTagsTemplateDirective,
        MatIcon,
        PortalDetailShellComponent,
        SafePipe,
        TranslatePipe,
        UpperCasePipe,
    ],
    templateUrl: './stalker-content-detail.component.html',
    styleUrls: ['./stalker-content-detail.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StalkerContentDetailComponent {
    readonly store = inject(StalkerStore);
    private readonly route = inject(ActivatedRoute);
    private readonly router = inject(Router);
    private readonly location = inject(Location);
    private readonly destroyRef = inject(DestroyRef);
    private readonly portalPlayer = inject(PORTAL_PLAYER_TOKEN);
    private readonly discoverySelection = inject(DiscoverySelectionService);
    private readonly tmdbEnrichment = inject(TmdbEnrichmentService);

    readonly contentType = signal<DetailContentType>('vod');
    readonly item = this.store.selectedItem;
    readonly seasons = this.store.seriesSeasons;
    readonly selectedSeason = computed(
        () => this.seasons().find((season) => this.isSelectedSeason(season)) ?? null
    );
    readonly episodes = this.store.seriesEpisodes;
    readonly seasonsLoading = this.store.isSeriesSeasonsLoading;
    readonly episodesLoading = this.store.isSeriesEpisodesLoading;
    readonly seriesError = this.store.seriesLoadError;
    readonly detailLoading = signal(true);
    readonly detailError = signal<string | null>(null);
    readonly playbackError = signal<string | null>(null);
    readonly selectedSeasonId = signal<string | null>(null);
    readonly seasonEpisodeMetadata = signal<readonly TmdbEpisode[]>([]);
    readonly activePlayback = signal<ResolvedPortalPlayback | null>(null);
    private readonly requestedItemId = signal<string | null>(null);
    private readonly detailRequestVersion = signal(0);
    private playbackRequestController: AbortController | null = null;
    private playbackRequestGeneration = 0;
    private readonly seasonEpisodeMetadataCache = new Map<string, readonly TmdbEpisode[]>();
    private readonly pendingSeasonEpisodeMetadata = new Map<string, Promise<readonly TmdbEpisode[] | null>>();

    readonly isSeries = computed(
        () =>
            this.contentType() === 'series' ||
            isStalkerSeriesFlag(this.item()?.['is_series'])
    );
    private readonly seriesRequestType = computed<'series' | 'vod'>(() =>
        this.contentType() === 'series' ? 'series' : 'vod'
    );

    readonly title = computed(() => this.readText(this.item(), 'o_name', 'name', 'title') || 'Untitled');
    readonly description = computed(() =>
        this.readNestedText(this.item(), 'description', 'plot')
    );
    readonly poster = computed(() =>
        this.resolveArtwork(
            this.readNestedText(
                this.item(),
                'movie_image',
                'cover',
                'poster_url',
                'logo',
                'stream_icon',
                'screenshot_uri'
            )
        )
    );
    readonly backdrop = computed(() =>
        this.resolveArtwork(
            this.readNestedText(
                this.item(),
                'tmdb_backdrop',
                'backdrop',
                'backdrop_url'
            )
        )
    );
    readonly year = computed(() =>
        this.readNestedText(this.item(), 'year', 'releasedate', 'release_date')
    );
    readonly genre = computed(() =>
        this.readNestedText(this.item(), 'genre', 'genres_str', 'category_name')
    );
    readonly rating = computed(() =>
        this.readNestedText(this.item(), 'rating_imdb', 'rating_kinopoisk', 'rating')
    );
    readonly actors = computed(() => this.readNestedText(this.item(), 'actors', 'cast'));
    readonly director = computed(() => this.readNestedText(this.item(), 'director'));
    readonly country = computed(() => this.readNestedText(this.item(), 'country'));
    readonly runtime = computed(() =>
        this.readNestedText(this.item(), 'runtime', 'duration', 'duration_secs')
    );
    readonly bitrate = computed(() => this.readNestedText(this.item(), 'bitrate'));
    readonly format = computed(() =>
        this.readNestedText(this.item(), 'format', 'container_extension')
    );
    readonly streamId = computed(() =>
        this.readText(this.item(), 'stream_id', 'movie_id', 'series_id', 'id')
    );
    readonly tmdbId = computed(() => this.readNestedText(this.item(), 'tmdb_id'));
    readonly tmdbCast = computed<TmdbEnrichedCastMember[]>(
        () => this.item()?.info?.tmdb_cast ?? []
    );
    readonly tmdbDirectors = computed<TmdbEnrichedCastMember[]>(
        () => this.item()?.info?.tmdb_directors ?? []
    );
    readonly trailerEmbedUrl = computed(() =>
        youtubeEmbedUrl(this.readNestedText(this.item(), 'tmdb_trailer'))
    );

    constructor() {
        this.destroyRef.onDestroy(() => this.invalidatePlaybackRequest());
        effect(() => {
            const playlist = this.store.currentPlaylist();
            const itemId = this.requestedItemId();
            const requestVersion = this.detailRequestVersion();
            if (playlist && itemId) {
                untracked(() => void this.loadItem(itemId, requestVersion));
            }
        });
        effect(() => {
            const item = this.item();
            const season = this.selectedSeason();
            const episodes = this.episodes();
            const seasonId = this.selectedSeasonId();
            const requestVersion = this.detailRequestVersion();
            if (!item || !season || !episodes.length || seasonId === null || !this.readTmdbId(item)) {
                return;
            }
            const ownerId = this.entityId(
                item.movie_id ?? item.series_id ?? item.id ?? item.stream_id
            );
            untracked(() => void this.loadSeasonEpisodeMetadata(
                item,
                season,
                episodes,
                ownerId,
                seasonId,
                requestVersion
            ));
        });

        combineLatest([this.route.data, this.route.paramMap])
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(([data, params]) => {
                const type = data['contentType'];
                const contentType: DetailContentType =
                    type === 'series' ? 'series' : 'vod';
                const categoryId = params.get('categoryId');
                const itemId = params.get(
                    contentType === 'series' ? 'serialId' : 'vodId'
                );

                this.detailRequestVersion.update((version) => version + 1);
                this.invalidatePlaybackRequest();
                this.contentType.set(contentType);
                this.detailLoading.set(true);
                this.detailError.set(null);
                this.playbackError.set(null);
                this.selectedSeasonId.set(null);
                this.seasonEpisodeMetadata.set([]);
                this.requestedItemId.set(itemId);
                this.store.setSelectedContentType(contentType);
                if (this.store.selectedCategoryId() !== categoryId) {
                    this.store.setSelectedCategory(categoryId === '*' ? null : categoryId);
                }
            });
    }

    async selectSeason(season: StalkerCatalogRow): Promise<void> {
        const item = this.item();
        if (!item) return;

        this.invalidatePlaybackRequest();
        const seasonId = this.seasonId(season);
        this.selectedSeasonId.set(seasonId);
        const ownerId = this.entityId(
            item.movie_id ?? item.series_id ?? item.id ?? item.stream_id
        );
        const requestVersion = this.detailRequestVersion();
        const tmdbId = this.readTmdbId(item);
        const seasonNumber = this.resolveTmdbSeasonNumber(item, season, []);
        const metadataKey = tmdbId !== null && seasonNumber !== null
            ? this.seasonEpisodeMetadataKey(ownerId, tmdbId, seasonId, seasonNumber)
            : null;
        this.seasonEpisodeMetadata.set(
            metadataKey ? this.seasonEpisodeMetadataCache.get(metadataKey) ?? [] : []
        );
        this.playbackError.set(null);
        await this.store.loadSeriesEpisodes(
            item,
            season,
            this.seriesRequestType()
        );
    }

    async playMovie(): Promise<void> {
        const item = this.item();
        if (item) await this.play(item);
    }

    async playEpisode(episode: StalkerCatalogRow): Promise<void> {
        await this.play(episode);
    }

    goBack(): void {
        const portalId = this.route.parent?.snapshot.paramMap.get('id');
        const origin = portalId ? resolveCatalogueOrigin(this.location.getState(), portalId, this.contentType(), 'stalker') : null;
        if (origin) {
            void this.router.navigateByUrl(origin);
            return;
        }
        const categoryId = this.store.selectedCategoryId() ?? '*';
        if (!portalId) {
            void this.router.navigate(['/workspace']);
            return;
        }

        void this.router.navigate([
            '/workspace/stalker',
            portalId,
            this.contentType(),
            categoryId,
        ], { queryParamsHandling: 'preserve' });
    }

    seasonLabel(season: StalkerCatalogRow): string {
        const providerLabel = this.readText(season, 'name', 'title', 'o_name');
        if (/^\d+$/.test(providerLabel)) {
            return `Season ${Number(providerLabel)}`;
        }
        const numberedSeason = providerLabel.match(/^season\s*0*(\d+)$/i);
        if (numberedSeason) {
            return `Season ${Number(numberedSeason[1])}`;
        }
        if (providerLabel && !/^season$/i.test(providerLabel)) return providerLabel;
        const seasonNumber = this.resolveTmdbSeasonNumber(this.item(), season, []);
        return seasonNumber === null ? 'Season' : `Season ${seasonNumber}`;
    }

    episodeLabel(episode: StalkerCatalogRow, index: number): string {
        const number = this.readEpisodeNumber(episode) ?? index + 1;
        const name = this.episodeDisplayName(episode, number);
        return `Episode ${number}${name ? ` · ${name}` : ''}`;
    }

    isSelectedSeason(season: StalkerCatalogRow): boolean {
        const selectedId = this.selectedSeasonId();
        return selectedId !== null && this.seasonId(season) === selectedId;
    }

    hasDetails(): boolean {
        return Boolean(
            this.description() ||
                this.year() ||
                this.genre() ||
                this.rating() ||
                this.actors() ||
                this.director()
        );
    }

    private async loadItem(
        itemId: string | null,
        requestVersion = this.detailRequestVersion()
    ): Promise<void> {
        if (!itemId) {
            this.detailError.set('This item could not be identified.');
            this.detailLoading.set(false);
            return;
        }

        const ownerId = this.store.currentPlaylist()?._id;
        const current = this.store.getPaginatedContent().find((row) =>
            this.matchesId(row, itemId)
        );
        const selected = this.store.selectedItem();
        const item = this.matchesId(selected, itemId)
            ? selected
            : current ?? (await this.store.loadContentItem(this.contentType(), itemId));

        if (requestVersion !== this.detailRequestVersion() || ownerId !== this.store.currentPlaylist()?._id) return;

        if (!item) {
            this.detailError.set('The portal did not return details for this item.');
            this.detailLoading.set(false);
            return;
        }

        this.store.setSelectedItem(item);
        this.detailLoading.set(false);

        if (this.isSeries()) {
            const seasons = await this.store.loadSeriesSeasons(
                item,
                this.seriesRequestType()
            );
            if (
                requestVersion !== this.detailRequestVersion() ||
                ownerId !== this.store.currentPlaylist()?._id ||
                this.item() !== item ||
                seasons.length === 0
            ) {
                return;
            }
            const playlistId = this.store.currentPlaylist()?._id;
            const request = playlistId ? this.discoverySelection.takePlaybackRequest({sourceType:'stalker',playlistId,contentKind:'series',providerItemId:itemId}) : null;
            if (request?.episode) {
                const target = request.episode;
                const season = seasons.find(season => { const number=this.readText(season,'season_number','season'); return number.trim() !== '' && Number(number) === target.seasonNumber; });
                if (!season) { this.playbackError.set('This version does not contain the same season.'); return; }
                await this.selectSeason(season);
                if (requestVersion !== this.detailRequestVersion() || ownerId !== this.store.currentPlaylist()?._id || this.item() !== item) return;
                const episode = this.episodes().find(episode => Number(this.readText(episode,'episode_num','episode_number')) === target.episodeNumber);
                if (episode) await this.playEpisode(episode);
                else this.playbackError.set('This version does not contain the same episode.');
            } else await this.selectSeason(seasons[0]);
        } else {
            const playlistId = this.store.currentPlaylist()?._id;
            if (playlistId && this.discoverySelection.takePlaybackRequest({sourceType:'stalker',playlistId,contentKind:'vod',providerItemId:itemId})) await this.playMovie();
        }
    }

    private async play(item: StalkerCatalogRow): Promise<void> {
        const owner = this.item();
        if (!owner) return;

        this.invalidatePlaybackRequest();
        const requestGeneration = this.playbackRequestGeneration;
        const controller = new AbortController();
        this.playbackRequestController = controller;
        const playlist = this.store.currentPlaylist();
        const selectedContentType = this.contentType();
        const detailRequestVersion = this.detailRequestVersion();
        const selectedSeasonId = this.selectedSeasonId();
        const ownerId = this.entityId(
            owner.movie_id ?? owner.series_id ?? owner.id ?? owner.stream_id
        );
        const isCurrentRequest = (): boolean => {
            const currentOwner = this.item();
            const currentOwnerId = this.entityId(
                currentOwner?.movie_id ?? currentOwner?.series_id ?? currentOwner?.id ?? currentOwner?.stream_id
            );
            const stillOwnsDetail = currentOwner === owner ||
                (ownerId !== '' && currentOwnerId === ownerId);
            return !controller.signal.aborted &&
                this.playbackRequestController === controller &&
                this.playbackRequestGeneration === requestGeneration &&
                this.detailRequestVersion() === detailRequestVersion &&
                this.selectedSeasonId() === selectedSeasonId &&
                stillOwnsDetail;
        };
        this.playbackError.set(null);
        try {
            const playback = await this.store.resolveItvPlayback(
                item,
                false,
                controller.signal,
                { playlist, selectedContentType },
            );
            if (!isCurrentRequest()) return;
            const displayPlayback = selectedContentType === 'series'
                ? { ...playback, title: this.seriesEpisodePlaybackTitle(item, playback.title) }
                : playback;
            this.activePlayback.set(displayPlayback);
            void this.portalPlayer.openResolvedPlayback(displayPlayback, true, {
                ...createStalkerPlaybackRecoveryContext(displayPlayback, async ({ signal }) => {
                    const recovered = await this.store.resolveItvPlayback(item, false, signal, {
                        playlist,
                        selectedContentType,
                    });
                    return selectedContentType === 'series'
                        ? { ...recovered, title: this.seriesEpisodePlaybackTitle(item, recovered.title) }
                        : recovered;
                }),
            });
        } catch (cause) {
            if (!isCurrentRequest()) return;
            this.playbackError.set(
                cause instanceof Error ? cause.message : 'Unable to play this item'
            );
        }
    }

    private invalidatePlaybackRequest(): void {
        this.playbackRequestGeneration += 1;
        this.playbackRequestController?.abort();
        this.playbackRequestController = null;
    }

    private async loadSeasonEpisodeMetadata(
        item: StalkerCatalogRow,
        season: StalkerCatalogRow,
        episodes: StalkerCatalogRow[],
        ownerId: string,
        seasonId: string,
        requestVersion: number,
    ): Promise<void> {
        const tmdbId = this.readTmdbId(item);
        const seasonNumber = this.resolveTmdbSeasonNumber(item, season, episodes);
        if (tmdbId === null || seasonNumber === null) return;

        const cacheKey = this.seasonEpisodeMetadataKey(
            ownerId,
            tmdbId,
            seasonId,
            seasonNumber,
        );
        const cached = this.seasonEpisodeMetadataCache.get(cacheKey);
        if (cached) {
            if (this.isCurrentSeasonSelection(item, ownerId, seasonId, requestVersion)) {
                this.seasonEpisodeMetadata.set(cached);
            }
            return;
        }

        let pending = this.pendingSeasonEpisodeMetadata.get(cacheKey);
        if (!pending) {
            pending = this.tmdbEnrichment
                .getSeason(tmdbId, seasonNumber)
                .then((details) => details?.episodes ?? null)
                .catch(() => null);
            this.pendingSeasonEpisodeMetadata.set(cacheKey, pending);
            void pending.finally(() => {
                if (this.pendingSeasonEpisodeMetadata.get(cacheKey) === pending) {
                    this.pendingSeasonEpisodeMetadata.delete(cacheKey);
                }
            });
        }

        const tmdbEpisodes = await pending;
        if (!tmdbEpisodes) return;
        this.seasonEpisodeMetadataCache.set(cacheKey, tmdbEpisodes);
        if (this.isCurrentSeasonSelection(item, ownerId, seasonId, requestVersion)) {
            this.seasonEpisodeMetadata.set(tmdbEpisodes);
        }
    }

    private isCurrentSeasonSelection(
        item: StalkerCatalogRow,
        ownerId: string,
        seasonId: string,
        requestVersion: number,
    ): boolean {
        const currentItem = this.item();
        const currentId = this.entityId(
            currentItem?.movie_id ?? currentItem?.series_id ?? currentItem?.id ?? currentItem?.stream_id
        );
        return this.detailRequestVersion() === requestVersion &&
            this.selectedSeasonId() === seasonId &&
            (currentItem === item || (ownerId !== '' && currentId === ownerId));
    }

    private seasonEpisodeMetadataKey(
        ownerId: string,
        tmdbId: number,
        seasonId: string,
        seasonNumber: number,
    ): string {
        return `${ownerId}|${tmdbId}|${seasonId}|${seasonNumber}`;
    }

    private readTmdbId(item: StalkerCatalogRow): number | null {
        const value = Number(this.readNestedText(item, 'tmdb_id'));
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    private resolveTmdbSeasonNumber(
        item: StalkerCatalogRow | null,
        season: StalkerCatalogRow,
        episodes: readonly StalkerCatalogRow[],
    ): number | null {
        const explicitValues: unknown[] = [
            episodes[0]?.['season_number'],
            episodes[0]?.['season'],
            season['season_number'],
            season['series_number'],
            season['season'],
        ];
        let providerSeasonNumber: number | null = null;
        for (const value of explicitValues) {
            const normalized = String(value ?? '').trim();
            if (!normalized) continue;
            const number = Number(normalized);
            if (Number.isInteger(number) && number >= 0) {
                providerSeasonNumber = number;
                break;
            }
        }

        if (providerSeasonNumber === null) {
            const label = this.readText(season, 'name', 'title', 'o_name');
            const marker = label.match(/^(?:season|series)\s*#?\s*0*(\d+)\b/i) ??
                label.match(/^\s*0*(\d+)\s*$/);
            if (marker) providerSeasonNumber = Number(marker[1]);
        }

        if (providerSeasonNumber === null) {
            const index = this.seasons().findIndex(
                (candidate) => this.seasonId(candidate) === this.seasonId(season)
            );
            if (index >= 0) providerSeasonNumber = index + 1;
        }
        if (providerSeasonNumber === null) return null;

        return resolveEnrichmentSeasonNumber({
            rawTitle: this.readNestedText(item, 'o_name', 'name', 'title'),
            providerSeasonNumber,
            providerSeasonCount: this.seasons().length,
        });
    }

    private readEpisodeNumber(episode: StalkerCatalogRow): number | null {
        const number = Number(
            this.readText(episode, 'episode_num', 'series_number', 'episode_number')
        );
        return Number.isInteger(number) && number > 0 ? number : null;
    }

    private isMeaningfulEpisodeTitle(title: string): boolean {
        const normalized = title.trim();
        return normalized !== '' &&
            !/^(?:episode|ep)\s*0*\d+$/i.test(normalized) &&
            !/^\d+$/.test(normalized) &&
            !/^s\d{1,2}\s*e\d{1,3}$/i.test(normalized);
    }

    private episodeDisplayName(
        episode: StalkerCatalogRow,
        episodeNumber: number,
    ): string {
        for (const key of ['o_name', 'name', 'title']) {
            const providerTitle = this.readText(episode, key);
            if (this.isMeaningfulEpisodeTitle(providerTitle)) return providerTitle;
        }
        return this.seasonEpisodeMetadata().find(
            (candidate) => candidate.episode_number === episodeNumber
        )?.name?.trim() ?? '';
    }

    private seriesEpisodePlaybackTitle(
        episode: StalkerCatalogRow,
        _fallbackTitle: string,
    ): string {
        const item = this.item();
        const episodeNumber = this.readEpisodeNumber(episode);
        if (!item || episodeNumber === null) return _fallbackTitle;

        const season = this.selectedSeason();
        const seasonNumber = season
            ? this.resolveTmdbSeasonNumber(item, season, [episode])
            : this.resolveTmdbSeasonNumber(item, episode, [episode]);
        if (seasonNumber === null) return _fallbackTitle;

        const episodeCode = `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
        const seriesName = this.readText(item, 'o_name', 'name', 'title');
        const episodeName = this.episodeDisplayName(episode, episodeNumber);
        return [seriesName, episodeCode, episodeName].filter(Boolean).join(' · ');
    }

    private matchesId(item: StalkerCatalogRow | null, requestedId: string): boolean {
        if (!item) return false;
        const requested = this.entityId(requestedId);
        return this.entityId(
            item.movie_id ?? item.series_id ?? item.id ?? item.stream_id
        ) === requested;
    }

    private entityId(value: unknown): string {
        return String(value ?? '').split(':')[0].trim();
    }

    private seasonId(season: StalkerCatalogRow): string {
        return String(season['season_id'] ?? season.id ?? '').trim();
    }

    private readText(item: StalkerCatalogRow | null, ...keys: string[]): string {
        if (!item) return '';
        for (const key of keys) {
            const value = item[key];
            if (value !== null && value !== undefined && String(value).trim()) {
                return String(value).trim();
            }
        }
        return '';
    }

    private readNestedText(
        item: StalkerCatalogRow | null,
        ...keys: string[]
    ): string {
        const direct = this.readText(item, ...keys);
        if (direct) return direct;
        const info = item?.['info'];
        if (!info || typeof info !== 'object') return '';
        for (const key of keys) {
            const value = (info as Record<string, unknown>)[key];
            if (value !== null && value !== undefined && String(value).trim()) {
                return String(value).trim();
            }
        }
        return '';
    }

    private resolveArtwork(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) return '';

        const artwork = value.trim();
        if (/^(?:https?:|data:|blob:)/i.test(artwork)) return artwork;

        const portalUrl = this.store.currentPlaylist()?.portalUrl;
        if (!portalUrl) return artwork;

        try {
            return new URL(artwork, portalUrl).toString();
        } catch {
            return artwork;
        }
    }
}

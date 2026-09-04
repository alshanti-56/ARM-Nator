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
import { UpperCasePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { combineLatest } from 'rxjs';
import { MatIcon } from '@angular/material/icon';
import { TranslateModule } from '@ngx-translate/core';
import { SafePipe } from '@arm-nator/pipes';
import {
    DetailActionsTemplateDirective,
    DetailMetaTemplateDirective,
    DetailTagsTemplateDirective,
    PortalDetailShellComponent,
} from '@arm-nator/ui/components';
import {
    PORTAL_PLAYER as PORTAL_PLAYER_TOKEN,
} from '@arm-nator/providers/shared/util';
import {
    StalkerCatalogRow,
    StalkerContentType,
    StalkerStore,
} from '@arm-nator/providers/stalker/data-access';
import {
    isStalkerSeriesFlag,
    ResolvedPortalPlayback,
    TmdbEnrichedCastMember,
    youtubeEmbedUrl,
} from '@arm-nator/shared/interfaces';

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
        TranslateModule,
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
    private readonly destroyRef = inject(DestroyRef);
    private readonly portalPlayer = inject(PORTAL_PLAYER_TOKEN);

    readonly contentType = signal<DetailContentType>('vod');
    readonly item = this.store.selectedItem;
    readonly seasons = this.store.seriesSeasons;
    readonly episodes = this.store.seriesEpisodes;
    readonly seasonsLoading = this.store.isSeriesSeasonsLoading;
    readonly episodesLoading = this.store.isSeriesEpisodesLoading;
    readonly detailLoading = signal(true);
    readonly detailError = signal<string | null>(null);
    readonly playbackError = signal<string | null>(null);
    readonly selectedSeasonId = signal<string | null>(null);
    readonly activePlayback = signal<ResolvedPortalPlayback | null>(null);
    private readonly requestedItemId = signal<string | null>(null);
    private readonly detailRequestVersion = signal(0);

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
        effect(() => {
            const playlist = this.store.currentPlaylist();
            const itemId = this.requestedItemId();
            const requestVersion = this.detailRequestVersion();
            if (playlist && itemId) {
                untracked(() => void this.loadItem(itemId, requestVersion));
            }
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
                this.contentType.set(contentType);
                this.detailLoading.set(true);
                this.detailError.set(null);
                this.playbackError.set(null);
                this.selectedSeasonId.set(null);
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

        const seasonId = this.seasonId(season);
        this.selectedSeasonId.set(seasonId);
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
        ]);
    }

    seasonLabel(season: StalkerCatalogRow): string {
        return (
            this.readText(season, 'name', 'title', 'o_name') ||
            `Season ${this.readText(season, 'season_number', 'id')}`
        );
    }

    episodeLabel(episode: StalkerCatalogRow, index: number): string {
        const number = this.readText(episode, 'episode_num', 'series_number');
        const name = this.readText(episode, 'o_name', 'name', 'title');
        return number ? `Episode ${number}${name ? ` · ${name}` : ''}` : name || `Episode ${index + 1}`;
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

        const current = this.store.getPaginatedContent().find((row) =>
            this.matchesId(row, itemId)
        );
        const selected = this.store.selectedItem();
        const item = this.matchesId(selected, itemId)
            ? selected
            : current ?? (await this.store.loadContentItem(this.contentType(), itemId));

        if (requestVersion !== this.detailRequestVersion()) return;

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
                this.item() !== item ||
                seasons.length === 0
            ) {
                return;
            }
            await this.selectSeason(seasons[0]);
        }
    }

    private async play(item: StalkerCatalogRow): Promise<void> {
        this.playbackError.set(null);
        try {
            const playback = await this.store.resolveItvPlayback(item);
            this.activePlayback.set(playback);
            void this.portalPlayer.openResolvedPlayback(playback, true);
        } catch (cause) {
            this.playbackError.set(
                cause instanceof Error ? cause.message : 'Unable to play this item'
            );
        }
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

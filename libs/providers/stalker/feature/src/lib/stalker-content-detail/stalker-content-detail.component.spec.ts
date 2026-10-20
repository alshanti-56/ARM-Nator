import { Location } from '@angular/common';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DiscoverySelectionService, PORTAL_PLAYER } from '@arm-nator/providers/shared/util';
import { StalkerCatalogRow, StalkerStore } from '@arm-nator/providers/stalker/data-access';
import { TmdbEnrichmentService } from '@arm-nator/services';
import { ResolvedPortalPlayback } from '@arm-nator/shared/interfaces';
import { NEVER } from 'rxjs';
import { StalkerContentDetailComponent } from './stalker-content-detail.component';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('StalkerContentDetailComponent episode playback', () => {
    let fixture: ComponentFixture<StalkerContentDetailComponent>;
    let parentItem: StalkerCatalogRow;
    let selectedItem: WritableSignal<StalkerCatalogRow | null>;
    let resolveItvPlayback: jest.Mock;
    let loadSeriesEpisodes: jest.Mock;
    let openResolvedPlayback: jest.Mock;
    let getSeason: jest.Mock;
    let seriesSeasons: WritableSignal<StalkerCatalogRow[]>;
    let seriesEpisodes: WritableSignal<StalkerCatalogRow[]>;

    beforeEach(async () => {
        parentItem = { id: '69944', series_id: '69944', name: 'Suits', info: { tmdb_id: 42 } } as StalkerCatalogRow;
        selectedItem = signal(parentItem);
        seriesSeasons = signal([]);
        seriesEpisodes = signal([]);
        resolveItvPlayback = jest.fn();
        loadSeriesEpisodes = jest.fn().mockImplementation(async () => {
            seriesEpisodes.set([]);
            return [];
        });
        openResolvedPlayback = jest.fn();
        getSeason = jest.fn().mockResolvedValue(null);

        await TestBed.configureTestingModule({
            imports: [StalkerContentDetailComponent],
            providers: [
                {
                    provide: StalkerStore,
                    useValue: {
                        selectedItem,
                        currentPlaylist: signal({ _id: 'stalker-one' }),
                        seriesSeasons,
                        seriesEpisodes,
                        isSeriesSeasonsLoading: signal(false),
                        isSeriesEpisodesLoading: signal(false),
                        seriesLoadError: signal(null),
                        loadSeriesEpisodes,
                        resolveItvPlayback,
                    },
                },
                {
                    provide: ActivatedRoute,
                    useValue: { data: NEVER, paramMap: NEVER, parent: null },
                },
                { provide: Router, useValue: { navigate: jest.fn(), navigateByUrl: jest.fn() } },
                { provide: Location, useValue: { getState: jest.fn(() => ({})) } },
                { provide: PORTAL_PLAYER, useValue: { openResolvedPlayback } },
                { provide: DiscoverySelectionService, useValue: {} },
                { provide: TmdbEnrichmentService, useValue: { getSeason } },
            ],
        })
            .overrideComponent(StalkerContentDetailComponent, {
                set: { template: '', imports: [] },
            })
            .compileComponents();

        fixture = TestBed.createComponent(StalkerContentDetailComponent);
        fixture.componentInstance.contentType.set('series');
        fixture.detectChanges();
    });

    afterEach(() => fixture.destroy());

    it('plays an episode even though the selected store item is its parent series', async () => {
        resolveItvPlayback.mockResolvedValue({
            streamUrl: 'https://portal.example/episode-1',
            title: 'Suits · S01E01',
            isLive: false,
        } satisfies ResolvedPortalPlayback);

        const episode = { id: 'episode-1', series_id: '69944', name: 'Pilot' } as StalkerCatalogRow;
        await fixture.componentInstance.playEpisode(episode);

        expect(resolveItvPlayback).toHaveBeenCalledWith(
            episode,
            false,
            expect.any(AbortSignal),
            expect.objectContaining({ selectedContentType: 'series' })
        );
        expect(openResolvedPlayback).toHaveBeenCalledTimes(1);
        expect(fixture.componentInstance.activePlayback()?.title).toBe('Suits · S01E01');
    });

    it('discards a pending episode resolve after the user changes seasons', async () => {
        const pending = deferred<ResolvedPortalPlayback>();
        resolveItvPlayback.mockReturnValue(pending.promise);
        fixture.componentInstance.selectedSeasonId.set('season-1');
        const episode = { id: 'episode-1', series_id: '69944', name: 'Pilot' } as StalkerCatalogRow;

        const start = fixture.componentInstance.playEpisode(episode);
        const resolveSignal = resolveItvPlayback.mock.calls[0][2] as AbortSignal;
        await fixture.componentInstance.selectSeason({ id: 'season-2', season_id: 'season-2' } as StalkerCatalogRow);
        pending.resolve({ streamUrl: 'https://portal.example/episode-1', title: 'Suits · S01E01', isLive: false });
        await start;

        expect(resolveSignal.aborted).toBe(true);
        expect(openResolvedPlayback).not.toHaveBeenCalled();
        expect(loadSeriesEpisodes).toHaveBeenCalledTimes(1);
        expect(fixture.componentInstance.selectedSeasonId()).toBe('season-2');
    });

    it('discards a pending episode resolve when the selected parent changes', async () => {
        const pending = deferred<ResolvedPortalPlayback>();
        resolveItvPlayback.mockReturnValue(pending.promise);
        const episode = { id: 'episode-1', series_id: '69944', name: 'Pilot' } as StalkerCatalogRow;

        const start = fixture.componentInstance.playEpisode(episode);
        selectedItem.set({ id: 'another-series', series_id: 'another-series' } as StalkerCatalogRow);
        pending.resolve({ streamUrl: 'https://portal.example/episode-1', title: 'Suits · S01E01', isLive: false });
        await start;

        expect(openResolvedPlayback).not.toHaveBeenCalled();
    });

    it('normalizes numeric season ids and suppresses duplicate generic episode names', () => {
        fixture.componentInstance.selectedSeasonId.set('2');

        expect(fixture.componentInstance.isSelectedSeason({ id: 2 } as StalkerCatalogRow)).toBe(true);
        expect(fixture.componentInstance.seasonLabel({ name: '2' } as StalkerCatalogRow)).toBe('Season 2');
        expect(fixture.componentInstance.seasonLabel({ season_number: 0 } as StalkerCatalogRow)).toBe('Season 0');
        expect(fixture.componentInstance.episodeLabel({
            episode_num: 1,
            o_name: 'Episode 1',
            name: 'Episode1',
        } as StalkerCatalogRow, 0)).toBe('Episode 1');
    });

    it('uses TMDB episode titles for generic provider names and adds SxxEyy to playback', async () => {
        const season = { id: 'season-id-2', name: 'Season 2', season_number: 2 } as StalkerCatalogRow;
        const episode = {
            id: 'episode-2',
            series_id: '69944',
            season_number: 2,
            episode_num: 2,
            name: 'Episode 2',
            o_name: 'Episode 2',
            cmd: 'provider-command',
        } as StalkerCatalogRow;
        seriesSeasons.set([season]);
        loadSeriesEpisodes.mockImplementation(async () => {
            seriesEpisodes.set([episode]);
            return [episode];
        });
        getSeason.mockResolvedValue({
            season_number: 2,
            episodes: [{ episode_number: 2, name: 'The One With the Metadata' }],
        });

        await fixture.componentInstance.selectSeason(season);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(getSeason).toHaveBeenCalledWith(42, 2);
        expect(fixture.componentInstance.episodeLabel(episode, 0)).toBe('Episode 2 · The One With the Metadata');

        resolveItvPlayback.mockResolvedValue({
            streamUrl: 'https://portal.example/episode-2',
            title: 'Suits - Episode 2',
            isLive: false,
        } satisfies ResolvedPortalPlayback);
        await fixture.componentInstance.playEpisode(episode);

        expect(resolveItvPlayback.mock.calls[0][0]).toBe(episode);
        expect(openResolvedPlayback.mock.calls[0][0].title).toBe('Suits · S02E02 · The One With the Metadata');
    });

    it('loads titles when the series TMDB identity arrives after the episode list', async () => {
        selectedItem.set({ ...parentItem, info: undefined });
        const season = { id: 'season-2', name: 'Season 2', season_number: 2 } as StalkerCatalogRow;
        const episode = { id: 'episode-1', episode_num: 1, name: 'Episode 1' } as StalkerCatalogRow;
        seriesSeasons.set([season]);
        loadSeriesEpisodes.mockImplementation(async () => {
            seriesEpisodes.set([episode]);
            return [episode];
        });
        getSeason.mockResolvedValue({ episodes: [{ episode_number: 1, name: 'She Knows' }] });
        await fixture.componentInstance.selectSeason(season);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(getSeason).not.toHaveBeenCalled();

        selectedItem.set(parentItem);
        fixture.detectChanges();
        await fixture.whenStable();
        expect(getSeason).toHaveBeenCalledWith(42, 2);
        expect(fixture.componentInstance.episodeLabel(episode, 0)).toBe('Episode 1 · She Knows');
    });

    it('keeps late season metadata from replacing the currently selected season', async () => {
        const seasonOne = { id: 'provider-season-1', name: 'Season 1', season_number: 1 } as StalkerCatalogRow;
        const seasonTwo = { id: 'provider-season-2', name: 'Season 2', season_number: 2 } as StalkerCatalogRow;
        const seasonOneRequest = deferred<{ season_number: number; episodes: { episode_number: number; name: string }[] } | null>();
        const seasonTwoRequest = deferred<{ season_number: number; episodes: { episode_number: number; name: string }[] } | null>();
        seriesSeasons.set([seasonOne, seasonTwo]);
        loadSeriesEpisodes.mockImplementation(async (_item: StalkerCatalogRow, season: StalkerCatalogRow) => {
            const episode = {
                id: `episode-${season['season_number']}`,
                season_number: season['season_number'],
                episode_num: 1,
                name: 'Episode 1',
            } as StalkerCatalogRow;
            seriesEpisodes.set([episode]);
            return [episode];
        });
        getSeason.mockReturnValueOnce(seasonOneRequest.promise).mockReturnValueOnce(seasonTwoRequest.promise);

        await fixture.componentInstance.selectSeason(seasonOne);
        fixture.detectChanges();
        await fixture.whenStable();
        await fixture.componentInstance.selectSeason(seasonTwo);
        fixture.detectChanges();
        await fixture.whenStable();
        seasonOneRequest.resolve({ season_number: 1, episodes: [{ episode_number: 1, name: 'Season One Title' }] });
        fixture.detectChanges();
        await fixture.whenStable();

        const seasonTwoEpisode = seriesEpisodes()[0];
        expect(fixture.componentInstance.episodeLabel(seasonTwoEpisode, 0)).toBe('Episode 1');

        seasonTwoRequest.resolve({ season_number: 2, episodes: [{ episode_number: 1, name: 'Season Two Title' }] });
        fixture.detectChanges();
        await fixture.whenStable();
        expect(fixture.componentInstance.episodeLabel(seasonTwoEpisode, 0)).toBe('Episode 1 · Season Two Title');
    });
});

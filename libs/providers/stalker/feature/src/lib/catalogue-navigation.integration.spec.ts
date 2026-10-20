import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, NavigationStart, Router } from '@angular/router';
import { provideTranslateService } from '@ngx-translate/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { CategoryContentViewComponent } from '@arm-nator/providers/catalog/feature';
import { CatalogueNavigationStateService, PORTAL_CATALOG_FACADE, PORTAL_PLAYER } from '@arm-nator/providers/shared/util';
import { StalkerStore } from '@arm-nator/providers/stalker/data-access';
import { UiPerformanceService } from '@arm-nator/services';
import { StalkerLiveStreamLayoutComponent } from './stalker-live-stream-layout/stalker-live-stream-layout.component';

const query = (value: Record<string, string>) => new BehaviorSubject(convertToParamMap(value));

describe('catalogue navigation render restoration', () => {
    afterEach(() => TestBed.resetTestingModule());

    it('restores Xtream filters and page before restoring scroll after loading ends', async () => {
        const events = new Subject<unknown>();
        const router = { url: '/workspace/xtreams/source/vod?q=Matrix&page=3', events, navigate: jest.fn() };
        const route = { paramMap: query({}), queryParamMap: query({ q: 'Matrix', page: '3' }) };
        const loading = signal(true);
        const page = signal(0), limit = signal(25), sort = signal('date-desc'), rating = signal<number | null>(null), genre = signal<string | null>(null), year = signal<number | null>(null);
        const resetPage = () => page.set(0);
        const catalog = {
            provider: 'xtream', supportsRatingSort: true, pageSizeOptions: [10, 25, 50, 100],
            contentType: signal('vod'), limit, pageIndex: page, selectedCategory: signal({ name: 'Movies' }),
            paginatedContent: signal([]), selectedItem: signal(null), totalPages: signal(4), isPaginatedContentLoading: loading,
            selectedCategoryTitle: signal('Movies'), categoryItemCount: signal(100), contentSortMode: sort,
            minRating: rating, genreFilter: genre, yearFilter: year, availableGenres: signal(['Drama']), availableYears: signal([2024]),
            initialize: jest.fn(), setSearchQuery: resetPage, setPage: (value: number) => page.set(value),
            setLimit: (value: number) => { limit.set(value); resetPage(); },
            setContentSortMode: (value: string) => { sort.set(value); resetPage(); },
            setMinRating: (value: number | null) => { rating.set(value); resetPage(); },
            setGenreFilter: (value: string | null) => { genre.set(value); resetPage(); },
            setYearFilter: (value: number | null) => { year.set(value); resetPage(); },
            getItemProgress: () => ({}), selectItem: () => ['20', '2001'],
        };
        await TestBed.configureTestingModule({ imports: [CategoryContentViewComponent], providers: [
            ...provideTranslateService(), { provide: Router, useValue: router }, { provide: ActivatedRoute, useValue: route },
            { provide: PORTAL_CATALOG_FACADE, useValue: catalog }, { provide: UiPerformanceService, useValue: { painted: jest.fn() } },
        ] }).overrideComponent(CategoryContentViewComponent, { set: { template: '<app-grid-list />', imports: [], schemas: [CUSTOM_ELEMENTS_SCHEMA] } }).compileComponents();
        TestBed.inject(CatalogueNavigationStateService).save(router.url, { scrollTop: 420, limit: 50, sortMode: 'name-asc', minRating: 7, genreFilter: 'Drama', yearFilter: 2024 });
        const fixture = TestBed.createComponent(CategoryContentViewComponent);
        fixture.detectChanges();
        expect([page(), limit(), sort(), rating(), genre(), year()]).toEqual([2, 50, 'name-asc', 7, 'Drama', 2024]);
        const grid = fixture.nativeElement.querySelector('app-grid-list');
        expect(grid.scrollTop).toBe(0);
        loading.set(false); fixture.detectChanges();
        expect(grid.scrollTop).toBe(420);
        fixture.componentInstance.onItemClick({ xtream_id: 2001, category_id: 20 });
        expect(router.navigate).toHaveBeenCalledWith(['20', '2001'], expect.objectContaining({ state: { catalogueOrigin: router.url }, queryParamsHandling: 'preserve' }));
    });

    it('retains the Stalker render window, sort, query and offset on a detail round trip', async () => {
        const events = new Subject<unknown>();
        const router = { url: '/workspace/stalker/source/vod/movies?q=Fixture', events, navigate: jest.fn().mockResolvedValue(true) };
        const route = { data: new BehaviorSubject({ contentType: 'vod' }), paramMap: query({ categoryId: 'movies' }), queryParamMap: query({ q: 'Fixture' }), snapshot: { queryParamMap: convertToParamMap({ q: 'Fixture' }) }, parent: { snapshot: { paramMap: convertToParamMap({ id: 'source' }) } } };
        const store = {
            currentPlaylist: signal({ _id: 'source' }), getCategoryResource: signal([]), getPaginatedContent: signal([{ id: 'movie-A', name: 'Fixture', category_id: 'movies' }]),
            isPaginatedContentLoading: signal(false), hasMoreContent: signal(false), totalContentItems: signal(1), loadError: signal(null), selectedCategoryId: signal('movies'),
            setSelectedContentType: jest.fn(), setSelectedCategory: jest.fn(), preloadItvChannels: jest.fn(), preloadSelectedContent: jest.fn(), setSearchPhrase: jest.fn(), setSelectedItem: jest.fn(),
        };
        await TestBed.configureTestingModule({ imports: [StalkerLiveStreamLayoutComponent], providers: [
            ...provideTranslateService(), { provide: Router, useValue: router }, { provide: ActivatedRoute, useValue: route },
            { provide: StalkerStore, useValue: store }, { provide: PORTAL_PLAYER, useValue: {} },
        ] }).overrideComponent(StalkerLiveStreamLayoutComponent, { set: { template: '<div class="stalker-list"></div>', imports: [] } }).compileComponents();
        const memory = TestBed.inject(CatalogueNavigationStateService).stalkerLists;
        memory.save(router.url, { scrollTop: 410, visibleLimit: 150, viewMode: 'list', sortMode: 'name-desc' });
        const fixture = TestBed.createComponent(StalkerLiveStreamLayoutComponent);
        fixture.detectChanges();
        const component = fixture.componentInstance;
        expect([component.visibleLimit(), component.viewMode(), component.sortMode(), component.search()]).toEqual([150, 'list', 'name-desc', 'Fixture']);
        expect(fixture.nativeElement.querySelector('.stalker-list').scrollTop).toBe(410);
        fixture.nativeElement.querySelector('.stalker-list').scrollTop = 510;
        events.next(new NavigationStart(2, '/workspace/stalker/source/vod/movies/movie-A'));
        expect(memory.read(router.url)?.scrollTop).toBe(510);
        await component.play({ id: 'movie-A', name: 'Fixture', category_id: 'movies' });
        expect(router.navigate).toHaveBeenCalledWith(['/workspace/stalker', 'source', 'vod', 'movies', 'movie-A'], { queryParamsHandling: 'preserve', state: { catalogueOrigin: router.url } });
    });
});

describe('discovery live navigation ownership',()=>{
 afterEach(()=>{jest.restoreAllMocks();TestBed.resetTestingModule();});
 it.each(['source','other'])('opens only a live selection owned by the route source (%s)',async selectedSource=>{
  const row={id:'opaque-live',name:'Fixture channel',cmd:'ffmpeg http://fixture.invalid/live'};
  const router={url:'/workspace/stalker/source/itv/20',events:new Subject<unknown>(),navigate:jest.fn(),currentNavigation:signal({extras:{state:{openStalkerDiscoveryItem:{playlistId:selectedSource,providerItemId:'opaque-live',row}}}})};
  const route={data:new BehaviorSubject({contentType:'itv'}),paramMap:query({categoryId:'20'}),queryParamMap:query({}),snapshot:{queryParamMap:convertToParamMap({})},parent:{snapshot:{paramMap:convertToParamMap({id:'source'})}}};
  const currentPlaylist=signal<{_id:string}|undefined>(undefined);
  const store={currentPlaylist,getCategoryResource:signal([]),getPaginatedContent:signal([]),isPaginatedContentLoading:signal(false),hasMoreContent:signal(false),totalContentItems:signal(0),loadError:signal(null),selectedCategoryId:signal('20'),setSelectedContentType:jest.fn(),setSelectedCategory:jest.fn(),preloadItvChannels:jest.fn(),preloadSelectedContent:jest.fn(),setSearchPhrase:jest.fn(),setSelectedItem:jest.fn()};
  const play=jest.spyOn(StalkerLiveStreamLayoutComponent.prototype,'play').mockResolvedValue(undefined);
  await TestBed.configureTestingModule({imports:[StalkerLiveStreamLayoutComponent],providers:[...provideTranslateService(),{provide:Router,useValue:router},{provide:ActivatedRoute,useValue:route},{provide:StalkerStore,useValue:store},{provide:PORTAL_PLAYER,useValue:{}}]}).overrideComponent(StalkerLiveStreamLayoutComponent,{set:{template:'',imports:[]}}).compileComponents();
  const fixture=TestBed.createComponent(StalkerLiveStreamLayoutComponent);fixture.detectChanges();expect(play).not.toHaveBeenCalled();
  currentPlaylist.set({_id:'source'});fixture.detectChanges();
  expect(play).toHaveBeenCalledTimes(selectedSource==='source'?1:0);
  if(selectedSource==='source')expect(play).toHaveBeenCalledWith(row);
  fixture.detectChanges();expect(play).toHaveBeenCalledTimes(selectedSource==='source'?1:0);
 });
});

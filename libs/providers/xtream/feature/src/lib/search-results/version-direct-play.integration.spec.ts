import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router, NavigationStart } from '@angular/router';
import { BehaviorSubject, Subject } from 'rxjs';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatDialog } from '@angular/material/dialog';
import { TranslateService } from '@ngx-translate/core';
import { XtreamStore } from '@arm-nator/providers/xtream/data-access';
import { DiscoverySelectionService } from '@arm-nator/providers/shared/util';
import { CrossPortalSimilarService, SettingsStore } from '@arm-nator/services';
import { VodDetailsRouteComponent } from '../vod-details/vod-details-route.component';
import { VodDetailsPlaybackService } from '../vod-details/vod-details-playback.service';
import type { DiscoveryVersion } from '@arm-nator/shared/interfaces';
const version:DiscoveryVersion={identity:{sourceType:'xtream',playlistId:'p',contentKind:'vod',providerItemId:'2'},providerName:'Fixture',contentType:'movie',originalTitle:'Movie',categoryId:'42',navigation:['/workspace/xtreams','p','vod','42','2']};
async function setup(){
 const params=new BehaviorSubject({vodId:'2',categoryId:'42'}),events=new Subject<unknown>();
 const store={currentPlaylist:signal({id:'p'}),selectedItem:signal<unknown>(null),isLoadingDetails:signal(true),detailsError:signal(null),isFavorite:signal(false),vodStreams:signal([]),vodCategories:signal([]),fetchVodDetailsWithMetadata:jest.fn(),checkFavoriteStatus:jest.fn(),setSelectedItem:jest.fn(),backfillContentBackdrop:jest.fn()};
 const playback={bind:jest.fn(),closeInlinePlayer:jest.fn(),loadPosition:jest.fn(),playVod:jest.fn(),inlinePlayback:signal(null),vodPlaybackPosition:signal(null),matchedExternalPlayback:signal(null),externalPrimaryLabel:signal(null),externalPrimaryIcon:signal(null),isExternalLaunchPending:signal(false),isExternalStopAction:signal(false),externalPrimaryButtonState:signal('idle'),vodPlaybackProgress:signal(0),hasPlaybackPosition:signal(false)};
 TestBed.configureTestingModule({imports:[VodDetailsRouteComponent],providers:[DiscoverySelectionService,{provide:XtreamStore,useValue:store},{provide:SettingsStore,useValue:{theme:signal('dark-theme')}},{provide:CrossPortalSimilarService,useValue:{}},{provide:MatSnackBar,useValue:{open:jest.fn()}},{provide:MatDialog,useValue:{}},{provide:TranslateService,useValue:{}},{provide:Location,useValue:{getState:()=>({})}},{provide:ActivatedRoute,useValue:{params,snapshot:{params:params.value}}},{provide:Router,useValue:{events,createUrlTree:(v:unknown)=>v,serializeUrl:()=>'/workspace/xtreams/p/vod/42/2'}}]});
 TestBed.overrideComponent(VodDetailsRouteComponent,{set:{template:'',providers:[{provide:VodDetailsPlaybackService,useValue:playback}]}});
 const fixture=TestBed.createComponent(VodDetailsRouteComponent),selection=TestBed.inject(DiscoverySelectionService);
 fixture.detectChanges();await fixture.whenStable();
 return {fixture,selection,store,playback,events};
}
afterEach(()=>TestBed.resetTestingModule());
it('selecting a version starts it once its own metadata loads, without a Play click',async()=>{
 const h=await setup();h.selection.requestPlayback(version);h.store.selectedItem.set({stream_id:'1',movie_data:{stream_id:1},info:{name:'Old'}});h.store.isLoadingDetails.set(false);h.fixture.detectChanges();await h.fixture.whenStable();expect(h.playback.playVod).not.toHaveBeenCalled();
 const item={stream_id:'2',movie_data:{stream_id:2},info:{name:'New'}};h.store.selectedItem.set(item);h.fixture.detectChanges();await h.fixture.whenStable();expect(h.playback.playVod).toHaveBeenCalledTimes(1);expect(h.playback.playVod).toHaveBeenCalledWith(item);
 h.store.selectedItem.set({...item,info:{name:'Enriched'}});h.fixture.detectChanges();await h.fixture.whenStable();expect(h.playback.playVod).toHaveBeenCalledTimes(1);
});
it('ordinary details visits and navigation away never trigger a stale version playback',async()=>{
 const h=await setup();h.store.selectedItem.set({stream_id:'2',movie_data:{stream_id:2},info:{name:'Movie'}});h.store.isLoadingDetails.set(false);h.fixture.detectChanges();await h.fixture.whenStable();expect(h.playback.playVod).not.toHaveBeenCalled();
 h.selection.requestPlayback(version);h.events.next(new NavigationStart(5,'/workspace/dashboard'));h.fixture.detectChanges();await h.fixture.whenStable();expect(h.playback.playVod).not.toHaveBeenCalled();expect(h.selection.playbackRequest()).toBeNull();
});

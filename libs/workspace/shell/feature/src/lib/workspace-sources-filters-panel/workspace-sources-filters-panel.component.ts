import {SourcePlaybackStoreService,SOURCE_PLAYBACK_FACADE} from '@arm-nator/services';
import type {SourcePlaybackCategory,SourcePlaybackResult} from '@arm-nator/shared/interfaces';
import {
    ChangeDetectionStrategy,
    Component,
    computed,
    inject,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { Store } from '@ngrx/store';
import {
    FilterActions,
    selectActiveTypeFilters,
    selectAllPlaylistsMeta,
} from '@arm-nator/providers/shared/playlist-state';
import {
    getPlaylistSourceType,
    PlaylistSourceType,
} from '@arm-nator/shared/interfaces';
import { TranslatePipe } from '@ngx-translate/core';
import { PlaybackResourceService } from '@arm-nator/player/ui';

type PlaylistFilterId = 'all' | PlaylistSourceType;

interface PlaylistFilterOption {
    id: PlaylistFilterId;
    icon: string;
    label?: string;
    translationKey?: string;
}

const ALL_FILTERS: PlaylistSourceType[] = ['xtream', 'stalker'];

@Component({
    selector: 'app-workspace-sources-filters-panel',
    imports: [MatIcon, MatListModule, TranslatePipe],
    templateUrl: './workspace-sources-filters-panel.component.html',
    styleUrl: './workspace-sources-filters-panel.component.scss',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceSourcesFiltersPanelComponent {
    readonly playback=inject(SourcePlaybackStoreService);
    readonly checks=inject(SOURCE_PLAYBACK_FACADE,{optional:true});
    private readonly playbackResources = inject(PlaybackResourceService);
    readonly playbackResults:readonly (SourcePlaybackResult|'any'|'working-recently')[]=['any','working-recently','verified','mixed','failed','unstable','untested'];
    setPlaybackCategory(value:string):void{if(['all','live','movies','series'].includes(value))this.playback.setFilter({...this.playback.filter(),category:value as SourcePlaybackCategory|'all'});}
    setPlaybackResult(value:string):void{if(this.playbackResults.includes(value as SourcePlaybackResult))this.playback.setFilter({...this.playback.filter(),result:value as SourcePlaybackResult|'any'|'working-recently'});}

    private readonly store = inject(Store);

    private readonly activeTypeFilters = this.store.selectSignal(
        selectActiveTypeFilters
    );
    private readonly playlists = this.store.selectSignal(selectAllPlaylistsMeta);

    readonly checkStatus = computed(() => {
        const activity = this.checks?.activity();
        const source = this.sourceTitle(activity?.key?.sourceId);
        const category = activity?.key?.category;

        if (!this.checks?.available()) {
            return {
                state: 'unavailable',
                icon: 'cloud_off',
                title: 'WORKSPACE.SOURCES.PLAYBACK.UNAVAILABLE',
                titleParams: undefined,
                source: '',
                category: '',
                sampleTitle: undefined,
            };
        }

        if (activity?.state === 'checking') {
            return {
                state: 'checking',
                icon: 'sync',
                title: activity.phase === 'sample'
                    ? 'WORKSPACE.SOURCES.PLAYBACK.STATUS_SAMPLE'
                    : 'WORKSPACE.SOURCES.PLAYBACK.STATUS_DISCOVERING',
                titleParams: activity.phase === 'sample'
                    ? { index: activity.sampleIndex ?? 1, count: activity.sampleCount ?? 3 }
                    : undefined,
                source,
                category: category ? `WORKSPACE.SOURCES.PLAYBACK.CATEGORY_${category.toUpperCase()}` : '',
                sampleTitle: activity.sampleTitle,
            };
        }

        if (activity?.state === 'queued') {
            return {
                state: 'queued',
                icon: 'schedule',
                title: 'WORKSPACE.SOURCES.PLAYBACK.STATUS_QUEUED',
                titleParams: undefined,
                source,
                category: category ? `WORKSPACE.SOURCES.PLAYBACK.CATEGORY_${category.toUpperCase()}` : '',
                sampleTitle: undefined,
            };
        }

        if (activity?.state === 'teardown-pending') {
            return {
                state: 'waiting',
                icon: 'hourglass_top',
                title: 'WORKSPACE.SOURCES.PLAYBACK.STATUS_CLEANUP',
                titleParams: undefined,
                source,
                category: category ? `WORKSPACE.SOURCES.PLAYBACK.CATEGORY_${category.toUpperCase()}` : '',
                sampleTitle: undefined,
            };
        }

        if (this.playbackResources.isBlocked()) {
            return {
                state: 'paused',
                icon: 'pause_circle_outline',
                title: 'WORKSPACE.SOURCES.PLAYBACK.STATUS_PAUSED',
                titleParams: undefined,
                source: '',
                category: '',
                sampleTitle: undefined,
            };
        }

        if (activity?.state === 'deferred') {
            return {
                state: 'paused',
                icon: 'pause_circle_outline',
                title: activity.reason
                    ? `WORKSPACE.SOURCES.PLAYBACK.REASON_${activity.reason}`
                    : 'WORKSPACE.SOURCES.PLAYBACK.STATUS_PAUSED',
                titleParams: undefined,
                source,
                category: category ? `WORKSPACE.SOURCES.PLAYBACK.CATEGORY_${category.toUpperCase()}` : '',
                sampleTitle: undefined,
            };
        }

        return {
            state: 'idle',
            icon: 'check_circle_outline',
            title: 'WORKSPACE.SOURCES.PLAYBACK.STATUS_IDLE',
            titleParams: undefined,
                source: '',
                category: '',
            sampleTitle: undefined,
        };
    });

    sourceTitle(sourceId?: string): string {
        if (!sourceId) return '';
        const source = this.playlists().find((item) => item._id === sourceId);
        return source?.title || source?.filename || sourceId;
    }

    readonly typeOptions: PlaylistFilterOption[] = [
        {
            id: 'all',
            icon: 'layers',
            translationKey: 'WORKSPACE.SOURCES.ALL',
        },
        {
            id: 'xtream',
            icon: 'cloud',
            translationKey: 'HOME.PLAYLIST_TYPES.XTREAM',
        },
        {
            id: 'stalker',
            icon: 'router',
            translationKey: 'HOME.PLAYLIST_TYPES.STALKER',
        },
    ];

    readonly typeCounts = computed(() => {
        const items = this.playlists();
        return {
            all: items.length,
            xtream: items.filter(
                (item) => getPlaylistSourceType(item) === 'xtream'
            ).length,
            stalker: items.filter(
                (item) => getPlaylistSourceType(item) === 'stalker'
            ).length,
        };
    });

    isTypeActive(filterId: PlaylistFilterId): boolean {
        const selected = this.activeTypeFilters();
        if (filterId === 'all') {
            return (
                selected.length === ALL_FILTERS.length &&
                ALL_FILTERS.every((id) => selected.includes(id))
            );
        }

        return selected.length === 1 && selected[0] === filterId;
    }

    selectType(filterId: PlaylistFilterId): void {
        const selectedFilters =
            filterId === 'all' ? ALL_FILTERS : [filterId];
        this.store.dispatch(
            FilterActions.setSelectedFilters({
                selectedFilters,
            })
        );
    }

    getTypeCount(filterId: PlaylistFilterId): number {
        const counts = this.typeCounts();
        if (filterId === 'all') {
            return counts.all;
        }
        return counts[filterId];
    }
}

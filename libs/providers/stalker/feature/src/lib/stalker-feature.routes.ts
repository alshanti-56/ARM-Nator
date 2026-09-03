import { Route } from '@angular/router';
import { provideStalkerWorkspaceRouteSession } from './stalker-workspace-route-session.service';

type ComponentLoader = NonNullable<Route['loadComponent']>;

const loadStalkerLiveStreamLayoutComponent: ComponentLoader = () =>
    import('./stalker-live-stream-layout/stalker-live-stream-layout.component').then(
        (c) => c.StalkerLiveStreamLayoutComponent
    );

const loadStalkerContentDetailComponent: ComponentLoader = () =>
    import('./stalker-content-detail/stalker-content-detail.component').then(
        (c) => c.StalkerContentDetailComponent
    );

export function createStalkerRoutes(): Route[] {
    return [
        {
            path: ':id',
            providers: provideStalkerWorkspaceRouteSession(),
            children: [
                {
                    path: '',
                    redirectTo: 'itv',
                    pathMatch: 'full',
                },
                {
                    path: 'itv',
                    data: { contentType: 'itv' },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'itv/:categoryId',
                    data: { contentType: 'itv' },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'vod',
                    data: { contentType: 'vod' },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'vod/:categoryId/:vodId',
                    data: { contentType: 'vod' },
                    loadComponent: loadStalkerContentDetailComponent,
                },
                {
                    path: 'vod/:categoryId',
                    data: { contentType: 'vod' },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'series',
                    data: { contentType: 'series' },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'series/:categoryId/:serialId',
                    data: { contentType: 'series' },
                    loadComponent: loadStalkerContentDetailComponent,
                },
                {
                    path: 'series/:categoryId',
                    data: { contentType: 'series' },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'recently-added',
                    data: { contentType: 'vod', recentlyAdded: true },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
                {
                    path: 'search',
                    data: { contentType: 'vod', searchRoute: true },
                    loadComponent: loadStalkerLiveStreamLayoutComponent,
                },
            ],
        },
    ];
}

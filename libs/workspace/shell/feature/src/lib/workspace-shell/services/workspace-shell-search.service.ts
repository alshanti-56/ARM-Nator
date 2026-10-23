import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { TranslateService } from '@ngx-translate/core';
import { startWith } from 'rxjs';
import { XtreamStore } from '@arm-nator/providers/xtream/data-access';
import { RuntimeCapabilitiesService } from '@arm-nator/services';
import { WorkspaceSearchCapability } from '@arm-nator/workspace/shell/util';
import { SEARCH_PLAYLIST_PLACEHOLDER } from './helpers/workspace-shell-constants';
import {
    resolveSearchPlaceholderKey,
    resolveSearchScopeLabel,
} from './helpers/workspace-shell-search-labels';
import { WorkspaceShellRouteStateService } from './workspace-shell-route-state.service';
import { WorkspaceShellSearchSyncService } from './workspace-shell-search-sync.service';

@Injectable()
export class WorkspaceShellSearchService {
    private readonly router = inject(Router);
    private readonly xtreamStore = inject(XtreamStore);
    private readonly translate = inject(TranslateService);
    private readonly runtime = inject(RuntimeCapabilitiesService);
    private readonly routeState = inject(WorkspaceShellRouteStateService);
    private readonly searchSync = inject(WorkspaceShellSearchSyncService);

    private readonly languageTick = toSignal(
        this.translate.onLangChange.pipe(startWith(null)),
        { initialValue: null }
    );

    readonly searchQuery = this.searchSync.searchQuery;
    readonly appliedSearchQuery = this.searchSync.appliedSearchQuery;
    readonly searchCapability = computed<WorkspaceSearchCapability>(() => {
        this.languageTick();

        const route = this.routeState.currentRoute();
        const context = route.context;
        const section = route.section;
        if (route.kind === 'settings') {
            return {
                enabled: false,
                behavior: 'disabled',
                context: null,
                section: null,
                searchMode: 'none',
                placeholderKey: SEARCH_PLAYLIST_PLACEHOLDER,
                scopeLabel: '',
                statusLabel: '',
                minLength: 0,
                advancedRouteTarget: null,
            };
        }

        if (route.kind === 'dashboard') {
            const dashboardContext = this.routeState.dashboardXtreamContext();

            return {
                enabled: Boolean(dashboardContext),
                behavior: dashboardContext ? 'advanced-only' : 'disabled',
                context: dashboardContext,
                section: section,
                searchMode: dashboardContext ? 'advanced-only' : 'none',
                placeholderKey: SEARCH_PLAYLIST_PLACEHOLDER,
                scopeLabel: dashboardContext
                    ? this.translateText('WORKSPACE.SHELL.RAIL_SEARCH')
                    : '',
                statusLabel: '',
                minLength: dashboardContext ? 1 : 0,
                advancedRouteTarget: dashboardContext
                    ? [
                          '/workspace',
                          'xtreams',
                          dashboardContext.playlistId,
                          'search',
                      ]
                    : null,
            };
        }

        if (route.kind === 'global-search') {
            // This query also seeds explicit portal discovery, including libraries
            // without an indexed source. Keep it available before the first import.
            const enabled = this.runtime.supportsGlobalSearch;

            return {
                enabled,
                behavior: enabled ? 'remote-search' : 'disabled',
                context: null,
                section: null,
                searchMode: enabled ? 'remote-search' : 'none',
                placeholderKey: 'WORKSPACE.SHELL.SEARCH_GLOBAL_PLACEHOLDER',
                scopeLabel: this.translateText(
                    'WORKSPACE.SHELL.RAIL_GLOBAL_SEARCH'
                ),
                statusLabel: '',
                minLength: enabled ? 2 : 0,
                advancedRouteTarget: null,
            };
        }

        if (route.searchMode === 'none') {
            return {
                enabled: false,
                behavior: 'disabled',
                context,
                section,
                searchMode: route.searchMode,
                placeholderKey: SEARCH_PLAYLIST_PLACEHOLDER,
                scopeLabel: '',
                statusLabel: '',
                minLength: 0,
                advancedRouteTarget: null,
            };
        }

        return {
            enabled: true,
            behavior: route.searchMode,
            context,
            section,
            searchMode: route.searchMode,
            placeholderKey: resolveSearchPlaceholderKey(
                route.kind,
                context,
                section
            ),
            scopeLabel: resolveSearchScopeLabel({
                kind: route.kind,
                context,
                section,
                translate: (key, params) => this.translateText(key, params),
                xtreamCategory: this.xtreamStore.getSelectedCategory(),
            }),
            statusLabel: '',
            minLength: route.searchMode === 'remote-search' ? 3 : 1,
            advancedRouteTarget: null,
        };
    });
    readonly canUseSearch = computed(() => this.searchCapability().enabled);
    readonly searchPlaceholder = computed(
        () => this.searchCapability().placeholderKey
    );
    readonly searchScopeLabel = computed(
        () => this.searchCapability().scopeLabel
    );
    readonly searchStatusLabel = computed(
        () => this.searchCapability().statusLabel
    );

    onSearchInput(value: string): void {
        this.searchSync.onSearchInput(value);
    }

    onSearchEnter(value: string): void {
        const trimmedValue = value.trim();
        this.searchQuery.set(trimmedValue);

        if (this.searchCapability().behavior === 'advanced-only') {
            const advancedRouteTarget =
                this.searchCapability().advancedRouteTarget;
            if (!advancedRouteTarget) {
                this.searchSync.applySearchQuery(trimmedValue);
                return;
            }

            this.xtreamStore.setSearchTerm(trimmedValue);
            this.searchSync.applySearchQuery(trimmedValue);
            void this.router.navigate(advancedRouteTarget, {
                queryParams: trimmedValue ? { q: trimmedValue } : {},
            });
            return;
        }

        this.searchSync.applySearchQuery(trimmedValue);
    }

    openPlaylistSearchFromPalette(query: string): void {
        const effectiveContext =
            this.routeState.dashboardXtreamContext() ??
            this.routeState.currentContext();

        if (!effectiveContext) {
            return;
        }

        this.searchSync.setSearchState(query);

        if (effectiveContext.provider === 'xtreams') {
            this.xtreamStore.setSearchTerm(query);
            void this.router.navigate(
                [
                    '/workspace',
                    'xtreams',
                    effectiveContext.playlistId,
                    'search',
                ],
                {
                    queryParams: query ? { q: query } : {},
                }
            );
            return;
        }

        if (effectiveContext.provider === 'stalker') {
            void this.router.navigate(
                [
                    '/workspace',
                    'stalker',
                    effectiveContext.playlistId,
                    'search',
                ],
                {
                    queryParams: query ? { q: query } : {},
                }
            );
        }

    }

    private translateText(
        key: string,
        params?: Record<string, string | number>
    ): string {
        return this.translate.instant(key, params);
    }
}

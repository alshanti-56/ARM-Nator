import { Router } from '@angular/router';
import { WorkspacePortalContext } from '@arm-nator/workspace/shell/util';

export function toQueryString(queryParams: Record<string, unknown>): string {
    const urlSearchParams = new URLSearchParams();

    Object.entries(queryParams).forEach(([key, value]) => {
        if (value == null) {
            return;
        }

        if (Array.isArray(value)) {
            value.forEach((item) => urlSearchParams.append(key, String(item)));
            return;
        }

        urlSearchParams.set(key, String(value));
    });

    return urlSearchParams.toString();
}

export function getRouteQueryParam(
    router: Router,
    currentUrl: string,
    name: string
): string {
    const value = router.parseUrl(currentUrl).queryParams[name];
    return typeof value === 'string' ? value : '';
}

export function syncSearchQueryParam(
    router: Router,
    currentUrl: string,
    term: string
): boolean {
    const nextTerm = term.trim();
    const currentTerm = getRouteQueryParam(router, currentUrl, 'q');
    if (nextTerm === currentTerm) {
        return false;
    }

    const routePath = currentUrl.split('?')[0];
    const queryParams = {
        ...router.parseUrl(currentUrl).queryParams,
    };

    if (nextTerm.length > 0) {
        queryParams['q'] = nextTerm;
    } else {
        delete queryParams['q'];
    }

    const queryString = toQueryString(queryParams);
    const nextUrl = queryString ? `${routePath}?${queryString}` : routePath;
    void router.navigateByUrl(nextUrl, { replaceUrl: true });
    return true;
}

export function bumpRefreshQueryParam(router: Router, currentUrl: string): void {
    const routePath = currentUrl.split('?')[0];
    const queryParams = {
        ...router.parseUrl(currentUrl).queryParams,
        refresh: Date.now().toString(),
    };

    const queryString = toQueryString(queryParams);
    const nextUrl = queryString ? `${routePath}?${queryString}` : routePath;
    void router.navigateByUrl(nextUrl, { replaceUrl: true });
}

export function getProviderFromPlaylist(playlist: {
    serverUrl?: string;
    macAddress?: string;
}): WorkspacePortalContext['provider'] {
    if (playlist.serverUrl) {
        return 'xtreams';
    }
    return playlist.macAddress ? 'stalker' : 'xtreams';
}

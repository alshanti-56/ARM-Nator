import {
    createRandomId,
    ParsedPlaylist,
    ParsedPlaylistItem,
    Playlist,
} from '@arm-nator/shared/interfaces';
import { extractDrmFromRaw } from './kodiprop.utils';

const M3U_EPG_HEADER_ATTRS = ['x-tvg-url', 'url-tvg', 'tvg-url'] as const;
const M3U_EPG_URL_PATTERN = /\b(?:https?|file):\/\/[^\s,"']+/gi;
export const M3U_AUTO_IMPORT_EPG_URL_LIMIT = 5;
export const M3U_RECOMMENDED_EPG_URL_LIMIT = 12;

export interface M3uEpgUrlSelection {
    detectedEpgUrls: string[];
    enabledEpgUrls: string[];
}

export interface PlaylistEpgSourceStateInput {
    detectedEpgUrls?: string[];
    enabledEpgUrls?: string[];
    manualEpgUrls?: string[];
    disabledEpgUrls?: string[];
}

export interface PlaylistEpgSourceState {
    detectedEpgUrls: string[];
    epgUrls: string[];
    manualEpgUrls: string[];
    disabledEpgUrls: string[];
}

export function normalizeEpgUrls(
    urls: readonly string[] | undefined
): string[] {
    return Array.from(
        new Set(
            (urls ?? [])
                .map((url) => url.trim())
                .filter((url) => url.length > 0)
        )
    );
}

export function resolvePlaylistEpgSourceState(
    input: PlaylistEpgSourceStateInput
): PlaylistEpgSourceState {
    const detectedEpgUrls = normalizeEpgUrls(input.detectedEpgUrls);
    const manualEpgUrls = normalizeEpgUrls(input.manualEpgUrls);
    const disabledEpgUrls = normalizeEpgUrls(input.disabledEpgUrls);
    const disabledSet = new Set(disabledEpgUrls);
    const epgUrls = normalizeEpgUrls([
        ...normalizeEpgUrls(input.enabledEpgUrls),
        ...manualEpgUrls,
    ]).filter((url) => !disabledSet.has(url));

    return {
        detectedEpgUrls,
        epgUrls,
        manualEpgUrls,
        disabledEpgUrls,
    };
}

export function filterPlaylistEpgUrlsForFetch(
    playlistEpgUrls: readonly string[] | undefined,
    globalEpgUrls: readonly string[] | undefined
): string[] {
    const globalUrlSet = new Set(normalizeEpgUrls(globalEpgUrls));
    return normalizeEpgUrls(playlistEpgUrls).filter(
        (url) => !globalUrlSet.has(url)
    );
}

export function extractM3uEpgUrls(
    playlist: Pick<ParsedPlaylist, 'header'> | null | undefined
): string[] {
    const header = playlist?.header;
    if (!header) {
        return [];
    }

    const candidates: Array<string | undefined> = [];
    for (const attr of M3U_EPG_HEADER_ATTRS) {
        candidates.push(header.attrs?.[attr]);
        candidates.push(extractHeaderAttributeFromRaw(header.raw, attr));
    }

    const urls: string[] = [];
    for (const candidate of candidates) {
        urls.push(...extractUrlsFromHeaderValue(candidate));
    }

    return Array.from(new Set(urls));
}

export function resolveM3uEpgUrlSelection(
    playlist: Pick<ParsedPlaylist, 'header' | 'items'> | null | undefined
): M3uEpgUrlSelection {
    const detectedEpgUrls = extractM3uEpgUrls(playlist);

    if (detectedEpgUrls.length <= M3U_AUTO_IMPORT_EPG_URL_LIMIT) {
        return {
            detectedEpgUrls,
            enabledEpgUrls: detectedEpgUrls,
        };
    }

    const recommendedEpgUrls = selectRecommendedEpgUrls(
        detectedEpgUrls,
        playlist?.items ?? []
    );

    return {
        detectedEpgUrls,
        enabledEpgUrls:
            recommendedEpgUrls.length > 0
                ? recommendedEpgUrls
                : detectedEpgUrls.slice(0, M3U_AUTO_IMPORT_EPG_URL_LIMIT),
    };
}

function extractHeaderAttributeFromRaw(
    raw: string | undefined,
    attr: string
): string | undefined {
    if (!raw) {
        return undefined;
    }

    const match = raw.match(
        new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s]+))`, 'i')
    );

    return match?.[2] ?? match?.[3] ?? match?.[4];
}

function extractUrlsFromHeaderValue(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    const urls: string[] = [];
    const pattern = new RegExp(M3U_EPG_URL_PATTERN);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(value)) !== null) {
        const url = match[0].trim();
        if (url.length > 0) {
            urls.push(url);
        }
    }

    return urls;
}

function selectRecommendedEpgUrls(
    urls: string[],
    items: ParsedPlaylistItem[]
): string[] {
    const hints = collectPlaylistEpgRegionHints(items);
    const recommendations: string[] = [];

    for (const url of urls) {
        const guideCodes = extractEpgGuideCodes(url);
        const matchesCountry =
            guideCodes.country !== undefined &&
            hints.countries.has(guideCodes.country);
        const matchesLanguageWithoutCountry =
            hints.countries.size === 0 &&
            guideCodes.language !== undefined &&
            hints.languages.has(guideCodes.language);

        if (matchesCountry || matchesLanguageWithoutCountry) {
            recommendations.push(url);
        }

        if (recommendations.length >= M3U_RECOMMENDED_EPG_URL_LIMIT) {
            break;
        }
    }

    return recommendations;
}

function collectPlaylistEpgRegionHints(items: ParsedPlaylistItem[]): {
    countries: Set<string>;
    languages: Set<string>;
} {
    const countries = new Set<string>();
    const languages = new Set<string>();

    for (const item of items) {
        addDelimitedCodes(
            countries,
            extractExtinfAttribute(item.raw, 'tvg-country')
        );
        addDelimitedCodes(countries, extractCountrySuffix(item.tvg?.id));

        const languageCode = normalizeLanguageCode(
            extractExtinfAttribute(item.raw, 'tvg-language')
        );
        if (languageCode) {
            languages.add(languageCode);
        }
    }

    return { countries, languages };
}

function extractExtinfAttribute(
    raw: string | undefined,
    attr: string
): string | undefined {
    if (!raw) {
        return undefined;
    }

    const match = raw.match(
        new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s,]+))`, 'i')
    );

    return match?.[2] ?? match?.[3] ?? match?.[4];
}

function addDelimitedCodes(target: Set<string>, value: string | undefined) {
    if (!value) {
        return;
    }

    for (const token of value.split(/[;,_\s]+/)) {
        const code = normalizeRegionCode(token);
        if (code) {
            target.add(code);
        }
    }
}

function normalizeRegionCode(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized && /^[a-z]{2}$/.test(normalized) ? normalized : undefined;
}

function normalizeLanguageCode(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    const languageByName: Record<string, string> = {
        arabic: 'ar',
        english: 'en',
        french: 'fr',
        german: 'de',
        italian: 'it',
        polish: 'pl',
        portuguese: 'pt',
        russian: 'ru',
        spanish: 'es',
        turkish: 'tr',
        ukrainian: 'uk',
    };

    return normalizeRegionCode(normalized) ?? languageByName[normalized];
}

function extractCountrySuffix(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    const match = normalized.match(/\.([a-z]{2})$/);
    return match?.[1];
}

function extractEpgGuideCodes(url: string): {
    country?: string;
    language?: string;
} {
    let path = '';

    try {
        path = new URL(url).pathname;
    } catch {
        path = url;
    }

    const segments = path
        .split('/')
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment.length > 0);
    const guidesIndex = segments.indexOf('guides');
    const guideSegment =
        guidesIndex >= 0 ? segments[guidesIndex + 1] : undefined;

    if (!guideSegment) {
        return {};
    }

    const [country, language] = guideSegment.split('-');

    return {
        country: normalizeRegionCode(country),
        language: normalizeRegionCode(language),
    };
}

export const createPlaylistObject = (
    name: string,
    playlist: ParsedPlaylist,
    urlOrPath?: string,
    uploadType?: 'URL' | 'FILE' | 'TEXT'
): Playlist => {
    const { detectedEpgUrls, enabledEpgUrls } =
        resolveM3uEpgUrlSelection(playlist);
    const epgSourceState = resolvePlaylistEpgSourceState({
        detectedEpgUrls,
        enabledEpgUrls,
    });

    return {
        _id: createRandomId(),
        filename: name,
        title: name,
        count: playlist.items.length,
        playlist: {
            ...playlist,
            items: playlist.items.map((item: ParsedPlaylistItem) => {
                const drm = extractDrmFromRaw(item.raw);
                return {
                    ...item,
                    id: createRandomId(),
                    ...(drm ? { drm } : {}),
                };
            }),
        },
        importDate: new Date().toISOString(),
        lastUsage: new Date().toISOString(),
        favorites: [],
        autoRefresh: false,
        ...(epgSourceState.epgUrls.length > 0
            ? { epgUrls: epgSourceState.epgUrls }
            : {}),
        ...(epgSourceState.detectedEpgUrls.length > 0
            ? { detectedEpgUrls: epgSourceState.detectedEpgUrls }
            : {}),
        ...(uploadType === 'URL' ? { url: urlOrPath } : {}),
        ...(uploadType === 'FILE' ? { filePath: urlOrPath } : {}),
    };
};

export const getExtensionFromUrl = (url: string): string | undefined => {
    const path = url.split(/[#?]/)[0];
    const lastSegment = path.split('/').pop() || '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex < 1) return undefined;
    const ext = lastSegment.slice(dotIndex + 1).trim();
    return ext || undefined;
};

export const getStreamExtensionFromUrl = (url: string): string | undefined => {
    return getExtensionFromUrlQuery(url) ?? getExtensionFromUrl(url);
};

const getExtensionFromUrlQuery = (url: string): string | undefined => {
    try {
        const parsedUrl = new URL(url, 'http://arm-nator.local');
        return normalizeExtensionToken(parsedUrl.searchParams.get('extension'));
    } catch {
        return undefined;
    }
};

const normalizeExtensionToken = (
    value: string | null | undefined
): string | undefined => {
    const extension = value?.trim().replace(/^\.+/, '').toLowerCase();
    return extension || undefined;
};

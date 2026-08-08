import { Language } from './language.enum';
import { StreamFormat } from './stream-format.enum';
import { Theme } from './theme.enum';
import { TmdbSettings } from './tmdb.interface';

/**
 * Contains all types of supported video players
 */
export enum VideoPlayer {
    Html5Player = 'html5',
    EmbeddedMpv = 'embedded-mpv',
    KsPlayer = 'ksplayer',
    MPV = 'mpv',
    VLC = 'vlc',
    ArtPlayer = 'artplayer',
}

export type DirectPlayLayoutMode = 'compact' | 'full';

export interface DirectPlayPreferences {
    engine: VideoPlayer;
    layout: DirectPlayLayoutMode;
    seekStepSeconds: number;
    frameRate: number;
}

export const DEFAULT_DIRECT_PLAY_PREFERENCES: DirectPlayPreferences = {
    engine: VideoPlayer.ArtPlayer,
    layout: 'full',
    seekStepSeconds: 10,
    frameRate: 25,
};

export function normalizeDirectPlayPreferences(
    value?: Partial<DirectPlayPreferences> | null
): DirectPlayPreferences {
    const seekStepSeconds = Number(value?.seekStepSeconds);
    const frameRate = Number(value?.frameRate);

    return {
        engine: normalizeVideoPlayer(
            value?.engine,
            DEFAULT_DIRECT_PLAY_PREFERENCES.engine
        ),
        layout: value?.layout === 'compact' ? 'compact' : 'full',
        seekStepSeconds: Number.isFinite(seekStepSeconds)
            ? Math.min(600, Math.max(1, Math.round(seekStepSeconds)))
            : DEFAULT_DIRECT_PLAY_PREFERENCES.seekStepSeconds,
        frameRate: Number.isFinite(frameRate)
            ? Math.min(240, Math.max(1, frameRate))
            : DEFAULT_DIRECT_PLAY_PREFERENCES.frameRate,
    };
}

export function normalizeVideoPlayer(
    player: unknown,
    fallback = VideoPlayer.ArtPlayer
): VideoPlayer {
    const migratedPlayer =
        player === 'mpv-metal' || player === 'ksplayer-metal'
            ? VideoPlayer.KsPlayer
            : player;
    return Object.values(VideoPlayer).includes(migratedPlayer as VideoPlayer)
        ? (migratedPlayer as VideoPlayer)
        : fallback;
}

export enum StartupBehavior {
    FirstView = 'first-view',
    RestoreLastView = 'restore-last-view',
}

export type CoverSize = 'small' | 'medium' | 'large';

export interface DashboardRailsSettings {
    hero: boolean;
    continueWatching: boolean;
    liveFavorites: boolean;
    recentlyWatchedLive: boolean;
    favoriteMoviesAndSeries: boolean;
    recentSources: boolean;
    xtreamRecentlyAdded: boolean;
    /** TMDB "Trending this week" rail (needs the TMDB opt-in; Electron) */
    tmdbTrending: boolean;
}

export const DEFAULT_DASHBOARD_RAILS_SETTINGS: DashboardRailsSettings = {
    hero: true,
    continueWatching: true,
    liveFavorites: true,
    recentlyWatchedLive: true,
    favoriteMoviesAndSeries: true,
    recentSources: true,
    xtreamRecentlyAdded: true,
    tmdbTrending: true,
};

export type DashboardRailsSettingsInput = Partial<
    Record<keyof DashboardRailsSettings, boolean | null | undefined>
>;

export function normalizeDashboardRailsSettings(
    settings?: DashboardRailsSettingsInput | null
): DashboardRailsSettings {
    const normalized = { ...DEFAULT_DASHBOARD_RAILS_SETTINGS };

    if (!settings) {
        return normalized;
    }

    const keys = Object.keys(
        DEFAULT_DASHBOARD_RAILS_SETTINGS
    ) as (keyof DashboardRailsSettings)[];
    for (const key of keys) {
        if (typeof settings[key] === 'boolean') {
            normalized[key] = settings[key];
        }
    }

    return normalized;
}

/**
 * Describes all available settings options of the application
 */
export interface Settings {
    player: VideoPlayer;
    /** Preferences used by the local Direct Play diagnostics tool. */
    directPlay?: DirectPlayPreferences;
    /**
     * Fill the empty space around the inline VOD/series player with a blurred,
     * dimmed copy of the poster (YouTube "Ambient mode" style) instead of plain
     * black bars. Off by default; only affects the built-in web players.
     */
    playerAmbientMode?: boolean;
    /**
     * Dock the inline series player to the left and show an "Up Next"
     * episode rail in the leftover stage column on wide windows. On by
     * default (the rail only appears when there is genuinely unused space);
     * missing values mean enabled. Only affects the built-in web players.
     */
    playerUpNextRail?: boolean;
    streamFormat: StreamFormat;
    openStreamOnDoubleClick: boolean;
    language: Language;
    showCaptions: boolean;
    showDashboard: boolean;
    startupBehavior: StartupBehavior;
    /** Show the desktop footer bar for external playback status */
    showExternalPlaybackBar?: boolean;
    /** Strip country/group prefixes like "US | " or "UK - " from channel names */
    stripCountryPrefix?: boolean;
    theme: Theme;
    mpvPlayerPath: string;
    /**
     * Extra MPV CLI arguments entered one argument per line. Applied only when
     * starting a new external MPV process.
     */
    mpvPlayerArguments: string;
    mpvReuseInstance: boolean;
    vlcPlayerPath: string;
    /**
     * Extra VLC CLI arguments entered one argument per line. Applied only when
     * starting a new external VLC process.
     */
    vlcPlayerArguments: string;
    vlcReuseInstance: boolean;
    /** Cover/poster sizing preset applied across grids and rails */
    coverSize?: CoverSize;
    /** Per-rail dashboard visibility preferences. Missing keys default on. */
    dashboardRails?: DashboardRailsSettings;
    /**
     * Lowercase hostnames whose invalid TLS certificates the user has chosen
     * to trust. This is host-scoped and does not disable TLS validation for
     * unrelated remote hosts.
     */
    trustedInsecureTlsHosts?: string[];
    /**
     * Opt-in TMDB metadata enrichment for VOD/series detail views.
     * Disabled by default because enrichment sends content titles to TMDB.
     */
    tmdb?: TmdbSettings;
}

export type BrowserViewMode = 'browser' | 'youtube';

export type BrowserViewDisplayMode = 'full' | 'mini';

export type BrowserViewBoundsTarget = 'active' | 'youtube-mini';

export type BrowserViewEmbeddedCommand =
    | 'youtube-native-mini-player'
    | 'arm-mini-player'
    | 'restore-arm-mini-player'
    | 'terminate-playback'
    | 'youtube-fullscreen';

export interface BrowserViewBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export type BrowserViewCommand =
    | { readonly type: 'navigate'; readonly url: string }
    | { readonly type: 'back' }
    | { readonly type: 'forward' }
    | { readonly type: 'reload' }
    | { readonly type: 'stop' }
    | {
          readonly type: 'set-muted';
          readonly muted: boolean;
          readonly target?: BrowserViewMode;
      }
    | {
          readonly type: 'set-display-mode';
          readonly mode: BrowserViewDisplayMode;
      }
    | { readonly type: 'youtube-native-mini-player' }
    | { readonly type: 'open-devtools' };

export type BrowserViewStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'failed'
    | 'closed';

export interface BrowserViewState {
    readonly id: string;
    readonly mode: BrowserViewMode;
    readonly displayMode: BrowserViewDisplayMode;
    readonly isFullscreen: boolean;
    readonly url: string;
    readonly title: string;
    readonly status: BrowserViewStatus;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
    readonly isMuted: boolean;
    readonly bounds: BrowserViewBounds;
    readonly miniPlayer?: BrowserMiniPlayerState;
    readonly error?: string;
}

export interface BrowserMiniPlayerState {
    readonly mode: 'youtube';
    readonly url: string;
    readonly title: string;
    readonly bounds: BrowserViewBounds;
    readonly isMuted: boolean;
}

/** CSS-pixel placement for an app-owned DOM browser guest. */
export interface BrowserGuestSurfaceState {
    readonly isFullscreen?: boolean;
    readonly displayMode?: BrowserViewDisplayMode;
    readonly id: number;
    readonly mode: BrowserViewMode;
    readonly bounds: BrowserViewBounds;
    readonly visible: boolean;
}

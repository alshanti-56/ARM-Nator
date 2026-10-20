/* eslint-disable max-lines -- keeps the two related embedded-view lifecycles together. */
import { WebContentsView, shell, session } from 'electron';
import { join } from 'node:path';
import type {
    BrowserMiniPlayerState,
    BrowserViewBounds,
    BrowserViewBoundsTarget,
    BrowserViewCommand,
    BrowserViewDisplayMode,
    BrowserViewEmbeddedCommand,
    BrowserViewMode,
    BrowserViewState,
} from '@arm-nator/shared/interfaces';
import { BROWSER_VIEW_UPDATE } from '@arm-nator/shared/interfaces';
import { BrowserGuestRegistry, type BrowserSurface } from './browser-guest-registry';
import { toNativeViewBounds } from './embedded-mpv-bounds.util';

const BROWSER_PARTITION = 'persist:arm-nator-browser';
const DEFAULT_BROWSER_URL = 'https://duckduckgo.com/';
const DEFAULT_YOUTUBE_URL = 'https://www.youtube.com/';
const MINI_PLAYER_MAX_WIDTH = 420;
const MINI_PLAYER_MIN_WIDTH = 280;
const MINI_PLAYER_MARGIN = 24;
const MINI_PLAYER_CONTROL_HEIGHT = 36;
const YOUTUBE_AD_FILTER_PRELOAD = join(
    __dirname,
    'assets',
    'youtube-ad-filter.preload.js'
);

export const browserGuestRegistry = new BrowserGuestRegistry(YOUTUBE_AD_FILTER_PRELOAD);

const YOUTUBE_MINI_PLAYER_CSS = `
    html, body {
        background: #000 !important;
        overflow: hidden !important;
    }
    #masthead-container,
    ytd-masthead,
    #guide,
    tp-yt-app-drawer,
    #below,
    #secondary,
    #comments,
    #chat,
    ytd-watch-metadata,
    ytd-live-chat-frame,
    #player-ads,
    ytd-ad-slot-renderer {
        display: none !important;
    }
    ytd-watch-flexy,
    #page-manager,
    #content,
    #columns,
    #primary,
    #player,
    #player-container-outer,
    #movie_player {
        width: 100% !important;
        height: 100% !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 !important;
    }
    #player,
    #player-container-outer,
    #movie_player {
        display: block !important;
    }
    #movie_player {
        position: fixed !important;
        inset: 0 !important;
        z-index: 999999 !important;
    }
`;

function isYouTubeHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return (
        host === 'youtube.com' ||
        host.endsWith('.youtube.com') ||
        host === 'youtu.be' ||
        host.endsWith('.youtu.be')
    );
}

function isYouTubeAuthenticationHost(hostname: string): boolean {
    return hostname.toLowerCase() === 'accounts.google.com';
}

function normalizeUrl(value: string, mode: BrowserViewMode): string {
    const candidate = value.trim();
    const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(candidate)
        ? candidate
        : `https://${candidate}`;
    const parsed = new URL(withProtocol);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Only HTTP and HTTPS pages can be opened here.');
    }

    if (
        mode === 'youtube' &&
        !isYouTubeHost(parsed.hostname) &&
        !isYouTubeAuthenticationHost(parsed.hostname)
    ) {
        throw new Error(
            'YouTube mode only allows YouTube pages and Google sign-in.'
        );
    }

    return parsed.toString();
}

function clampBounds(bounds: BrowserViewBounds): BrowserViewBounds {
    return {
        x: Math.max(0, Math.round(bounds.x)),
        y: Math.max(0, Math.round(bounds.y)),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
    };
}

interface ManagedBrowserView {
    readonly mode: BrowserViewMode;
    readonly owner: Electron.BrowserWindow;
    readonly view: BrowserSurface;
    bounds: BrowserViewBounds;
    displayMode: BrowserViewDisplayMode;
    isFullscreen: boolean;
    error: string;
    isParked: boolean;
    miniPlayerCssKey?: string;
    parkingPromise?: Promise<void>;
    wasMutedBeforeParking?: boolean;
    wasPlayingBeforeParking?: boolean;
    ownsWindowFullscreen?: boolean;
    preFullscreenBounds?: BrowserViewBounds;
    fullscreenCssKey?: string;
}

export class BrowserViewService {
    private activeView: ManagedBrowserView | null = null;
    private youtubeView: ManagedBrowserView | null = null;
    private youtubePreloadPromise: Promise<void> | null = null;
    private owner: Electron.BrowserWindow | null = null;
    private ownerResizeHandler: (() => void) | null = null;

    async preloadYoutube(owner: Electron.BrowserWindow): Promise<void> {
        if (
            this.youtubeView &&
            !this.youtubeView.view.webContents.isDestroyed()
        ) {
            return;
        }
        if (this.youtubeView) {
            this.disposeYoutubeView();
        }
        if (this.youtubePreloadPromise) {
            return this.youtubePreloadPromise;
        }

        this.youtubePreloadPromise = (async () => {
            if (this.owner && this.owner !== owner) {
                this.disposeAll();
            }
            this.bindOwner(owner);

            if (this.youtubeView) {
                return;
            }

            const view = this.createView(owner, 'youtube');
            view.isParked = true;
            this.youtubeView = view;
            this.detachView(view);
            await this.navigate(view, DEFAULT_YOUTUBE_URL);
        })().finally(() => {
            this.youtubePreloadPromise = null;
        });

        return this.youtubePreloadPromise;
    }

    async open(
        owner: Electron.BrowserWindow,
        mode: BrowserViewMode,
        requestedUrl?: string
    ): Promise<BrowserViewState> {
        if (this.owner && this.owner !== owner) {
            this.disposeAll();
        }
        this.bindOwner(owner);

        if (mode === 'youtube') {
            await this.openYoutube(owner, requestedUrl);
        } else {
            await this.openBrowser(owner, requestedUrl);
        }
        return this.snapshot();
    }

    setBounds(
        owner: Electron.BrowserWindow,
        bounds: BrowserViewBounds,
        target: BrowserViewBoundsTarget = 'active'
    ): void {
        const view =
            target === 'youtube-mini' ? this.youtubeView : this.activeView;
        if (
            !view ||
            view.owner !== owner ||
            (target === 'youtube-mini'
                ? view.displayMode !== 'mini'
                : view.displayMode !== 'full') ||
            view.isFullscreen
        ) {
            return;
        }

        this.applyBounds(view, bounds);
    }

    async execute(
        owner: Electron.BrowserWindow,
        command: BrowserViewCommand
    ): Promise<BrowserViewState | null> {
        if (this.owner !== owner) {
            return null;
        }

        switch (command.type) {
            case 'set-display-mode':
                if (command.mode === 'mini') {
                    await this.enterArmMiniPlayer();
                } else {
                    await this.promoteArmMiniPlayer();
                }
                return this.snapshot();
            case 'youtube-native-mini-player':
                await this.toggleYoutubeNativeMiniPlayer();
                return this.snapshot();
            case 'set-muted': {
                const target =
                    command.target === 'youtube'
                        ? this.youtubeView
                        : this.activeView;
                if (target && !target.view.webContents.isDestroyed()) {
                    target.view.webContents.setAudioMuted(command.muted);
                    this.publish();
                }
                return this.snapshot();
            }
            default:
                break;
        }

        const view = this.activeView;
        if (!view || view.owner !== owner) {
            return this.snapshot();
        }

        switch (command.type) {
            case 'navigate':
                await this.navigate(view, command.url);
                break;
            case 'back':
                if (view.view.webContents.canGoBack()) {
                    view.view.webContents.goBack();
                }
                break;
            case 'forward':
                if (view.view.webContents.canGoForward()) {
                    view.view.webContents.goForward();
                }
                break;
            case 'reload':
                view.view.webContents.reload();
                break;
            case 'stop':
                view.view.webContents.stop();
                break;
            case 'open-devtools':
                view.view.webContents.openDevTools({ mode: 'detach' });
                break;
        }

        return this.snapshot();
    }

    async executeEmbeddedCommand(
        contents: Electron.WebContents,
        command: BrowserViewEmbeddedCommand
    ): Promise<void> {
        const view = this.youtubeView;
        if (
            !view ||
            view.view.webContents !== contents ||
            contents.isDestroyed()
        ) {
            return;
        }

        switch (command) {
            case 'youtube-native-mini-player':
                await this.toggleYoutubeNativeMiniPlayer();
                break;
            case 'arm-mini-player':
                await this.enterArmMiniPlayer();
                break;
            case 'restore-arm-mini-player':
                await this.promoteArmMiniPlayer();
                break;
            case 'terminate-playback':
                this.disposeYoutubeView();
                this.publish('closed');
                break;
            case 'youtube-fullscreen':
                await this.toggleYoutubeFullscreen();
                break;
        }
    }

    close(
        owner: Electron.BrowserWindow,
        mode?: BrowserViewMode,
        terminate = false
    ): void {
        if (this.owner !== owner) {
            return;
        }

        if (mode === 'browser') {
            if (this.activeView?.mode === 'browser') {
                this.disposeActiveView();
            }
        } else if (mode === 'youtube') {
            if (terminate) {
                this.disposeYoutubeView();
            } else {
                this.parkYoutubeView();
            }
        } else {
            this.disposeActiveView();
            if (terminate) {
                this.disposeYoutubeView();
            } else {
                this.parkYoutubeView();
            }
        }
        this.publish();
    }

    shutdown(): void {
        this.disposeAll();
    }

    private async openYoutube(
        owner: Electron.BrowserWindow,
        requestedUrl?: string
    ): Promise<void> {
        if (this.activeView?.mode === 'youtube') {
            if (requestedUrl) {
                await this.navigate(this.activeView, requestedUrl);
            }
            return;
        }

        if (this.activeView?.mode === 'browser') {
            this.disposeActiveView();
        }

        if (!this.youtubeView) {
            this.youtubeView = this.createView(owner, 'youtube');
            this.activeView = this.youtubeView;
            await this.navigate(
                this.youtubeView,
                requestedUrl ?? DEFAULT_YOUTUBE_URL
            );
            return;
        }

        if (this.youtubeView.displayMode === 'mini') {
            await this.promoteArmMiniPlayer();
        } else {
            await this.attachYoutubeView();
        }
        if (requestedUrl && this.youtubeView) {
            await this.navigate(this.youtubeView, requestedUrl);
        }
    }

    private async openBrowser(
        owner: Electron.BrowserWindow,
        requestedUrl?: string
    ): Promise<void> {
        if (this.activeView?.mode === 'browser') {
            if (requestedUrl) {
                await this.navigate(this.activeView, requestedUrl);
            }
            this.bringArmMiniPlayerToFront();
            return;
        }

        if (this.activeView?.mode === 'youtube') {
            this.parkYoutubeView();
        }

        this.activeView = this.createView(owner, 'browser');
        await this.navigate(
            this.activeView,
            requestedUrl ?? DEFAULT_BROWSER_URL
        );
        this.bringArmMiniPlayerToFront();
    }

    private bindOwner(owner: Electron.BrowserWindow): void {
        if (this.owner === owner) {
            return;
        }

        this.unbindOwner();
        this.owner = owner;
        this.ownerResizeHandler = () => {
            if (this.youtubeView?.isFullscreen) {
                this.setFullscreenPlayerBounds(this.youtubeView);
            } else if (this.youtubeView?.displayMode === 'mini') {
                this.setMiniPlayerBounds(this.youtubeView);
            }
        };
        owner.on('resize', this.ownerResizeHandler);
        owner.once('closed', () => {
            if (this.owner === owner) {
                this.disposeAll();
            }
        });
    }

    private createView(
        owner: Electron.BrowserWindow,
        mode: BrowserViewMode
    ): ManagedBrowserView {
        const browserSession = session.fromPartition(BROWSER_PARTITION);
        let view: BrowserSurface;
        if (process.env.ARM_NATOR_NATIVE_COMPOSITION === '1') {
            const guest = browserGuestRegistry.get(owner, mode);
            if (!guest) throw new Error('The browser guest has not attached. Try again.');
            view = guest;
        } else {
        const nativeView = new WebContentsView({
            webPreferences: {
                contextIsolation: mode !== 'youtube',
                nodeIntegration: false,
                ...(mode === 'youtube'
                    ? { preload: YOUTUBE_AD_FILTER_PRELOAD }
                    : {}),
                sandbox: true,
                session: browserSession,
            },
        });
            view = {
                nativeView, webContents: nativeView.webContents,
                setBounds: bounds => nativeView.setBounds(bounds),
                setVisible: visible => nativeView.setVisible(visible),
            };
        }
        const managedView: ManagedBrowserView = {
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            displayMode: 'full',
            error: '',
            isFullscreen: false,
            isParked: false,
            mode,
            owner,
            view,
        };

        if (view.nativeView) owner.contentView.addChildView(view.nativeView);
        view.setVisible(true);
        view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
        this.bindEvents(managedView);
        return managedView;
    }

    private async navigate(
        view: ManagedBrowserView,
        value: string
    ): Promise<void> {
        if (view.isFullscreen) {
            this.leaveYoutubeFullscreen(view);
        }
        let url: string;
        try {
            url = normalizeUrl(value, view.mode);
        } catch (error) {
            view.error = error instanceof Error ? error.message : String(error);
            this.publish('failed', view);
            return;
        }

        view.error = '';
        try {
            await view.view.webContents.loadURL(url);
        } catch (error) {
            view.error = error instanceof Error ? error.message : String(error);
            this.publish('failed', view);
        }
    }

    private async enterArmMiniPlayer(): Promise<void> {
        const view = this.activeView;
        if (!view || view.mode !== 'youtube' || view.displayMode !== 'full') {
            return;
        }

        if (view.isFullscreen) {
            this.leaveYoutubeFullscreen(view);
        }

        try {
            view.miniPlayerCssKey = await view.view.webContents.insertCSS(
                YOUTUBE_MINI_PLAYER_CSS
            );
            await view.view.webContents.executeJavaScript(
                "document.documentElement?.setAttribute('data-arm-nator-mini-player', 'true')",
                true
            );
        } catch (error) {
            view.error =
                error instanceof Error
                    ? error.message
                    : 'The ARM-Nator mini-player could not be prepared.';
            this.publish('failed', view);
            return;
        }

        view.displayMode = 'mini';
        view.isParked = false;
        this.activeView = null;
        this.setMiniPlayerBounds(view);
        this.bringArmMiniPlayerToFront();
        this.publish();
    }

    private async promoteArmMiniPlayer(): Promise<void> {
        const view = this.youtubeView;
        if (!view || view.displayMode !== 'mini') {
            return;
        }

        if (view.miniPlayerCssKey && !view.view.webContents.isDestroyed()) {
            await view.view.webContents
                .executeJavaScript(
                    "document.documentElement?.removeAttribute('data-arm-nator-mini-player')",
                    true
                )
                .catch(() => undefined);
            await view.view.webContents
                .removeInsertedCSS(view.miniPlayerCssKey)
                .catch(() => undefined);
        }
        view.miniPlayerCssKey = undefined;
        view.displayMode = 'full';
        view.isParked = false;
        this.activeView = view;
        if (!view.owner.isDestroyed()) {
            if (view.view.nativeView) view.owner.contentView.removeChildView(view.view.nativeView);
            if (view.view.nativeView) view.owner.contentView.addChildView(view.view.nativeView);
            view.view.setVisible(true);
        }
        this.applyBounds(view, { x: 0, y: 0, width: 1, height: 1 });
        this.publish();
    }

    private async toggleYoutubeNativeMiniPlayer(): Promise<void> {
        const view = this.activeView;
        if (!view || view.mode !== 'youtube' || view.displayMode !== 'full') {
            return;
        }

        if (view.view.webContents.isDestroyed()) {
            return;
        }

        try {
            const toggled = await view.view.webContents.executeJavaScript(
                `
                    (async () => {
                        const isMiniPlayerButton = element => {
                            if (!(element instanceof HTMLElement)) {
                                return false;
                            }
                            if (element.closest('#arm-nator-player-controls')) {
                                return false;
                            }
                            const label = [
                                element.getAttribute('aria-label'),
                                element.getAttribute('title'),
                                element.textContent,
                            ]
                                .filter(Boolean)
                                .join(' ')
                                .toLowerCase();
                            return (
                                element.classList.contains('ytp-miniplayer-button') ||
                                label.includes('miniplayer') ||
                                label.includes('mini player')
                            );
                        };

                        const directButton = Array.from(
                            document.querySelectorAll('button, [role="button"]')
                        ).find(isMiniPlayerButton);
                        if (directButton instanceof HTMLElement) {
                            directButton.click();
                            return true;
                        }

                        const player = document.querySelector('#movie_player');
                        if (!(player instanceof HTMLElement)) {
                            return false;
                        }
                        const playerBounds = player.getBoundingClientRect();
                        return {
                            x: Math.round(playerBounds.left + playerBounds.width / 2),
                            y: Math.round(playerBounds.top + playerBounds.height / 2),
                        };
                    })()
                `,
                true
            );

            if (toggled === true) {
                return;
            }
            if (
                !toggled ||
                typeof toggled !== 'object' ||
                typeof toggled.x !== 'number' ||
                typeof toggled.y !== 'number'
            ) {
                if (!toggled) {
                    view.error =
                        'YouTube did not expose its Miniplayer control on this page.';
                    this.publish('failed', view);
                }
                return;
            }

            view.view.webContents.sendInputEvent({
                type: 'mouseDown',
                x: toggled.x,
                y: toggled.y,
                button: 'right',
                clickCount: 1,
            });
            view.view.webContents.sendInputEvent({
                type: 'mouseUp',
                x: toggled.x,
                y: toggled.y,
                button: 'right',
                clickCount: 1,
            });
            await new Promise(resolve => setTimeout(resolve, 180));
            const menuItem = await view.view.webContents.executeJavaScript(
                `Array.from(document.querySelectorAll('[role="menuitem"], .ytp-contextmenu-item')).find(element => element.textContent?.trim().toLowerCase() === 'miniplayer') !== undefined`,
                true
            );
            if (menuItem) {
                await view.view.webContents.executeJavaScript(
                    `Array.from(document.querySelectorAll('[role="menuitem"], .ytp-contextmenu-item')).find(element => element.textContent?.trim().toLowerCase() === 'miniplayer')?.click()`,
                    true
                );
                return;
            }

            view.error =
                'YouTube did not expose its Miniplayer control on this page.';
            this.publish('failed', view);
        } catch (error) {
            view.error = error instanceof Error ? error.message : String(error);
            this.publish('failed', view);
        }
    }

    private async toggleYoutubeFullscreen(): Promise<void> {
        const view = this.youtubeView;
        if (!view || view.displayMode !== 'full') {
            return;
        }
        if (view.isFullscreen) {
            this.leaveYoutubeFullscreen(view);
        } else {
            await this.enterYoutubeFullscreen(view);
        }
    }

    private parkYoutubeView(): void {
        const view = this.youtubeView;
        if (
            !view ||
            view.displayMode === 'mini' ||
            view.isParked ||
            view.view.webContents.isDestroyed()
        ) {
            return;
        }

        if (view.isFullscreen) {
            this.leaveYoutubeFullscreen(view);
        }

        if (this.activeView === view) {
            this.activeView = null;
        }
        view.isParked = true;
        view.wasMutedBeforeParking = view.view.webContents.isAudioMuted();
        view.view.webContents.setAudioMuted(true);
        view.parkingPromise = view.view.webContents
            .executeJavaScript(
                `(() => {
                    const media = Array.from(document.querySelectorAll('video, audio'));
                    const wasPlaying = media.some(element => !element.paused && !element.ended);
                    media.forEach(element => element.pause());
                    return wasPlaying;
                })()`,
                true
            )
            .then(result => {
                view.wasPlayingBeforeParking = result === true;
            })
            .catch(() => undefined);
        this.detachView(view);
    }

    private async attachYoutubeView(): Promise<void> {
        const view = this.youtubeView;
        if (!view) {
            return;
        }

        await view.parkingPromise?.catch(() => undefined);
        view.parkingPromise = undefined;
        view.isParked = false;
        this.activeView = view;
        if (view.view.nativeView) this.owner?.contentView.addChildView(view.view.nativeView);
        view.view.setVisible(true);
        if (view.displayMode === 'full') {
            this.applyBounds(view, { x: 0, y: 0, width: 1, height: 1 });
        }
        if (view.wasMutedBeforeParking !== undefined) {
            view.view.webContents.setAudioMuted(view.wasMutedBeforeParking);
        }
        if (view.wasPlayingBeforeParking) {
            void view.view.webContents
                .executeJavaScript(
                    "Array.from(document.querySelectorAll('video, audio')).forEach(element => { void element.play().catch(() => undefined); })",
                    true
                )
                .catch(() => undefined);
        }
        view.wasMutedBeforeParking = undefined;
        view.wasPlayingBeforeParking = undefined;
    }

    private async enterYoutubeFullscreen(view: ManagedBrowserView): Promise<void> {
        const owner = view.owner;
        if (
            view.mode !== 'youtube' ||
            view.displayMode !== 'full' ||
            view.isFullscreen ||
            owner.isDestroyed()
        ) {
            return;
        }

        view.preFullscreenBounds = view.bounds;
        view.isFullscreen = true;
        view.ownsWindowFullscreen = !owner.isFullScreen();
        if (view.ownsWindowFullscreen) {
            owner.setFullScreen(true);
        }
        try {
            const cssKey = await view.view.webContents.insertCSS(
                YOUTUBE_MINI_PLAYER_CSS
            );
            if (view.isFullscreen) {
                view.fullscreenCssKey = cssKey;
            } else {
                await view.view.webContents.removeInsertedCSS(cssKey);
            }
        } catch (error) {
            view.error =
                error instanceof Error
                    ? error.message
                    : 'The fullscreen player could not be prepared.';
            this.publish('failed', view);
            return;
        }
        this.setFullscreenPlayerBounds(view);
        void view.view.webContents
            .executeJavaScript(
                "window.__armNatorAppFullscreen = true",
                true
            )
            .catch(() => undefined);
        setTimeout(() => {
            if (view.isFullscreen) {
                this.setFullscreenPlayerBounds(view);
            }
        }, 120);
        this.publish();
    }

    private leaveYoutubeFullscreen(view: ManagedBrowserView): void {
        if (!view.isFullscreen) {
            return;
        }

        view.isFullscreen = false;
        if (view.ownsWindowFullscreen && !view.owner.isDestroyed()) {
            view.owner.setFullScreen(false);
        }
        view.ownsWindowFullscreen = false;
        view.preFullscreenBounds = undefined;
        const fullscreenCssKey = view.fullscreenCssKey;
        view.fullscreenCssKey = undefined;
        if (
            fullscreenCssKey &&
            !view.view.webContents.isDestroyed()
        ) {
            void view.view.webContents
                .removeInsertedCSS(fullscreenCssKey)
                .catch(() => undefined);
        }
        if (!view.owner.isDestroyed()) {
            this.applyBounds(view, { x: 0, y: 0, width: 1, height: 1 });
        }
        if (!view.view.webContents.isDestroyed()) {
            void view.view.webContents
                .executeJavaScript(
                    "window.__armNatorAppFullscreen = false",
                    true
                )
                .catch(() => undefined);
        }
        this.publish();
    }

    private setFullscreenPlayerBounds(view: ManagedBrowserView): void {
        const owner = view.owner;
        if (owner.isDestroyed() || view.view.webContents.isDestroyed()) {
            return;
        }

        const [width, height] = owner.getContentSize();
        this.applyBounds(view, {
            x: 0,
            y: 0,
            width: Math.max(1, width),
            height: Math.max(1, height),
        });
    }

    private setMiniPlayerBounds(view: ManagedBrowserView): void {
        const owner = view.owner;
        if (owner.isDestroyed() || view.view.webContents.isDestroyed()) {
            return;
        }

        const [contentWidth, contentHeight] = owner.getContentSize();
        const availableWidth = Math.max(1, contentWidth - MINI_PLAYER_MARGIN);
        const width = Math.min(
            availableWidth,
            MINI_PLAYER_MAX_WIDTH,
            Math.max(MINI_PLAYER_MIN_WIDTH, Math.round(contentWidth * 0.32))
        );
        const height = Math.max(1, Math.round(width * (9 / 16)));
        this.applyBounds(view, {
            x: Math.max(12, contentWidth - width - MINI_PLAYER_MARGIN),
            y: Math.max(
                MINI_PLAYER_CONTROL_HEIGHT + 12,
                contentHeight - height - MINI_PLAYER_MARGIN
            ),
            width,
            height,
        });
    }

    private applyBounds(
        view: ManagedBrowserView,
        requestedBounds: BrowserViewBounds
    ): void {
        const bounds = clampBounds(requestedBounds);
        view.bounds = bounds;
        if (!view.view.nativeView) browserGuestRegistry.setDisplayMode(view.owner, view.mode, view.displayMode, view.isFullscreen);
        view.view.setBounds(view.view.nativeView ?
            toNativeViewBounds(bounds, {zoomFactor: view.owner.webContents.getZoomFactor()}) : bounds);

    }

    private bringArmMiniPlayerToFront(): void {
        const mini = this.youtubeView;
        const owner = this.owner;
        if (
            !mini ||
            mini.displayMode !== 'mini' ||
            !owner ||
            owner.isDestroyed()
        ) {
            return;
        }

        if (mini.view.nativeView) owner.contentView.removeChildView(mini.view.nativeView);
        if (mini.view.nativeView) owner.contentView.addChildView(mini.view.nativeView);
    }

    private bindEvents(view: ManagedBrowserView): void {
        const contents = view.view.webContents;
        contents.once('destroyed', () => {
            const wasPrimary = this.activeView === view || (!this.activeView && this.youtubeView === view && view.displayMode === 'mini');
            if (this.activeView === view) this.activeView = null;
            if (this.youtubeView === view) this.youtubeView = null;
            this.publish(wasPrimary ? 'closed' : undefined);
        });
        contents.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) {
                void shell.openExternal(url);
            }
            return { action: 'deny' };
        });

        contents.on('did-start-loading', () => this.publish('loading', view));
        contents.on('did-stop-loading', () => {
            view.error = '';
            this.publish('ready', view);
        });
        contents.on('did-navigate', () => this.publish(undefined, view));
        contents.on('did-navigate-in-page', () => this.publish(undefined, view));
        contents.on('page-title-updated', () => this.publish(undefined, view));
        if (view.mode === 'youtube') {
            contents.on('enter-html-full-screen', () => {
                void this.enterYoutubeFullscreen(view);
            });
            contents.on('leave-html-full-screen', () =>
                this.leaveYoutubeFullscreen(view)
            );
        }
        contents.on('did-fail-load', (_event, errorCode, errorDescription) => {
            if (errorCode === -3) {
                return;
            }
            view.error = errorDescription || 'The page could not be loaded.';
            this.publish('failed', view);
        });
        contents.on('render-process-gone', (_event, details) => {
            view.error = `The browser page stopped unexpectedly (${details.reason}).`;
            this.publish('failed', view);
        });
        contents.on('will-navigate', (event, url) => {
            try {
                normalizeUrl(url, view.mode);
            } catch (error) {
                event.preventDefault();
                view.error =
                    error instanceof Error ? error.message : String(error);
                this.publish('failed', view);
            }
        });
    }

    private snapshot(status?: BrowserViewState['status']): BrowserViewState {
        const primary = this.activeView ??
            (this.youtubeView?.displayMode === 'mini'
                ? this.youtubeView
                : null);
        const contents = primary?.view.webContents;
        const miniPlayer =
            this.youtubeView?.displayMode === 'mini'
                ? this.toMiniPlayerState(this.youtubeView)
                : undefined;
        return {
            id: 'main-browser-view',
            mode: primary?.mode ?? 'browser',
            displayMode: primary?.displayMode ?? 'full',
            url: contents?.getURL() || '',
            title: contents?.getTitle() || contents?.getURL() || '',
            status: status ?? (primary?.error ? 'failed' : 'ready'),
            canGoBack: contents?.canGoBack() ?? false,
            canGoForward: contents?.canGoForward() ?? false,
            isMuted: contents?.isAudioMuted() ?? false,
            bounds: primary?.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
            isFullscreen: primary?.isFullscreen ?? false,
            ...(miniPlayer ? { miniPlayer } : {}),
            ...(primary?.error ? { error: primary.error } : {}),
        };
    }

    private toMiniPlayerState(
        view: ManagedBrowserView
    ): BrowserMiniPlayerState {
        const contents = view.view.webContents;
        return {
            mode: 'youtube',
            url: contents.getURL(),
            title: contents.getTitle() || contents.getURL(),
            bounds: view.bounds,
            isMuted: contents.isAudioMuted(),
        };
    }

    private publish(
        status?: BrowserViewState['status'],
        source?: ManagedBrowserView
    ): void {
        const owner = this.owner;
        if (!owner || owner.isDestroyed()) {
            return;
        }
        const primary = this.activeView ??
            (this.youtubeView?.displayMode === 'mini'
                ? this.youtubeView
                : null);
        try {
            owner.webContents.send(BROWSER_VIEW_UPDATE, this.snapshot(!source || source === primary ? status : undefined));
        } catch { /* A crashed owner renderer cannot receive guest teardown updates. */ }
    }

    private disposeActiveView(): void {
        const view = this.activeView;
        if (!view) {
            return;
        }
        this.activeView = null;
        if (view === this.youtubeView) {
            this.youtubeView = null;
        }
        this.disposeView(view);
    }

    private disposeYoutubeView(): void {
        const view = this.youtubeView;
        if (!view) {
            return;
        }
        this.youtubeView = null;
        if (this.activeView === view) {
            this.activeView = null;
        }
        this.disposeView(view);
    }

    private detachView(view: ManagedBrowserView): void {
        const owner = view.owner;
        if (!owner.isDestroyed()) {
            if (view.view.nativeView) owner.contentView.removeChildView(view.view.nativeView);
        }
        if (!view.view.webContents.isDestroyed()) {
            view.view.setVisible(false);
        }
    }

    private disposeView(view: ManagedBrowserView): void {
        const owner = view.owner;
        if (view.isFullscreen) {
            this.leaveYoutubeFullscreen(view);
        }
        if (!view.view.webContents.isDestroyed()) {
            view.view.webContents.setAudioMuted(true);
            void view.view.webContents
                .executeJavaScript(
                    "Array.from(document.querySelectorAll('video, audio')).forEach(element => element.pause())",
                    true
                )
                .catch(() => undefined);
            if (view.miniPlayerCssKey) {
                void view.view.webContents
                    .removeInsertedCSS(view.miniPlayerCssKey)
                    .catch(() => undefined);
            }
        }
        view.miniPlayerCssKey = undefined;
        if (!owner.isDestroyed()) {
            if (view.view.nativeView) owner.contentView.removeChildView(view.view.nativeView);
        }
        if (!view.view.webContents.isDestroyed()) {
            view.view.setVisible(false);
            view.view.webContents.stop();
            view.view.webContents.close({ waitForBeforeUnload: false });
        }
    }

    private disposeAll(): void {
        const active = this.activeView;
        const youtube = this.youtubeView;
        this.activeView = null;
        this.youtubeView = null;
        if (active) {
            this.disposeView(active);
        }
        if (youtube && youtube !== active) {
            this.disposeView(youtube);
        }
        this.unbindOwner();
    }

    private unbindOwner(): void {
        if (this.owner && this.ownerResizeHandler) {
            this.owner.removeListener('resize', this.ownerResizeHandler);
        }
        this.ownerResizeHandler = null;
        this.owner = null;
    }
}

export const browserViewService = new BrowserViewService();

import type {
  BrowserWindow,
  WebContents,
  WebContentsView,
  WebPreferences,
} from "electron";
import type {
  BrowserViewBounds,
  BrowserViewMode,
  BrowserGuestSurfaceState,
} from "@arm-nator/shared/interfaces";

export const BROWSER_GUEST_PARTITION = "persist:arm-nator-browser";
const MODE_ARGUMENT = "--arm-nator-browser-guest=";
const SURFACES_CHANNEL = "BROWSER:GUEST_SURFACES";

export interface BrowserSurface {
  readonly webContents: WebContents;
  readonly nativeView?: WebContentsView;
  setBounds(bounds: BrowserViewBounds): void;
  setVisible(visible: boolean): void;
}
interface GuestSurface extends BrowserSurface {
  readonly mode: BrowserViewMode;
  bounds: BrowserViewBounds;
  visible: boolean;
  displayMode?: "full" | "mini";
  isFullscreen?: boolean;
}
interface OwnerGuests {
  readonly authorized: Set<number>;
  readonly surfaces: Map<BrowserViewMode, GuestSurface>;
}

/** Only app-owned, sandboxed guests may back the full-page browser surface. */
export class BrowserGuestRegistry {
  private readonly owners = new WeakMap<BrowserWindow, OwnerGuests>();
  constructor(private readonly youtubePreload: string) {}

  bind(owner: BrowserWindow): void {
    if (this.owners.has(owner)) return;
    const state: OwnerGuests = { authorized: new Set(), surfaces: new Map() };
    this.owners.set(owner, state);
    owner.webContents.on(
      "will-attach-webview",
      (event, preferences, params) => {
        const mode =
          params.src === "about:blank#arm-nator-browser"
            ? "browser"
            : params.src === "about:blank#arm-nator-youtube"
              ? "youtube"
              : null;
        if (!mode || params.partition !== BROWSER_GUEST_PARTITION) {
          event.preventDefault();
          return;
        }
        const secure: Partial<WebPreferences> = {
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          nodeIntegrationInWorker: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          contextIsolation: mode !== "youtube",
          additionalArguments: [MODE_ARGUMENT + mode],
        };
        Object.assign(preferences, secure);
        delete preferences.preload;
        if (mode === "youtube") preferences.preload = this.youtubePreload;
      },
    );
    owner.webContents.on("did-attach-webview", (_event, guest) => {
      if (guest.hostWebContents !== owner.webContents) return;
      state.authorized.add(guest.id);
      guest.once("destroyed", () => {
        state.authorized.delete(guest.id);
        for (const [mode, surface] of state.surfaces) {
          if (surface.webContents === guest) state.surfaces.delete(mode);
        }
        this.publish(owner, state);
      });
    });
    owner.once("closed", () => {
      for (const surface of state.surfaces.values()) {
        if (!surface.webContents.isDestroyed())
          surface.webContents.close({ waitForBeforeUnload: false });
      }
      this.owners.delete(owner);
    });
  }

  register(
    owner: BrowserWindow,
    guest: WebContents,
    mode: BrowserViewMode,
  ): BrowserSurface {
    const state = this.owners.get(owner);
    if (
      !state ||
      guest.isDestroyed() ||
      guest.hostWebContents !== owner.webContents ||
      !state.authorized.has(guest.id)
    )
      throw new Error(
        "Browser guest is not authorized for this window and mode.",
      );
    const current = state.surfaces.get(mode);
    if (!current && guest.getURL() !== "about:blank#arm-nator-" + mode)
      throw new Error("Browser guest mode is not authorized.");
    if (current) {
      if (current.webContents !== guest)
        throw new Error("A browser guest already owns this mode.");
      return current;
    }
    const surface: GuestSurface = {
      webContents: guest,
      mode,
      visible: false,
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      setBounds: (bounds) => {
        surface.bounds = { ...bounds };
        this.publish(owner, state);
      },
      setVisible: (visible) => {
        surface.visible = visible;
        this.publish(owner, state);
      },
    };
    state.surfaces.set(mode, surface);
    this.publish(owner, state);
    return surface;
  }

  get(owner: BrowserWindow, mode: BrowserViewMode): BrowserSurface | undefined {
    const surface = this.owners.get(owner)?.surfaces.get(mode);
    return surface && !surface.webContents.isDestroyed() ? surface : undefined;
  }

  setDisplayMode(
    owner: BrowserWindow,
    mode: BrowserViewMode,
    displayMode: "full" | "mini",
    isFullscreen = false,
  ): void {
    const state = this.owners.get(owner);
    const surface = state?.surfaces.get(mode);
    if (
      state &&
      surface &&
      (surface.displayMode !== displayMode ||
        surface.isFullscreen !== isFullscreen)
    ) {
      surface.displayMode = displayMode;
      surface.isFullscreen = isFullscreen;
      this.publish(owner, state);
    }
  }

  private publish(owner: BrowserWindow, state: OwnerGuests): void {
    if (owner.isDestroyed() || owner.webContents.isDestroyed()) return;
    const surfaces: BrowserGuestSurfaceState[] = [
      ...state.surfaces.values(),
    ].map((surface) => ({
      id: surface.webContents.id,
      mode: surface.mode,
      bounds: surface.bounds,
      visible: surface.visible,
      ...(surface.displayMode ? { displayMode: surface.displayMode } : {}),
      ...(surface.isFullscreen !== undefined
        ? { isFullscreen: surface.isFullscreen }
        : {}),
    }));
    try {
      owner.webContents.send(SURFACES_CHANNEL, surfaces);
    } catch {
      /* Owner renderer recovery disposes its guest tags and native sessions. */
    }
  }
}

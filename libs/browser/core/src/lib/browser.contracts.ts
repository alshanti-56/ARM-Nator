export type BrowserTabStatus =
  | "idle"
  | "loading"
  | "ready"
  | "failed"
  | "closed";

export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly faviconUrl?: string;
  readonly status: BrowserTabStatus;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly isMuted: boolean;
}

export interface BrowserOpenOptions {
  readonly active?: boolean;
  readonly userAgent?: string;
}

export type BrowserCommand =
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "back" }
  | { readonly type: "forward" }
  | { readonly type: "reload" }
  | { readonly type: "stop" }
  | { readonly type: "set-muted"; readonly muted: boolean }
  | { readonly type: "open-devtools" };

export interface BrowserTabManager {
  list(): Promise<readonly BrowserTab[]>;
  open(url: string, options?: BrowserOpenOptions): Promise<BrowserTab>;
  close(tabId: string): Promise<void>;
  activate(tabId: string): Promise<void>;
  execute(tabId: string, command: BrowserCommand): Promise<void>;
  subscribe(listener: (tabs: readonly BrowserTab[]) => void): () => void;
}

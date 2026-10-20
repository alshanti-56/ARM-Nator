import { Injectable, inject, signal, OnDestroy } from "@angular/core";
import { NativeCompositionService } from "@arm-nator/player/ui";
import type {
  BrowserGuestSurfaceState,
  BrowserViewMode,
} from "@arm-nator/shared/interfaces";

export interface BrowserGuestEntry {
  readonly key: number;
  readonly mode: BrowserViewMode;
  readonly id?: number;
  readonly seen: boolean;
  readonly surface?: BrowserGuestSurfaceState;
}
interface PendingGuest {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Keeps YouTube's guest alive while parked or floating across workspace routes. */
@Injectable({ providedIn: "root" })
export class BrowserGuestHostService implements OnDestroy {
  readonly composition = inject(NativeCompositionService);
  private readonly current = signal<BrowserGuestEntry[]>([]);
  readonly entries = this.current.asReadonly();
  private readonly pending = new Map<number, PendingGuest>();
  private nextKey = 0;
  private readonly unsubscribe = this.composition.enabled
    ? window.electron.onBrowserGuestSurfaces?.((surfaces) =>
        this.update(surfaces),
      )
    : undefined;

  ensure(mode: BrowserViewMode): Promise<void> {
    if (!this.composition.enabled) return Promise.resolve();
    if (!window.electron.registerBrowserGuest)
      return Promise.reject(new Error("Browser guest support is unavailable."));
    const existing = this.current().find((entry) => entry.mode === mode);
    if (existing)
      return this.pending.get(existing.key)?.promise ?? Promise.resolve();
    const key = ++this.nextKey;
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const timeout = setTimeout(
      () =>
        this.fail(
          key,
          new Error("The browser guest did not attach. Try again."),
        ),
      7000,
    );
    this.pending.set(key, { promise, resolve, reject, timeout });
    this.current.update((entries) => [...entries, { key, mode, seen: false }]);
    return promise;
  }

  async attached(key: number, id: number): Promise<void> {
    const entry = this.current().find((value) => value.key === key);
    if (!entry || !this.pending.has(key)) return;
    this.current.update((entries) =>
      entries.map((value) => (value.key === key ? { ...value, id } : value)),
    );
    try {
      const register = window.electron.registerBrowserGuest;
      if (!register) throw new Error("Browser guest support is unavailable.");
      await register(id, entry.mode);
      const pending = this.pending.get(key);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(key);
      pending.resolve();
    } catch (error) {
      this.fail(
        key,
        error instanceof Error
          ? error
          : new Error("Browser guest registration failed."),
      );
    }
  }

  cancelPending(mode: BrowserViewMode): void {
    for (const entry of this.current()) {
      if (entry.mode === mode && this.pending.has(entry.key))
        this.fail(entry.key, new Error("Browser opening was cancelled."));
    }
  }

  private update(surfaces: BrowserGuestSurfaceState[]): void {
    this.current.update((entries) =>
      entries.flatMap((entry) => {
        const surface = surfaces.find((value) => value.id === entry.id);
        if (surface) return [{ ...entry, surface, seen: true }];
        return entry.seen ? [] : [entry];
      }),
    );
  }

  private fail(key: number, error: Error): void {
    const pending = this.pending.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(key);
      pending.reject(error);
    }
    this.current.update((entries) =>
      entries.filter((entry) => entry.key !== key),
    );
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
    for (const key of this.pending.keys())
      this.fail(key, new Error("Browser host closed."));
    this.current.set([]);
  }
}

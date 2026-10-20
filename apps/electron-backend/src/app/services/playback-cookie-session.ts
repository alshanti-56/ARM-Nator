import { CookieJar, type Cookie } from "tough-cookie";

const MAX_COOKIES = 64;
const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_SET_COOKIE_BYTES = 4 * 1024;
const MAX_SET_COOKIES_PER_RESPONSE = 32;

function networkUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function cookieName(pair: string): string | null {
  const separator = pair.indexOf("=");
  if (separator <= 0) return null;
  return pair.slice(0, separator).trim();
}

function manualCookiePairs(header: string): string[] {
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => cookieName(pair) !== null);
}

/** In-memory cookies shared only by the resources in one playback session. */
export class PlaybackCookieSession {
  private readonly jar = new CookieJar(undefined, {
    rejectPublicSuffixes: true,
    prefixSecurity: "strict",
    allowSecureOnLocal: false,
  });
  private readonly manualMaskJar = new CookieJar(undefined, {
    rejectPublicSuffixes: true,
    prefixSecurity: "strict",
    allowSecureOnLocal: false,
  });
  private readonly sourceOrigin: string;
  private readonly manualCookieNames: ReadonlySet<string>;
  private suppressManualCookieHeader = false;
  private manualCookie: string | undefined;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(sourceOrigin: string, manualCookie?: string) {
    const source = networkUrl(sourceOrigin);
    if (!source) throw new TypeError("Playback cookie source must be HTTP(S).");
    this.sourceOrigin = source.origin;
    this.manualCookie = manualCookie?.trim() || undefined;
    this.manualCookieNames = new Set(
      manualCookiePairs(this.manualCookie ?? "")
        .map((pair) => cookieName(pair))
        .filter((name): name is string => name !== null),
    );
  }

  async getCookieHeader(
    targetUrl: string,
    includeManual = true,
  ): Promise<string | undefined> {
    const target = networkUrl(targetUrl);
    if (!target || this.disposed) return undefined;
    try {
      return await this.serialize(async () => {
        if (this.disposed) return undefined;
        const cookies = await this.jar.getCookies(target);
        const learned = cookies.map((cookie) => cookie.cookieString());
        let overrideCookies: Cookie[] = [];
        try {
          overrideCookies = await this.manualMaskJar.getCookies(target);
        } catch {
          // A mask lookup failure must not block cookies already in the main jar.
        }
        const learnedNames = new Set([
          ...cookies.map((cookie) => cookie.key),
          ...overrideCookies.map((cookie) => cookie.key),
        ]);
        const manual =
          includeManual &&
          !this.suppressManualCookieHeader &&
          target.origin === this.sourceOrigin &&
          this.manualCookie
            ? manualCookiePairs(this.manualCookie).filter(
                (pair) => !learnedNames.has(cookieName(pair) ?? ""),
              )
            : [];
        const value = [...learned, ...manual].join("; ");
        return value || undefined;
      });
    } catch {
      // Cookie handling must never turn an otherwise valid media request into an error.
      return undefined;
    }
  }

  async storeSetCookieHeaders(
    responseUrl: string,
    setCookieHeaders: readonly string[],
  ): Promise<void> {
    const response = networkUrl(responseUrl);
    if (!response || this.disposed) return;
    try {
      await this.serialize(async () => {
        if (this.disposed) return;
        for (const rawCookie of setCookieHeaders.slice(
          0,
          MAX_SET_COOKIES_PER_RESPONSE,
        )) {
          if (
            this.disposed ||
            Buffer.byteLength(rawCookie, "utf8") > MAX_SET_COOKIE_BYTES
          ) {
            continue;
          }
          try {
            const cookie = await this.jar.setCookie(rawCookie, response, {
              ignoreError: true,
            });
            if (this.disposed) return;
            if (cookie && this.manualCookieNames.has(cookie.key)) {
              await this.storeManualCookieMask(cookie, response);
            }
            if (!this.disposed) await this.enforceBounds();
          } catch {
            // Invalid provider cookies are ignored without changing playback behavior.
          }
        }
      });
    } catch {
      // Cookie storage is opportunistic; it must not fail the upstream response.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manualCookie = undefined;
    void this.serialize(async () => {
      await Promise.all([
        this.jar.removeAllCookies(),
        this.manualMaskJar.removeAllCookies(),
      ]);
      this.suppressManualCookieHeader = false;
    }).catch(() => undefined);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async enforceBounds(): Promise<void> {
    let cookies = await this.jar.store.getAllCookies();
    const now = Date.now();
    const expired = cookies.filter((cookie) => {
      const expiry = cookie.expiryTime();
      return expiry !== undefined && Number.isFinite(expiry) && expiry <= now;
    });
    for (const cookie of expired) await this.remove(cookie);
    if (expired.length) {
      cookies = cookies.filter((cookie) => !expired.includes(cookie));
    }

    const serializedSize = (): number => {
      const serialized = this.jar.serializeSync();
      return Buffer.byteLength(JSON.stringify(serialized ?? { cookies: [] }));
    };
    cookies.sort((left, right) => this.creationTime(left) - this.creationTime(right));
    while (
      cookies.length > MAX_COOKIES ||
      serializedSize() > MAX_SERIALIZED_BYTES
    ) {
      const oldest = cookies.shift();
      if (!oldest) break;
      await this.remove(oldest);
    }
  }

  private async storeManualCookieMask(
    cookie: Cookie,
    responseUrl: URL,
  ): Promise<void> {
    const mask = cookie.clone();
    if (!mask) return;
    mask.value = "";
    mask.expires = "Infinity";
    mask.maxAge = null;
    await this.manualMaskJar.setCookie(mask, responseUrl, { ignoreError: true });

    const masks = await this.manualMaskJar.store.getAllCookies();
    masks.sort((left, right) => this.creationTime(left) - this.creationTime(right));
    const serializedSize = (): number => {
      const serialized = this.manualMaskJar.serializeSync();
      return Buffer.byteLength(JSON.stringify(serialized ?? { cookies: [] }));
    };
    while (
      masks.length > MAX_COOKIES ||
      serializedSize() > MAX_SERIALIZED_BYTES
    ) {
      const oldest = masks.shift();
      if (!oldest) break;
      await this.manualMaskJar.store.removeCookie(
        oldest.domain,
        oldest.path,
        oldest.key,
      );
      // Once scoped masks overflow, suppress all manual cookies for this source.
      // This is coarse but prevents a revoked value from returning after eviction.
      this.suppressManualCookieHeader = true;
    }
  }

  private creationTime(cookie: Cookie): number {
    return cookie.creation instanceof Date ? cookie.creation.getTime() : 0;
  }

  private async remove(cookie: Cookie): Promise<void> {
    await this.jar.store.removeCookie(cookie.domain, cookie.path, cookie.key);
  }
}

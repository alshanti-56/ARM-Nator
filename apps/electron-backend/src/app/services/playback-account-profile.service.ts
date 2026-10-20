import { CookieJar } from "tough-cookie";

const MAX_ACCOUNT_REF_LENGTH = 200;
const MAX_SET_COOKIE_BYTES = 4 * 1024;
const MAX_COOKIES_PER_ACCOUNT = 64;
const MAX_SERIALIZED_COOKIE_BYTES = 64 * 1024;

export interface PlaybackPortalCredentials {
  username: string;
  password: string;
}

type PlaybackAccountProfile = {
  cookies: CookieJar;
  portalCredentials?: PlaybackPortalCredentials;
  portalHeaders?: Record<string, string>;
};

export interface PlaybackRecoveryAvailability {
  loginCookies: boolean;
  portalCredentials: boolean;
}

function validAccountRef(accountRef: unknown): accountRef is string {
  return typeof accountRef === "string" &&
    accountRef.trim().length > 0 &&
    accountRef.length <= MAX_ACCOUNT_REF_LENGTH &&
    !/[\r\n\0]/.test(accountRef);
}

function validHttpUrl(value: string): URL | null {
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

function normalizeCredentials(
  credentials: PlaybackPortalCredentials | undefined,
): PlaybackPortalCredentials | undefined {
  if (!credentials) return undefined;
  if (
    typeof credentials.username !== "string" ||
    typeof credentials.password !== "string" ||
    !credentials.username.trim() ||
    !credentials.password.trim() ||
    /[\r\n]/.test(credentials.username) ||
    /[\r\n]/.test(credentials.password)
  ) {
    return undefined;
  }
  return {
    username: credentials.username.trim(),
    password: credentials.password,
  };
}

function normalizePortalHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const allowed = new Set([
    "accept",
    "authorization",
    "cookie",
    "origin",
    "referer",
    "sn",
    "user-agent",
    "x-user-agent",
  ]);
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (
      allowed.has(key) &&
      typeof value === "string" &&
      value.trim() &&
      !/[\r\n\0]/.test(value)
    ) {
      normalized[key] = value.trim();
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function createCookieJar(): CookieJar {
  return new CookieJar(undefined, {
    rejectPublicSuffixes: true,
    prefixSecurity: "strict",
    allowSecureOnLocal: false,
  });
}

/**
 * Holds API-login state in the Electron main process. Its cookie jars are
 * distinct from the per-playback jars: a playback session receives a frozen
 * snapshot only when its request policy explicitly selects login cookies.
 */
export class PlaybackAccountProfileService {
  private readonly profiles = new Map<string, PlaybackAccountProfile>();
  private readonly invalidationListeners = new Set<(accountRef?: string) => void>();

  onInvalidated(listener: (accountRef?: string) => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private notifyInvalidated(accountRef?: string): void {
    for (const listener of this.invalidationListeners) {
      try {
        listener(accountRef);
      } catch {
        // A consumer's cleanup failure must not prevent profile erasure.
      }
    }
  }

  replacePortalCredentials(
    accountRef: string,
    credentials: PlaybackPortalCredentials | undefined,
  ): void {
    if (!validAccountRef(accountRef)) return;
    const normalized = normalizeCredentials(credentials);
    const existing = this.profiles.get(accountRef);
    if (
      existing?.portalCredentials?.username === normalized?.username &&
      existing?.portalCredentials?.password === normalized?.password
    ) {
      return;
    }

    if (existing) {
      existing.cookies.removeAllCookiesSync();
      if (normalized) {
        existing.portalCredentials = normalized;
        this.notifyInvalidated(accountRef);
        return;
      }
      existing.portalCredentials = undefined;
      if (!existing.portalHeaders) this.profiles.delete(accountRef);
      this.notifyInvalidated(accountRef);
      return;
    }
    if (normalized) {
      const profile = this.profiles.get(accountRef) ?? { cookies: createCookieJar() };
      profile.portalCredentials = normalized;
      this.profiles.set(accountRef, profile);
    }
  }

  replacePortalHeaders(
    accountRef: string,
    headers: Record<string, string> | undefined,
  ): void {
    if (!validAccountRef(accountRef)) return;
    const normalized = normalizePortalHeaders(headers);
    const existing = this.profiles.get(accountRef);
    if (JSON.stringify(existing?.portalHeaders ?? {}) === JSON.stringify(normalized ?? {})) {
      return;
    }
    if (existing) {
      existing.cookies.removeAllCookiesSync();
      existing.portalHeaders = normalized;
      if (!existing.portalCredentials && !normalized) {
        this.profiles.delete(accountRef);
      }
    } else if (normalized) {
      this.profiles.set(accountRef, {
        cookies: createCookieJar(),
        portalHeaders: normalized,
      });
    }
    this.notifyInvalidated(accountRef);
  }

  captureLoginCookies(
    accountRef: string | undefined,
    responseUrl: string,
    setCookieHeaders: readonly string[] | undefined,
    credentials?: PlaybackPortalCredentials,
  ): void {
    if (!accountRef || !validAccountRef(accountRef)) return;
    const url = validHttpUrl(responseUrl);
    if (!url) return;

    if (credentials) {
      this.replacePortalCredentials(accountRef, credentials);
    }
    const values = (setCookieHeaders ?? []).slice(0, 32).filter(
      (value) => typeof value === "string" &&
        Buffer.byteLength(value, "utf8") <= MAX_SET_COOKIE_BYTES,
    );
    if (values.length === 0) return;

    let profile = this.profiles.get(accountRef);
    if (!profile) {
      profile = { cookies: createCookieJar() };
      this.profiles.set(accountRef, profile);
    }
    for (const value of values) {
      try {
        profile.cookies.setCookieSync(value, url.toString(), {
          ignoreError: true,
        });
      } catch {
        // Invalid provider cookies are ignored without affecting API login.
      }
    }

    const snapshot = profile.cookies.serializeSync();
    if (
      snapshot.cookies.length > MAX_COOKIES_PER_ACCOUNT ||
      Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SERIALIZED_COOKIE_BYTES
    ) {
      profile.cookies.removeAllCookiesSync();
    }
  }

  snapshot(accountRef: string | undefined): {
    cookies?: CookieJar;
    portalCredentials?: PlaybackPortalCredentials;
    portalHeaders?: Record<string, string>;
  } {
    if (!accountRef || !validAccountRef(accountRef)) return {};
    const profile = this.profiles.get(accountRef);
    if (!profile) return {};
    return {
      ...(profile.cookies.serializeSync().cookies.length > 0
        ? { cookies: CookieJar.deserializeSync(profile.cookies.serializeSync()) }
        : {}),
      ...(profile.portalCredentials
        ? { portalCredentials: { ...profile.portalCredentials } }
        : {}),
      ...(profile.portalHeaders
        ? { portalHeaders: { ...profile.portalHeaders } }
        : {}),
    };
  }

  getAvailability(accountRef: string | undefined): PlaybackRecoveryAvailability {
    if (!accountRef || !validAccountRef(accountRef)) {
      return { loginCookies: false, portalCredentials: false };
    }
    const profile = this.profiles.get(accountRef);
    return {
      loginCookies: Boolean(profile?.cookies.serializeSync().cookies.length),
      portalCredentials: Boolean(profile?.portalCredentials || profile?.portalHeaders),
    };
  }

  clear(accountRef: string | undefined): void {
    if (!accountRef || !validAccountRef(accountRef)) return;
    this.profiles.get(accountRef)?.cookies.removeAllCookiesSync();
    this.profiles.delete(accountRef);
    this.notifyInvalidated(accountRef);
  }

  clearAll(): void {
    for (const profile of this.profiles.values()) {
      profile.cookies.removeAllCookiesSync();
    }
    this.profiles.clear();
    this.notifyInvalidated();
  }
}

export const playbackAccountProfiles = new PlaybackAccountProfileService();

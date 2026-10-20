import {
  VideoPlayer,
  type PlaybackNetworkFailure,
  type ResolvedPortalPlayback,
} from "@arm-nator/shared/interfaces";
import { originalProviderPlayback } from "@arm-nator/player/core";
export type RecoveryActionId =
  | "retry"
  | "fresh-link"
  | "alternate-host"
  | "login-cookies"
  | "saved-headers"
  | "default-headers"
  | "portal-credentials"
  | "hls"
  | "mpegts"
  | "proxy"
  | "direct"
  | "engine"
  | "wait"
  | "license-proxy"
  | "help";
export interface RecoverySelection {
  id: RecoveryActionId;
  engine?: VideoPlayer;
}
export interface RecoveryEngine {
  id: VideoPlayer;
  labelKey: string;
  available: boolean;
  detail?: string;
}
export interface RecoveryAction {
  id: RecoveryActionId;
  labelKey: string;
  enabled: boolean;
  reasonKey?: string;
  suggested?: boolean;
}
export interface RecoveryActionOptions {
  playback: ResolvedPortalPlayback;
  canResolve: boolean;
  proxyAvailable: boolean;
  loginCookies: boolean;
  portalCredentials: boolean;
  drmAvailable: boolean;
  engines: readonly RecoveryEngine[];
  network?: PlaybackNetworkFailure;
  diagnosticCode?: string;
}
const key = (value: string) => `PLAYBACK_RECOVERY.${value}`;
function headerSignature(playback: ResolvedPortalPlayback): string {
  const headers = new Map(
    Object.entries(playback.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  if (playback.userAgent) headers.set("user-agent", playback.userAgent);
  if (playback.referer) headers.set("referer", playback.referer);
  if (playback.origin) headers.set("origin", playback.origin);
  return JSON.stringify(
    [...headers].sort(([left], [right]) => left.localeCompare(right)),
  );
}
export function buildRecoveryActions(
  options: RecoveryActionOptions,
): RecoveryAction[] {
  const { playback: p } = options;
  const metadata = p.recovery;
  const saved = metadata?.savedHeaders;
  const defaults = metadata?.defaultHeaders;
  const hasHeaders = !!(
    p.userAgent ||
    p.referer ||
    p.origin ||
    Object.keys(p.headers ?? {}).length
  );
  const changesHeaders = (action: RecoveryActionId) =>
    headerSignature(applyRecoveryAction(p, action)) !== headerSignature(p);
  const action = (
    id: RecoveryActionId,
    enabled: boolean,
    reason: string,
  ): RecoveryAction => ({
    id,
    labelKey: key(id),
    enabled,
    ...(!enabled ? { reasonKey: key(reason) } : {}),
  });
  const actions = [
    action("retry", true, ""),
    action("fresh-link", options.canResolve, "NO_RESOLVER"),
    action(
      "alternate-host",
      !!metadata?.alternateHostUrl &&
        metadata.alternateHostUrl !== (p.originalStreamUrl ?? p.streamUrl),
      "NO_HOST",
    ),
    action(
      "login-cookies",
      options.proxyAvailable && options.loginCookies && !!metadata?.accountRef,
      options.proxyAvailable ? "NO_COOKIES" : "NO_PROXY",
    ),
    action(
      "saved-headers",
      !!saved && changesHeaders("saved-headers"),
      "SAME_HEADERS",
    ),
    action(
      "default-headers",
      !!defaults && changesHeaders("default-headers"),
      "SAME_HEADERS",
    ),
    action(
      "portal-credentials",
      options.proxyAvailable &&
        options.portalCredentials &&
        !!metadata?.accountRef,
      options.proxyAvailable ? "NO_PORTAL_PROFILE" : "NO_PROXY",
    ),
    action("hls", !!metadata?.formatUrls?.hls, "NO_FORMAT"),
    action("mpegts", !!metadata?.formatUrls?.mpegts, "NO_FORMAT"),
    action("proxy", options.proxyAvailable, "NO_PROXY"),
    action(
      "direct",
      !hasHeaders &&
        !Object.keys(p.drm?.licenseRequestHeaders ?? {}).length &&
        !p.requestPolicy?.loginCookies &&
        !p.requestPolicy?.portalCredentials,
      "DIRECT_HEADERS",
    ),
    action("engine", options.engines.length > 0, "NO_ENGINE"),
    action("wait", true, ""),
    action(
      "license-proxy",
      options.proxyAvailable &&
        !!p.drm?.licenseServerUrl &&
        options.drmAvailable,
      options.proxyAvailable ? "NO_DRM" : "NO_PROXY",
    ),
    action("help", true, ""),
  ];
  const status = options.network?.status;
  let suggested: RecoveryActionId = "retry";
  if (
    status === 429 ||
    status === 408 ||
    status === 425 ||
    (status != null && status >= 500)
  )
    suggested = "wait";
  else if (
    (status === 401 || status === 403) &&
    options.network?.resourceKind !== "license" &&
    options.canResolve
  )
    suggested = "fresh-link";
  else if (
    options.diagnosticCode === "browser-access-error" &&
    options.network?.resourceKind === "license" &&
    options.drmAvailable &&
    options.proxyAvailable
  )
    suggested = "license-proxy";
  else if (
    options.diagnosticCode === "browser-access-error" &&
    options.proxyAvailable
  )
    suggested = "proxy";
  else if (
    [
      "unsupported-codec",
      "unsupported-container",
      "media-decode-error",
    ].includes(options.diagnosticCode ?? "") &&
    options.engines.some((e) => e.available)
  )
    suggested = "engine";
  const index = actions.findIndex((a) => a.id === suggested && a.enabled);
  if (index >= 0) {
    const selected = actions.splice(index, 1)[0];
    selected.suggested = true;
    actions.unshift(selected);
  }
  return actions;
}
/** Always derive an experiment from the selection's original normal source. */
export function applyRecoveryAction(
  baseline: ResolvedPortalPlayback,
  action: RecoveryActionId,
): ResolvedPortalPlayback {
  const source = originalProviderPlayback(baseline);
  delete source.requestPolicy;
  delete source.transport;
  delete source.startPaused;
  const accountRef = source.recovery?.accountRef;
  if (action === "alternate-host")
    source.streamUrl = source.recovery?.alternateHostUrl ?? source.streamUrl;
  if (action === "hls" || action === "mpegts")
    source.streamUrl =
      source.recovery?.formatUrls?.[action] ?? source.streamUrl;
  if (action === "saved-headers" || action === "default-headers") {
    const profile =
      action === "saved-headers"
        ? source.recovery?.savedHeaders
        : source.recovery?.defaultHeaders;
    const headers = { ...source.headers };
    const profileNames = new Set([
      "user-agent",
      "x-user-agent",
      "referer",
      "origin",
      ...Object.keys(source.recovery?.savedHeaders ?? {}).map((name) =>
        name.toLowerCase(),
      ),
      ...Object.keys(source.recovery?.defaultHeaders ?? {}).map((name) =>
        name.toLowerCase(),
      ),
    ]);
    for (const name of Object.keys(headers))
      if (
        profileNames.has(name.toLowerCase()) &&
        !["cookie", "authorization"].includes(name.toLowerCase())
      )
        delete headers[name];
    source.headers = { ...headers, ...profile };
    delete source.userAgent;
    delete source.referer;
    delete source.origin;
  }
  if (action === "login-cookies")
    source.requestPolicy = { accountRef, loginCookies: true };
  if (action === "portal-credentials")
    source.requestPolicy = { accountRef, portalCredentials: true };
  if (action === "license-proxy")
    source.requestPolicy = { accountRef, licenseProxy: true };
  if (action === "proxy" || action === "direct") source.transport = action;
  return source;
}

/** Structured evidence only: absent/zero browser status is not HTTP rejection. */
export type PlaybackResourceKind =
  | "manifest"
  | "playlist"
  | "segment"
  | "encryption-key"
  | "license"
  | "unknown";
export interface PlaybackRecoveryIdentity {
  selectionId: number;
  attemptId: number;
}
export interface PlaybackNetworkFailure {
  status: number | null;
  resourceKind: PlaybackResourceKind;
  requestId?: string;
  retryAfterSeconds?: number;
  identity?: PlaybackRecoveryIdentity;
}
/** Main-process account reference. No cookies or bearer credentials belong in this policy. */
export interface PlaybackRequestPolicy {
  accountRef?: string;
  loginCookies?: boolean;
  portalCredentials?: boolean;
  licenseProxy?: boolean;
}
export interface PlaybackRecoveryMetadata {
  /** Set only when provider resolution can mint a fresh source. */
  providerLinkRenewable?: boolean;
  accountRef?: string;
  alternateHostUrl?: string;
  formatUrls?: { hls?: string; mpegts?: string };
  savedHeaders?: Record<string, string>;
  defaultHeaders?: Record<string, string>;
  /** True only when a main-process profile exists for this account. */
  portalCredentialsAvailable?: boolean;
}

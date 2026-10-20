import type { StalkerCredentialCandidate } from './stalker-credential-parser';

export type StalkerTestStatus =
  | 'pending'
  | 'testing'
  | 'working'
  | 'expired'
  | 'auth-rejected'
  | 'invalid-mac'
  | 'invalid-url'
  | 'offline'
  | 'server-error'
  | 'timeout'
  | 'cancelled'
  | 'unknown-error';

export interface StalkerTestResult {
  readonly id: string;
  readonly candidate: StalkerCredentialCandidate;
  status: StalkerTestStatus;
  message: string;
  selected: boolean;
  resolvedPortalUrl?: string;
  responseTimeMs?: number;
  accountStatus?: string;
  expiresAt?: number;
  tokenMode?: 'authenticated' | 'token-free';
  isFullStalkerPortal?: boolean;
  stalkerToken?: string;
  watchdogTimeoutSeconds?: number;
  timeslotSeconds?: number;
  accountInfo?: {
    login?: string;
    expireDate?: number;
    tariffPlanName?: string;
    status?: number;
  };
  lastCheckedAt?: number;
}

export const STALKER_TEST_FAILURE_STATUSES: ReadonlySet<StalkerTestStatus> = new Set([
  'expired',
  'auth-rejected',
  'invalid-mac',
  'invalid-url',
  'offline',
  'server-error',
  'timeout',
  'cancelled',
  'unknown-error',
]);

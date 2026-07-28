export type CredentialProvider = "xtream";

export interface CredentialTestInput {
  readonly id: string;
  readonly provider: CredentialProvider;
  readonly serverUrl: string;
  readonly username: string;
  readonly password: string;
}

export type CredentialTestStatus =
  | "queued"
  | "testing"
  | "valid"
  | "invalid"
  | "error"
  | "cancelled";

export interface CredentialAccountSummary {
  readonly status?: string;
  readonly expiresAt?: number;
  readonly activeConnections?: number;
  readonly maxConnections?: number;
  readonly allowedFormats?: readonly string[];
}

export interface CredentialTestResult {
  readonly id: string;
  readonly status: CredentialTestStatus;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly latencyMs?: number;
  readonly httpStatus?: number;
  readonly account?: CredentialAccountSummary;
  readonly message?: string;
}

export interface CredentialTestBatchOptions {
  readonly concurrency: number;
  readonly timeoutMs: number;
}

export interface CredentialTestProgress {
  readonly batchId: string;
  readonly total: number;
  readonly completed: number;
  readonly current: readonly CredentialTestResult[];
}

export interface CredentialTester {
  start(
    inputs: readonly CredentialTestInput[],
    options: CredentialTestBatchOptions,
  ): Promise<string>;
  cancel(batchId: string): Promise<void>;
  subscribe(
    batchId: string,
    listener: (progress: CredentialTestProgress) => void,
  ): () => void;
}

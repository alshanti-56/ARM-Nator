export type {
  CredentialAccountSummary,
  CredentialM3uTestInput,
  CredentialTestBatchLifecycleStatus,
  CredentialTestBatchOptions,
  CredentialTestInput,
  CredentialTestOutcome,
  CredentialTestProgress,
  CredentialTestProvider as CredentialProvider,
  CredentialTestResult,
  CredentialTestStatus,
  CredentialXtreamTestInput,
} from "@arm-nator/shared/interfaces";

import type {
  CredentialTestBatchOptions,
  CredentialTestInput,
  CredentialTestProgress,
} from "@arm-nator/shared/interfaces";

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

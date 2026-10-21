import type { SourceAccountSnapshot } from "@arm-nator/shared/interfaces";
import {
  validateSourceEvidenceWrite,
  validateSourceIds,
} from "../../database/operations/source-playback.operations";
import { handleWorkerRequest } from "./worker-events.utils";
handleWorkerRequest(
  "DB_GET_SOURCE_PLAYBACK_EVIDENCE",
  (sourceIds: unknown) => ({ sourceIds: validateSourceIds(sourceIds) }),
);
handleWorkerRequest("DB_SAVE_SOURCE_PLAYBACK_EVIDENCE", (input: unknown) =>
  validateSourceEvidenceWrite(input),
);
handleWorkerRequest(
  "DB_SAVE_SOURCE_PLAYBACK_ACCOUNT",
  (sourceId: string, revision: string, account: SourceAccountSnapshot) => ({
    sourceId,
    revision,
    account,
  }),
);

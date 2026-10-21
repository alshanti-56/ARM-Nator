import { Injectable, inject } from "@angular/core";
import type {
  SourceAccountSnapshot,
  SourceEvidenceWrite,
} from "@arm-nator/shared/interfaces";
import { DatabaseService } from "../database-electron.service";
@Injectable({ providedIn: "root" })
export class SourcePlaybackRepositoryService {
  private readonly db = inject(DatabaseService);
  read(sourceIds: readonly string[]) {
    return this.db.getSourcePlaybackEvidence([...sourceIds]);
  }
  write(input: SourceEvidenceWrite) {
    return this.db.saveSourcePlaybackEvidence(input);
  }
  writeAccount(
    sourceId: string,
    revision: string,
    account: SourceAccountSnapshot,
  ) {
    return this.db.saveSourcePlaybackAccount(sourceId, revision, account);
  }
}

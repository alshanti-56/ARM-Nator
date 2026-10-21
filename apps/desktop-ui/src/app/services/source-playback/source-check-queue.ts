import {
  sourceEvidenceKey,
  type SourceEvidenceKey,
} from "@arm-nator/shared/interfaces";
export class SourceCheckQueue {
  private readonly pending = new Map<string, SourceEvidenceKey>();
  private readonly operations = new Map<string, number>();
  get size() {
    return this.pending.size;
  }
  get busy(): ReadonlySet<string> {
    return new Set(this.operations.keys());
  }
  request(key: SourceEvidenceKey) {
    this.pending.set(sourceEvidenceKey(key), key);
  }
  cancel(sourceId: string) {
    for (const [id, key] of this.pending)
      if (key.sourceId === sourceId) this.pending.delete(id);
  }
  beginOperation(sourceId: string) {
    this.cancel(sourceId);
    this.operations.set(sourceId, (this.operations.get(sourceId) ?? 0) + 1);
  }
  endOperation(sourceId: string) {
    const count = (this.operations.get(sourceId) ?? 0) - 1;
    if (count > 0) this.operations.set(sourceId, count);
    else this.operations.delete(sourceId);
  }
  retain(keys: readonly SourceEvidenceKey[]) {
    const valid = new Set(keys.map(sourceEvidenceKey));
    for (const id of this.pending.keys())
      if (!valid.has(id)) this.pending.delete(id);
  }
  take(
    busy: ReadonlySet<string>,
    dueBySource: ReadonlyMap<string, number>,
    now: number,
  ): SourceEvidenceKey | null {
    for (const [id, key] of this.pending)
      if (
        !busy.has(key.sourceId) &&
        (dueBySource.get(key.sourceId) ?? 0) <= now
      ) {
        this.pending.delete(id);
        return key;
      }
    return null;
  }
}

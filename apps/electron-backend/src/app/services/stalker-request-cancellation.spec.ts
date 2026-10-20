import assert from "node:assert/strict";
import test from "node:test";
import { StalkerRequestCancellation } from "./stalker-request-cancellation";
test("cancellation is scoped to renderer ownership and releases completed requests", () => {
  const requests = new StalkerRequestCancellation();
  const a = requests.begin(1, "request"),
    b = requests.begin(2, "request");
  assert.equal(requests.cancel(2, "other"), false);
  assert.equal(requests.cancel(2, "request"), true);
  assert.equal(a.signal.aborted, false);
  assert.equal(b.signal.aborted, true);
  a.release();
  assert.equal(requests.cancel(1, "request"), false);
});
test("destroyed renderer cancels only its own work and bounded requests reject duplicates", () => {
  const requests = new StalkerRequestCancellation(1);
  const a = requests.begin(1, "a"),
    b = requests.begin(2, "b");
  assert.throws(() => requests.begin(1, "a"), /already/);
  assert.throws(() => requests.begin(1, "c"), /limit/);
  requests.cancelOwner(1);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, false);
  assert.doesNotThrow(() => requests.begin(1, "new").release());
});

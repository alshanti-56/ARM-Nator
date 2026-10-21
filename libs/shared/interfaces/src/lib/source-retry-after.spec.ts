import assert from "node:assert/strict";
import test from "node:test";
import { sourceRetryAfterMs } from "./source-retry-after";
test("parses provider Retry-After seconds and HTTP dates without accepting malformed delays", () => {
  assert.equal(sourceRetryAfterMs("120", 1000), 120000);
  assert.equal(
    sourceRetryAfterMs("Thu, 01 Jan 1970 00:02:00 GMT", 1000),
    119000,
  );
  assert.equal(sourceRetryAfterMs("-1", 1000), undefined);
  assert.equal(sourceRetryAfterMs("unknown", 1000), undefined);
});

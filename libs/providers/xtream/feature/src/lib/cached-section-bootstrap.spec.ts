import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapCachedSection } from "./cached-section-bootstrap";

test("renders usable cached content without waiting for authentication", async () => {
  let finishAuthentication!: (status: string) => void;
  let hydrated = false;
  const authentication = new Promise<string>((resolve) => {
    finishAuthentication = resolve;
  });
  const pending = bootstrapCachedSection({
    hasCache: async () => true,
    hydrate: async () => {
      hydrated = true;
    },
    authenticate: () => authentication,
  });
  const result = await Promise.race([
    pending,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
  ]);
  finishAuthentication("active");
  assert.equal(hydrated, true);
  assert.deepEqual(result, { cached: true, status: null });
});

test("an uncached section waits for account status; a stale section does not hydrate", async () => {
  assert.deepEqual(
    await bootstrapCachedSection({
      hasCache: async () => false,
      hydrate: async () => {
        throw new Error("unexpected hydration");
      },
      authenticate: async () => "expired",
    }),
    { cached: false, status: "expired" },
  );
  let current = true;
  assert.deepEqual(
    await bootstrapCachedSection({
      hasCache: async () => {
        current = false;
        return true;
      },
      isCurrent: () => current,
      hydrate: async () => {
        throw new Error("stale hydration");
      },
      authenticate: async () => "active",
    }),
    { cached: false, status: null },
  );
});

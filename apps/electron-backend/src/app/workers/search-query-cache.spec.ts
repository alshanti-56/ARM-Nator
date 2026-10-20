import assert from "node:assert/strict";
import test from "node:test";
import {
  SearchQueryCache,
  isSearchCatalogueMutation,
} from "./search-query-cache";

test('concurrent requests beyond the sharing bound account for retained rows correctly', async () => {
    const cache = new SearchQueryCache<number>(2, 10);
    const held = new Promise<number[]>(() => undefined);
    void cache.read('held-one', () => held);
    void cache.read('held-two', () => held);
    await Promise.all([cache.read('unshared', async () => [1]), cache.read('unshared', async () => [1])]);
    assert.equal(cache.retainedItems, 1);
});

test("repeated pages share results, with bounded retention and expiry", async () => {
  let now = 0;
  let calls = 0;
  const cache = new SearchQueryCache<number>(2, 3, 100, () => now);
  const read = (key: string) => cache.read(key, async () => [++calls]);
  assert.deepEqual(await read("a"), [1]);
  assert.deepEqual(await read("a"), [1]);
  await read("b");
  await read("c");
  assert.deepEqual(await read("a"), [4]);
  now = 101;
  assert.deepEqual(await read("a"), [5]);
  await cache.read("large", async () => [1, 2, 3, 4]);
  assert.equal(cache.retainedItems, 2);
});

test("a failed or invalidated in-flight query cannot populate the cache", async () => {
  const cache = new SearchQueryCache<number>();
  let complete!: (value: number[]) => void;
  const pending = cache.read(
    "old",
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await Promise.resolve();
  cache.clear();
  complete([1]);
  await pending;
  assert.deepEqual(await cache.read("old", async () => [2]), [2]);
  await assert.rejects(
    cache.read("failed", async () => {
      throw new Error("database failed");
    }),
  );
  assert.deepEqual(await cache.read("failed", async () => [3]), [3]);
});

test("catalogue/account/visibility writes invalidate search; reads and progress do not", () => {
  for (const operation of [
    "DB_REPLACE_XTREAM_CATALOGUE",
    "DB_UPDATE_XTREAM_CONTENT_METADATA",
    "DB_UPDATE_CATEGORY_VISIBILITY",
    "DB_DELETE_PLAYLIST",
    "DB_UPSERT_APP_PLAYLIST",
    "DB_SAVE_CONTENT",
    "FUTURE_WRITE",
  ]) {
    assert.equal(isSearchCatalogueMutation(operation), true, operation);
  }
  for (const operation of [
    "DB_GLOBAL_SEARCH",
    "DB_GET_CONTENT",
    "DB_GET_CATEGORIES",
    "DB_SAVE_PLAYBACK_POSITION",
    "DB_ADD_RECENT_ITEM",
  ]) {
    assert.equal(isSearchCatalogueMutation(operation), false, operation);
  }
});

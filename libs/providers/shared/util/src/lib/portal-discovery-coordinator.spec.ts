import assert from "node:assert/strict";
import test from "node:test";
import { PortalDiscoveryCoordinator } from "./portal-discovery-coordinator";
import type { DiscoveryVersion } from "@arm-nator/shared/interfaces";
const item = (id: string): DiscoveryVersion => ({
  identity: {
    sourceType: "stalker",
    playlistId: id,
    contentKind: "vod",
    providerItemId: "opaque",
  },
  originalTitle: id,
  providerName: id,
  categoryId: "cat",
  contentType: "movie",
  navigation: ["/workspace/stalker", id, "vod", "cat", "opaque"],
});
const sources = ["one", "two", "three"].map((id) => ({
  playlistId: id,
  providerName: id,
}));
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test("portal search starts only explicitly, bounds active portals at two and emits partial successes", async () => {
  let active = 0,
    max = 0;
  const gates = sources.map(() => deferred());
  const coordinator = new PortalDiscoveryCoordinator(
    async (source) => {
      active++;
      max = Math.max(max, active);
      await gates[sources.indexOf(source)].promise;
      active--;
      return { versions: [item(source.playlistId)] };
    },
    () => undefined,
  );
  assert.equal(active, 0);
  const run = coordinator.search(sources, "matrix", ["movie"]);
  assert.equal(active, 2);
  gates[0].resolve(null);
  await new Promise((r) => setImmediate(r));
  assert.equal(coordinator.snapshot.versions.length, 1);
  assert.equal(active, 2);
  gates[1].resolve(null);
  gates[2].resolve(null);
  await run;
  assert.equal(max, 2);
  assert.equal(coordinator.snapshot.versions.length, 3);
});
test("query cancellation drops stale responses and cancels in-flight work", async () => {
  const gate = deferred();
  let signal: AbortSignal | undefined;
  const coordinator = new PortalDiscoveryCoordinator(
    async (_s, _q, _p, s) => {
      signal = s;
      await gate.promise;
      return { versions: [item("old")] };
    },
    () => undefined,
  );
  const old = coordinator.search(sources.slice(0, 1), "old", ["movie"]);
  coordinator.cancel();
  assert.equal(signal?.aborted, true);
  await old;
  gate.resolve(null);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(coordinator.snapshot.versions, []);
});
test("deadline is per portal, failures retain partial results, and continuation does not duplicate pages", async () => {
  const coordinator = new PortalDiscoveryCoordinator(
    async (source, _q, page, signal) => {
      if (source.playlistId === "two")
        return new Promise((_r, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      return {
        versions: [item(source.playlistId)],
        continuation: page.page === 1 ? { ...page, page: 2 } : undefined,
      };
    },
    () => undefined,
    20,
  );
  await coordinator.search(sources.slice(0, 2), "matrix", ["movie"]);
  assert.equal(coordinator.snapshot.statuses[1].state, "error");
  assert.match(
    coordinator.snapshot.statuses[1].error ?? "",
    /10 seconds|deadline/,
  );
  assert.equal(coordinator.snapshot.versions.length, 1);
  await coordinator.continue("one");
  assert.equal(coordinator.snapshot.versions.length, 1);
  assert.equal(coordinator.snapshot.statuses[0].state, "error");
  assert.match(coordinator.snapshot.statuses[0].error ?? "", /repeated/);
});

test('a retention-bound failure keeps the previous page and its displayed source count intact',async()=>{
 const coordinator=new PortalDiscoveryCoordinator(async(source,_q,page)=>({versions:Array.from({length:page.page===1?4999:2},(_,i)=>({...item(source.playlistId),identity:{...item(source.playlistId).identity,providerItemId:String(page.page===1?i:i+4999)}})),continuation:page.page===1?{...page,page:2}:undefined}),()=>undefined);
 await coordinator.search(sources.slice(0,1),'movie',['movie']);await coordinator.continue('one');
 assert.equal(coordinator.snapshot.versions.length,4999);assert.equal(coordinator.snapshot.statuses[0].resultCount,4999);assert.match(coordinator.snapshot.statuses[0].error??'',/refine/);
});

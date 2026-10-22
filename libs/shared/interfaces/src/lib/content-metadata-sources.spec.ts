import assert from "node:assert/strict";
import test from "node:test";
import {
  preserveMetadataSources,
  metadataInfoForSource,
} from "./content-metadata-sources";

test("provider view retains the supplied values after TMDB replaces editorial fields", () => {
  const provider = {
    name: "Provider title",
    plot: "Provider plot",
    video: { codec: "h264" },
  };
  const metadataSources = preserveMetadataSources(undefined, provider, {
    title: "TMDB title",
    overview: "TMDB plot",
  });
  const item = { info: { ...provider, plot: "TMDB plot" }, metadataSources };
  assert.deepEqual(metadataInfoForSource(item, "provider"), provider);
  assert.equal(metadataInfoForSource(item, "tmdb")?.plot, "TMDB plot");
  assert.equal(metadataInfoForSource(item, "tmdb")?.video.codec, "h264");
  provider.video.codec = "changed";
  assert.equal(metadataSources.provider.video.codec, "h264");
});

test("repeated enrichment keeps the first provider snapshot", () => {
  const original = { name: "Original", plot: "Supplied plot" };
  const first = preserveMetadataSources(undefined, original, { id: 1 });
  const second = preserveMetadataSources(
    first,
    { ...original, plot: "Merged plot" },
    { id: 2 },
  );
  assert.equal(second.provider.plot, "Supplied plot");
  assert.equal(second.tmdb["id"], 2);
});

test("unenriched and missing metadata stay usable without inventing a source", () => {
  const item = { info: { name: "Provider only" } };
  assert.deepEqual(metadataInfoForSource(item, "provider"), item.info);
  assert.equal(metadataInfoForSource({ info: [] }, "provider"), null);
  assert.equal(metadataInfoForSource(null, "tmdb"), null);
});

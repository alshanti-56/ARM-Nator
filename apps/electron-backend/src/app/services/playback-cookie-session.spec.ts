import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackCookieSession } from "./playback-cookie-session";

test("playback cookies obey domain, path, expiry, deletion, Secure, and public-suffix rules", async () => {
  const cookies = new PlaybackCookieSession(
    "https://video.example.com:9443",
    "sid=manual-stale; keep=manual",
  );
  try {
    await cookies.storeSetCookieHeaders(
      "https://video.example.com:9443/dir/start.m3u8",
      [
        "sid=fresh; Path=/dir",
        "root=top; Path=/",
        "child=only; Path=/dir/child",
        "shared=domain; Domain=example.com; Path=/dir",
        "deleted=old; Path=/dir",
        "deleted=gone; Path=/dir; Max-Age=0",
        "expired=old; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
        "secure=private; Path=/; Secure",
        "public-suffix=bad; Domain=com; Path=/",
        "malformed-cookie; Path=/",
      ],
    );

    const childHeader = await cookies.getCookieHeader(
      "https://video.example.com:9443/dir/child/segment.ts",
    );
    assert.ok(childHeader?.includes("sid=fresh"));
    assert.ok(childHeader?.includes("child=only"));
    assert.ok(childHeader?.includes("shared=domain"));
    assert.ok(childHeader?.includes("root=top"));
    assert.ok(childHeader?.includes("secure=private"));
    assert.ok(childHeader?.includes("keep=manual"));
    assert.ok(!childHeader?.includes("sid=manual-stale"));
    assert.ok(!childHeader?.includes("deleted="));
    assert.ok(!childHeader?.includes("expired="));
    assert.ok(!childHeader?.includes("public-suffix="));

    const insecureHeader = await cookies.getCookieHeader(
      "http://video.example.com:9443/dir/child/segment.ts",
    );
    assert.ok(!insecureHeader?.includes("secure="));

    const otherPath = await cookies.getCookieHeader(
      "https://video.example.com:9443/elsewhere/segment.ts",
    );
    assert.ok(otherPath?.includes("root=top"));
    assert.ok(otherPath?.includes("sid=manual-stale"));
    assert.ok(!otherPath?.includes("sid=fresh"));
    assert.ok(!otherPath?.includes("child=only"));

    const siblingHost = await cookies.getCookieHeader(
      "https://cdn.example.com:9443/dir/segment.ts",
    );
    assert.ok(siblingHost?.includes("shared=domain"));
    assert.ok(!siblingHost?.includes("keep=manual"));

    const otherPort = await cookies.getCookieHeader(
      "https://video.example.com:9444/dir/segment.ts",
    );
    assert.ok(otherPort?.includes("sid=fresh"));
    assert.ok(!otherPort?.includes("sid=manual-stale"));
    assert.ok(!otherPort?.includes("keep=manual"));
  } finally {
    cookies.dispose();
  }
});

test("playback cookie storage bounds response input, cookie count, and serialized bytes", async () => {
  const cookies = new PlaybackCookieSession("https://bounded.example");
  try {
    await cookies.storeSetCookieHeaders(
      "https://bounded.example/path",
      Array.from({ length: 40 }, (_, index) => `batch0-${index}=v; Path=/`),
    );
    const firstResponseHeader = await cookies.getCookieHeader(
      "https://bounded.example/path",
    );
    assert.ok(firstResponseHeader?.includes("batch0-0=v"));
    assert.ok(!firstResponseHeader?.includes("batch0-32=v"));

    for (let batch = 1; batch <= 2; batch += 1) {
      await cookies.storeSetCookieHeaders(
        "https://bounded.example/path",
        Array.from(
          { length: 32 },
          (_, index) => `large-${batch}-${index}=${"x".repeat(1000)}; Path=/`,
        ),
      );
    }
    await cookies.storeSetCookieHeaders("https://bounded.example/path", [
      `too-large=${"x".repeat(4096)}; Path=/`,
    ]);

    const boundedHeader = await cookies.getCookieHeader(
      "https://bounded.example/path",
    );
    assert.ok(boundedHeader);
    assert.ok(Buffer.byteLength(boundedHeader) <= 64 * 1024);
    assert.ok(!boundedHeader.includes("too-large="));
    assert.ok(boundedHeader.includes("large-2-31="));
    assert.ok(!boundedHeader.includes("batch0-0="));
  } finally {
    cookies.dispose();
  }
});

test("playback cookie disposal clears state and rejects writes from late fetches", async () => {
  const cookies = new PlaybackCookieSession(
    "https://video.example.com",
    "provider=manual",
  );
  await cookies.storeSetCookieHeaders("https://cdn.example.net/", [
    "cdn=ready; Path=/",
  ]);
  assert.equal(
    await cookies.getCookieHeader("https://cdn.example.net/segment.ts"),
    "cdn=ready",
  );

  cookies.dispose();
  await cookies.storeSetCookieHeaders("https://cdn.example.net/", [
    "late=must-not-stick; Path=/",
  ]);
  assert.equal(
    await cookies.getCookieHeader("https://cdn.example.net/segment.ts"),
    undefined,
  );
  assert.equal(
    await cookies.getCookieHeader("https://video.example.com/playlist.m3u8"),
    undefined,
  );
});

test("a scoped learned replacement or deletion never revives the stale manual cookie", async () => {
  const cookies = new PlaybackCookieSession(
    "https://video.example.com:9443",
    "SID=manual; keep=manual",
  );
  try {
    await cookies.storeSetCookieHeaders(
      "https://video.example.com:9443/dir/start.m3u8",
      ["SID=new; Path=/dir"],
    );
    const replaced = await cookies.getCookieHeader(
      "https://video.example.com:9443/dir/segment.ts",
    );
    assert.ok(replaced?.includes("SID=new"));
    assert.ok(!replaced?.includes("SID=manual"));

    await cookies.storeSetCookieHeaders(
      "https://video.example.com:9443/dir/segment.ts",
      ["SID=; Path=/dir; Max-Age=0"],
    );
    const deleted = await cookies.getCookieHeader(
      "https://video.example.com:9443/dir/segment.ts",
    );
    assert.ok(!deleted?.includes("SID="));
    assert.ok(deleted?.includes("keep=manual"));

    const otherPath = await cookies.getCookieHeader(
      "https://video.example.com:9443/elsewhere/segment.ts",
    );
    assert.ok(otherPath?.includes("SID=manual"));

    await cookies.storeSetCookieHeaders(
      "https://video.example.com:9443/expired/start.m3u8",
      [
        "SID=expired; Path=/expired; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
      ],
    );
    const expiredReplacement = await cookies.getCookieHeader(
      "https://video.example.com:9443/expired/segment.ts",
    );
    assert.ok(!expiredReplacement?.includes("SID="));
    assert.ok(expiredReplacement?.includes("keep=manual"));
  } finally {
    cookies.dispose();
  }
});

test("manual-cookie override tracking stays bounded without reviving evicted names", async () => {
  const cookies = new PlaybackCookieSession(
    "https://video.example.com",
    "SID=manual; unrelated=manual",
  );
  try {
    for (let batch = 0; batch < 3; batch += 1) {
      await cookies.storeSetCookieHeaders(
        "https://video.example.com/root/seed",
        Array.from(
          { length: 32 },
          (_, index) => `SID=value-${batch}-${index}; Path=/scoped-${batch}-${index}/`,
        ),
      );
    }

    const header = await cookies.getCookieHeader(
      "https://video.example.com/root/segment.ts",
    );
    assert.ok(!header?.includes("SID=manual"));
    assert.ok(!header?.includes("unrelated=manual"));
    assert.ok(header === undefined || Buffer.byteLength(header) < 64 * 1024);
  } finally {
    cookies.dispose();
  }
});

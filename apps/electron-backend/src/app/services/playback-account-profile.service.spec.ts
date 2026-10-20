import assert from "node:assert/strict";
import test from "node:test";
import { PlaybackAccountProfileService } from "./playback-account-profile.service";

test("playback account profiles keep API cookies separate and clear on identity replacement", () => {
  const profiles = new PlaybackAccountProfileService();
  const invalidated: Array<string | undefined> = [];
  profiles.onInvalidated((accountRef) => invalidated.push(accountRef));

  profiles.replacePortalHeaders("playlist-a", {
    Cookie: "mac=00:1A:79:AA:BB:CC",
    Authorization: "Bearer first-token",
    SN: "serial-123",
    "X-User-Agent": "MAG250",
    "X-Not-Allowed": "discard-me",
  });
  profiles.captureLoginCookies(
    "playlist-a",
    "https://api.provider.test/player_api.php",
    ["auth-session=first; Path=/; HttpOnly"],
  );
  assert.deepEqual(profiles.getAvailability("playlist-a"), {
    loginCookies: true,
    portalCredentials: true,
  });
  assert.deepEqual(profiles.getAvailability("playlist-b"), {
    loginCookies: false,
    portalCredentials: false,
  });

  const snapshot = profiles.snapshot("playlist-a");
  assert.equal(
    snapshot.cookies?.getCookieStringSync("https://api.provider.test/live.ts"),
    "auth-session=first",
  );
  assert.deepEqual(snapshot.portalHeaders, {
    cookie: "mac=00:1A:79:AA:BB:CC",
    authorization: "Bearer first-token",
    sn: "serial-123",
    "x-user-agent": "MAG250",
  });
  assert.deepEqual(profiles.getAvailability("playlist-a"), {
    loginCookies: true,
    portalCredentials: true,
  });

  profiles.replacePortalHeaders("playlist-a", {
    Cookie: "mac=00:1A:79:AA:BB:CC",
    Authorization: "Bearer replacement-token",
    SN: "serial-123",
    "X-User-Agent": "MAG250",
  });
  assert.equal(
    profiles.snapshot("playlist-a").cookies?.serializeSync().cookies.length ?? 0,
    0,
    "changing the portal identity clears the old API cookie snapshot",
  );

  profiles.captureLoginCookies(
    "playlist-a",
    "https://api.provider.test/player_api.php",
    ["auth-session=second; Path=/; HttpOnly"],
  );
  profiles.replacePortalCredentials("playlist-a", {
    username: "new-user",
    password: "new-password",
  });
  assert.equal(
    profiles.snapshot("playlist-a").cookies?.serializeSync().cookies.length ?? 0,
    0,
    "replacing Xtream credentials also clears API cookies",
  );
  assert.ok(invalidated.filter((accountRef) => accountRef === "playlist-a").length >= 3);

  profiles.clear("playlist-a");
  assert.deepEqual(profiles.getAvailability("playlist-a"), {
    loginCookies: false,
    portalCredentials: false,
  });
});

test("Xtream credential replacement keeps the new identity after clearing login cookies", () => {
  const profiles = new PlaybackAccountProfileService();
  profiles.captureLoginCookies(
    "xtream-account",
    "https://api.provider.test/player_api.php",
    ["auth-session=old; Path=/; HttpOnly"],
  );
  profiles.replacePortalCredentials("xtream-account", {
    username: "new-user",
    password: "new-password",
  });

  assert.deepEqual(profiles.snapshot("xtream-account").portalCredentials, {
    username: "new-user",
    password: "new-password",
  });
  assert.deepEqual(profiles.getAvailability("xtream-account"), {
    loginCookies: false,
    portalCredentials: true,
  });
});

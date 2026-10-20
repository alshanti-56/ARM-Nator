import { strict as assert } from "node:assert";
import test from "node:test";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import {
  getDirectPlayNativeEngineAccess,
  getDirectPlayNativeSupport,
  getDirectPlayStaticCapabilities,
} from "./direct-play-capabilities";
import { hasStartedEmbeddedMpvSession, isUnexpectedEmbeddedMpvSession } from "./direct-play-native-session";

test("Direct Play ignores a neutral embedded MPV startup snapshot", () => {
  assert.equal(
    hasStartedEmbeddedMpvSession({
      engine: "embedded-mpv",
      available: true,
    }),
    false,
  );
});

test("Direct Play rejects a started embedded MPV session for KSPlayer Metal", () => {
  assert.equal(
    hasStartedEmbeddedMpvSession({
      engine: "embedded-mpv",
      available: true,
      sessionId: "embedded-session-1",
    }),
    true,
  );
  assert.equal(
    hasStartedEmbeddedMpvSession({
      engine: "embedded-mpv",
      sessionStatus: "playing",
    }),
    true,
  );
});

test("Direct Play probes MPV and KSPlayer Metal support independently", () => {
  const embedded = getDirectPlayNativeSupport(
    VideoPlayer.EmbeddedMpv,
    { available: true, engine: "embedded-mpv" },
    { supported: false, reason: "KSPlayer unavailable" },
  );
  const ksPlayer = getDirectPlayNativeSupport(
    VideoPlayer.KsPlayer,
    { available: true, engine: "embedded-mpv" },
    { supported: false, reason: "KSPlayer unavailable" },
  );

  assert.deepEqual(embedded, {
    available: true,
    detail: "embedded-mpv",
  });
  assert.deepEqual(ksPlayer, {
    available: false,
    detail: "KSPlayer unavailable",
  });
});

test("Direct Play keeps supported KSPlayer Metal independent of embedded MPV", () => {
  const embedded = getDirectPlayNativeSupport(
    VideoPlayer.EmbeddedMpv,
    { available: false, reason: "Embedded MPV unavailable" },
    { supported: true, runtimePath: "/Applications/ARM-Nator.app/KSPlayer" },
  );
  const ksPlayer = getDirectPlayNativeSupport(
    VideoPlayer.KsPlayer,
    { available: false, reason: "Embedded MPV unavailable" },
    { supported: true, runtimePath: "/Applications/ARM-Nator.app/KSPlayer" },
  );

  assert.deepEqual(embedded, {
    available: false,
    detail: "Embedded MPV unavailable",
  });
  assert.deepEqual(ksPlayer, {
    available: true,
    detail: "/Applications/ARM-Nator.app/KSPlayer",
  });
});

test("Direct Play blocks unavailable native engine selection and launch", () => {
  const access = getDirectPlayNativeEngineAccess(
    VideoPlayer.KsPlayer,
    { available: true, engine: "embedded-mpv" },
    { supported: false, reason: "KSPlayer unavailable" },
  );

  assert.deepEqual(access, {
    native: true,
    canSelect: false,
    canLaunch: false,
    detail: "KSPlayer unavailable",
  });
});

test("Direct Play lists only controls implemented by KSPlayer Metal", () => {
  assert.deepEqual(
    getDirectPlayStaticCapabilities(VideoPlayer.KsPlayer, false),
    ["Play / pause", "Seek", "Volume", "Fullscreen"],
  );
  assert.deepEqual(
    getDirectPlayStaticCapabilities(VideoPlayer.EmbeddedMpv, false),
    [
      "Play / pause",
      "Seek",
      "Volume",
      "Audio tracks",
      "Subtitles",
      "Speed",
      "Aspect",
      "Fullscreen",
    ],
  );
});

test("Direct Play allows an explicit workspace switch from KSPlayer to MPV", () => {
  const snapshot = {engine: "embedded-mpv", sessionId: "mpv-new"};
  assert.equal(isUnexpectedEmbeddedMpvSession(VideoPlayer.KsPlayer, VideoPlayer.EmbeddedMpv, snapshot), false);
  assert.equal(isUnexpectedEmbeddedMpvSession(VideoPlayer.KsPlayer, VideoPlayer.KsPlayer, snapshot), true);
  assert.equal(isUnexpectedEmbeddedMpvSession(VideoPlayer.ArtPlayer, VideoPlayer.ArtPlayer, snapshot), false);
});

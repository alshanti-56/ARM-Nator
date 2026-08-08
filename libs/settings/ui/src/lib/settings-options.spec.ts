import { strict as assert } from "node:assert";
import test from "node:test";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import { buildSettingsPlayerOptions } from "./settings-options";

function playerIds(options: ReturnType<typeof buildSettingsPlayerOptions>) {
  return options.map((option) => option.id);
}

test("settings keeps KS Player when embedded MPV is unsupported", () => {
  assert.deepEqual(
    playerIds(
      buildSettingsPlayerOptions({
        supportsEmbeddedMpv: false,
        supportsKsPlayerMetal: true,
        supportsManagedExternalPlayers: false,
      }),
    ),
    [VideoPlayer.ArtPlayer, VideoPlayer.Html5Player, VideoPlayer.KsPlayer],
  );
});

test("settings hides KS Player when it is unsupported", () => {
  assert.deepEqual(
    playerIds(
      buildSettingsPlayerOptions({
        supportsEmbeddedMpv: true,
        supportsKsPlayerMetal: false,
        supportsManagedExternalPlayers: false,
      }),
    ),
    [VideoPlayer.ArtPlayer, VideoPlayer.Html5Player, VideoPlayer.EmbeddedMpv],
  );
});

test("settings preserves web and external player ordering", () => {
  assert.deepEqual(
    playerIds(
      buildSettingsPlayerOptions({
        supportsEmbeddedMpv: false,
        supportsKsPlayerMetal: false,
        supportsManagedExternalPlayers: true,
      }),
    ),
    [
      VideoPlayer.ArtPlayer,
      VideoPlayer.Html5Player,
      VideoPlayer.MPV,
      VideoPlayer.VLC,
    ],
  );
});

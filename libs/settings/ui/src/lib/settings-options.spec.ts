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
    [
      VideoPlayer.ArtPlayer,
      VideoPlayer.ArtPlayer2,
      VideoPlayer.Html5Player,
      VideoPlayer.KsPlayer,
    ],
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
    [
      VideoPlayer.ArtPlayer,
      VideoPlayer.ArtPlayer2,
      VideoPlayer.Html5Player,
      VideoPlayer.EmbeddedMpv,
    ],
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
      VideoPlayer.ArtPlayer2,
      VideoPlayer.Html5Player,
      VideoPlayer.MPV,
      VideoPlayer.VLC,
    ],
  );
});

test("settings marks missing optional external players without removing them", () => {
  const options = buildSettingsPlayerOptions({
    supportsEmbeddedMpv: false,
    supportsKsPlayerMetal: false,
    supportsManagedExternalPlayers: true,
    externalPlayerAvailability: [
      { engine: VideoPlayer.MPV, available: false, reason: "mpv not found" },
      { engine: VideoPlayer.VLC, available: true, path: "/Applications/VLC.app" },
    ],
  });

  assert.deepEqual(
    options.filter((option) => option.id === VideoPlayer.MPV)[0],
    {
      id: VideoPlayer.MPV,
      labelKey: "SETTINGS.PLAYER_MPV",
      available: false,
      detail: "mpv not found",
    },
  );
  assert.equal(
    options.find((option) => option.id === VideoPlayer.VLC)?.available,
    true,
  );
});

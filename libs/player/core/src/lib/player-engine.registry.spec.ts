import { strict as assert } from "node:assert";
import test from "node:test";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import {
  getAvailablePlayerEngines,
  getPlayerEngine,
} from "./player-engine.registry";

function playerIds(
  capabilities: Parameters<typeof getAvailablePlayerEngines>[0],
): VideoPlayer[] {
  return getAvailablePlayerEngines(capabilities).map((engine) => engine.id);
}

test("filters embedded MPV and KSPlayer Metal independently", () => {
  assert.equal(getPlayerEngine(VideoPlayer.KsPlayer).kind, "ksplayer-metal");
  assert.deepEqual(
    playerIds({
      supportsEmbeddedMpv: false,
      supportsKsPlayerMetal: true,
      supportsManagedExternalPlayers: false,
    }),
    [VideoPlayer.ArtPlayer, VideoPlayer.Html5Player, VideoPlayer.KsPlayer],
  );
  assert.deepEqual(
    playerIds({
      supportsEmbeddedMpv: true,
      supportsKsPlayerMetal: false,
      supportsManagedExternalPlayers: false,
    }),
    [VideoPlayer.ArtPlayer, VideoPlayer.Html5Player, VideoPlayer.EmbeddedMpv],
  );
});

test("keeps web and managed external engine ordering unchanged", () => {
  assert.deepEqual(
    playerIds({
      supportsEmbeddedMpv: true,
      supportsKsPlayerMetal: true,
      supportsManagedExternalPlayers: true,
    }),
    [
      VideoPlayer.ArtPlayer,
      VideoPlayer.Html5Player,
      VideoPlayer.EmbeddedMpv,
      VideoPlayer.KsPlayer,
      VideoPlayer.MPV,
      VideoPlayer.VLC,
    ],
  );
});

import "@angular/compiler";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DestroyRef, Injector, signal } from "@angular/core";
import { MatSnackBar } from "@angular/material/snack-bar";
import { TranslateService } from "@ngx-translate/core";
import {
  WorkspaceViewCommandService,
  type WorkspaceCommandContribution,
} from "@arm-nator/providers/shared/util";
import { RuntimeCapabilitiesService, SettingsStore } from "@arm-nator/services";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import {
  PLAYER_COMMAND_DEFS,
  WorkspacePlayerCommandsContributor,
} from "./workspace-player-commands.contributor";

test("command palette probes KSPlayer Metal separately from embedded MPV", async () => {
  const calls: string[] = [];
  const registrations: WorkspaceCommandContribution[] = [];
  const previousWindow = (globalThis as { window?: unknown }).window;

  (globalThis as { window?: unknown }).window = {
    electron: {
      getEmbeddedMpvSupport: async () => {
        calls.push("embedded-mpv");
        return { supported: false };
      },
      getKsPlayerMetalSupport: async () => {
        calls.push("ksplayer-metal");
        return { supported: true };
      },
    },
  };

  const injector = Injector.create({
    providers: [
      {
        provide: WorkspaceViewCommandService,
        useValue: {
          registerCommand: (command: WorkspaceCommandContribution) => {
            registrations.push(command);
            return () => undefined;
          },
        },
      },
      {
        provide: SettingsStore,
        useValue: {
          player: signal(VideoPlayer.ArtPlayer),
          updateSettings: async () => undefined,
        },
      },
      { provide: MatSnackBar, useValue: { open: () => undefined } },
      {
        provide: TranslateService,
        useValue: { instant: (key: string) => key },
      },
      {
        provide: RuntimeCapabilitiesService,
        useValue: {
          supportsEmbeddedMpv: true,
          supportsManagedExternalPlayers: false,
        },
      },
      {
        provide: DestroyRef,
        useValue: { onDestroy: () => undefined },
      },
      WorkspacePlayerCommandsContributor,
    ],
  });

  try {
    const contributor = injector.get(WorkspacePlayerCommandsContributor);
    await contributor.ensureEmbeddedMpvSupportLoaded();

    assert.deepEqual(calls, ["embedded-mpv", "ksplayer-metal"]);
    assert.equal(
      PLAYER_COMMAND_DEFS.find(
        (definition) => definition.player === VideoPlayer.KsPlayer,
      )?.requires,
      "ksplayer-metal",
    );
    assert.equal(
      PLAYER_COMMAND_DEFS.find(
        (definition) => definition.player === VideoPlayer.ArtPlayer2,
      )?.id,
      "switch-player-artplayer2",
    );
    assert.equal(
      registrations
        .find((command) => command.id === "switch-player-artplayer2")
        ?.visible?.(),
      true,
    );
    assert.equal(
      registrations
        .find((command) => command.id === "switch-player-embedded-mpv")
        ?.visible?.(),
      false,
    );
    assert.equal(
      registrations
        .find((command) => command.id === "switch-player-ksplayer")
        ?.visible?.(),
      true,
    );
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
    injector.destroy();
  }
});

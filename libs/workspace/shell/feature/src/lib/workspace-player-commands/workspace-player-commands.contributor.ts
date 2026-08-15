import { DestroyRef, Injectable, inject, signal } from "@angular/core";
import { MatSnackBar } from "@angular/material/snack-bar";
import { TranslateService } from "@ngx-translate/core";
import {
  WorkspaceCommandContribution,
  WorkspaceViewCommandService,
} from "@arm-nator/providers/shared/util";
import { RuntimeCapabilitiesService, SettingsStore } from "@arm-nator/services";
import { VideoPlayer } from "@arm-nator/shared/interfaces";
import {
  isPlayerCommandVisible,
  type PlayerCommandRequirement,
} from "./workspace-player-command-capabilities";

interface PlayerCommandDefinition {
  id: string;
  player: VideoPlayer;
  icon: string;
  nameKey: string;
  keywords: readonly string[];
  requires: PlayerCommandRequirement;
  priority: number;
}

export const PLAYER_COMMAND_DEFS: readonly PlayerCommandDefinition[] = [
  {
    id: "switch-player-artplayer",
    player: VideoPlayer.ArtPlayer,
    icon: "play_circle",
    nameKey: "SETTINGS.PLAYER_ARTPLAYER",
    keywords: ["player", "artplayer", "web", "hls"],
    requires: "none",
    priority: 90,
  },
  {
    id: "switch-player-artplayer2",
    player: VideoPlayer.ArtPlayer2,
    icon: "play_circle",
    nameKey: "SETTINGS.PLAYER_ARTPLAYER2",
    keywords: ["player", "artplayer", "artplayer2", "stock", "web", "hls"],
    requires: "none",
    priority: 91,
  },
  {
    id: "switch-player-html5",
    player: VideoPlayer.Html5Player,
    icon: "play_circle",
    nameKey: "SETTINGS.PLAYER_HTML5",
    keywords: ["player", "html5", "web", "hls"],
    requires: "none",
    priority: 92,
  },
  {
    id: "switch-player-embedded-mpv",
    player: VideoPlayer.EmbeddedMpv,
    icon: "play_circle",
    nameKey: "SETTINGS.PLAYER_EMBEDDED_MPV",
    keywords: ["player", "embedded", "mpv", "native"],
    requires: "embedded-mpv",
    priority: 93,
  },
  {
    id: "switch-player-mpv",
    player: VideoPlayer.MPV,
    icon: "open_in_new",
    nameKey: "SETTINGS.PLAYER_MPV",
    keywords: ["player", "external", "mpv"],
    requires: "managed-external",
    priority: 94,
  },
  {
    id: "switch-player-ksplayer",
    player: VideoPlayer.KsPlayer,
    icon: "play_circle",
    nameKey: "SETTINGS.PLAYER_KSPLAYER",
    keywords: ["player", "embedded", "ksplayer", "hardware"],
    requires: "ksplayer-metal",
    priority: 95,
  },
  {
    id: "switch-player-vlc",
    player: VideoPlayer.VLC,
    icon: "open_in_new",
    nameKey: "SETTINGS.PLAYER_VLC",
    keywords: ["player", "external", "vlc"],
    requires: "managed-external",
    priority: 96,
  },
];

@Injectable({ providedIn: "root" })
export class WorkspacePlayerCommandsContributor {
  private readonly viewCommands = inject(WorkspaceViewCommandService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly snackBar = inject(MatSnackBar);
  private readonly translate = inject(TranslateService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly runtime = inject(RuntimeCapabilitiesService);
  private readonly embeddedMpvSupported = signal(false);
  private readonly ksPlayerMetalSupported = signal(false);
  private embeddedMpvSupportChecked = false;
  private embeddedMpvSupportLoad: Promise<void> | null = null;
  private ksPlayerMetalSupportChecked = false;
  private ksPlayerMetalSupportLoad: Promise<void> | null = null;

  constructor() {
    const unregisters = PLAYER_COMMAND_DEFS.map((def) =>
      this.viewCommands.registerCommand(this.toContribution(def)),
    );

    this.destroyRef.onDestroy(() => {
      for (const unregister of unregisters) {
        unregister();
      }
    });
  }

  ensureEmbeddedMpvSupportLoaded(): Promise<void> | undefined {
    const loads: Promise<void>[] = [];

    if (!this.embeddedMpvSupportChecked) {
      if (
        !this.runtime.supportsEmbeddedMpv ||
        typeof window === "undefined" ||
        !window.electron?.getEmbeddedMpvSupport
      ) {
        this.embeddedMpvSupportChecked = true;
      } else {
        this.embeddedMpvSupportLoad ??= this.loadEmbeddedMpvSupport();
        loads.push(this.embeddedMpvSupportLoad);
      }
    } else if (this.embeddedMpvSupportLoad) {
      loads.push(this.embeddedMpvSupportLoad);
    }

    if (!this.ksPlayerMetalSupportChecked) {
      if (
        typeof window === "undefined" ||
        !window.electron?.getKsPlayerMetalSupport
      ) {
        this.ksPlayerMetalSupportChecked = true;
      } else {
        this.ksPlayerMetalSupportLoad ??= this.loadKsPlayerMetalSupport();
        loads.push(this.ksPlayerMetalSupportLoad);
      }
    } else if (this.ksPlayerMetalSupportLoad) {
      loads.push(this.ksPlayerMetalSupportLoad);
    }

    return loads.length ? Promise.all(loads).then(() => undefined) : undefined;
  }

  private async loadEmbeddedMpvSupport(): Promise<void> {
    try {
      const support = await window.electron?.getEmbeddedMpvSupport?.();
      this.embeddedMpvSupported.set(!!support?.supported);
    } catch (error) {
      console.warn(
        "Failed to verify embedded MPV support for the command palette.",
        error,
      );
    } finally {
      this.embeddedMpvSupportChecked = true;
      this.embeddedMpvSupportLoad = null;
    }
  }

  private async loadKsPlayerMetalSupport(): Promise<void> {
    try {
      const support = await window.electron?.getKsPlayerMetalSupport?.();
      this.ksPlayerMetalSupported.set(!!support?.supported);
    } catch (error) {
      console.warn(
        "Failed to verify KS Player support for the command palette.",
        error,
      );
    } finally {
      this.ksPlayerMetalSupportChecked = true;
      this.ksPlayerMetalSupportLoad = null;
    }
  }

  private toContribution(
    def: PlayerCommandDefinition,
  ): WorkspaceCommandContribution {
    return {
      id: def.id,
      group: "global",
      icon: def.icon,
      labelKey: "WORKSPACE.SHELL.COMMANDS.SWITCH_PLAYER_LABEL",
      labelParams: () => ({ name: this.translate.instant(def.nameKey) }),
      descriptionKey: "WORKSPACE.SHELL.COMMANDS.SWITCH_PLAYER_DESCRIPTION",
      descriptionParams: () => ({
        name: this.translate.instant(def.nameKey),
      }),
      keywords: () => [
        ...def.keywords,
        this.translate.instant(def.nameKey).toLowerCase(),
      ],
      priority: def.priority,
      visible: () => this.isVisible(def),
      enabled: () =>
        this.settingsStore.livePlayer?.() !== def.player ||
        this.settingsStore.vodPlayer?.() !== def.player,
      run: () => this.activate(def),
    };
  }

  private isVisible(def: PlayerCommandDefinition): boolean {
    return isPlayerCommandVisible(def.requires, {
      supportsManagedExternalPlayers:
        this.runtime.supportsManagedExternalPlayers,
      supportsEmbeddedMpv: this.embeddedMpvSupported(),
      supportsKsPlayerMetal: this.ksPlayerMetalSupported(),
    });
  }

  private activate(def: PlayerCommandDefinition): void {
    void this.settingsStore.updateSettings({
      player: def.player,
      livePlayer: def.player,
      vodPlayer: def.player,
    });

    const name = this.translate.instant(def.nameKey);
    this.snackBar.open(
      this.translate.instant(
        "WORKSPACE.SHELL.COMMANDS.SWITCH_PLAYER_FEEDBACK",
        { name },
      ),
      undefined,
      {
        duration: 2500,
        horizontalPosition: "center",
        verticalPosition: "bottom",
      },
    );
  }
}

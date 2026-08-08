export type PlayerCommandRequirement =
  "none" | "managed-external" | "embedded-mpv" | "ksplayer-metal";

export function isPlayerCommandVisible(
  requirement: PlayerCommandRequirement,
  capabilities: {
    supportsManagedExternalPlayers: boolean;
    supportsEmbeddedMpv: boolean;
    supportsKsPlayerMetal: boolean;
  },
): boolean {
  switch (requirement) {
    case "managed-external":
      return capabilities.supportsManagedExternalPlayers;
    case "embedded-mpv":
      return capabilities.supportsEmbeddedMpv;
    case "ksplayer-metal":
      return capabilities.supportsKsPlayerMetal;
    default:
      return true;
  }
}

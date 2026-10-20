import { captureTrackPreference } from "@arm-nator/shared/interfaces";
import type {
  PlayerPreferenceIntent,
  PlayerSubtitleSettings,
} from "@arm-nator/shared/interfaces";
import type { PlayerControlsState } from "./player-controls.model";

export class PlayerPreferenceListeners {
  private readonly listeners = new Set<
    (intent: PlayerPreferenceIntent) => void
  >();
  subscribe(listener: (intent: PlayerPreferenceIntent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  track(
    kind: "audio" | "subtitle",
    id: number,
    state: PlayerControlsState,
  ): void {
    if (kind === "subtitle" && id === -1) {
      this.emit({ kind, preference: "off" });
      return;
    }
    const track = (
      kind === "audio" ? state.audioTracks : state.subtitleTracks
    ).find((track) => track.id === id);
    const preference = track ? captureTrackPreference(track) : null;
    if (preference) this.emit({ kind, preference });
  }
  settings(settings: PlayerSubtitleSettings): void {
    this.emit({ kind: "subtitle-settings", settings: { ...settings } });
  }
  private emit(intent: PlayerPreferenceIntent): void {
    for (const listener of this.listeners) {
      try {
        listener(intent);
      } catch (error) {
        console.error("Track preference observer failed:", error);
      }
    }
  }
}

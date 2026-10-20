import { matchPreferredTrack } from "./title-track-preferences";
import type {
  PlayerPreferenceIntent,
  TitleTrackPreferences,
  TrackRole,
} from "./title-track-preferences";
import type { PlayerSubtitleSettings } from "./player-subtitle-settings.interface";
interface PreferenceTrack {
  id: number;
  language?: string;
  role?: TrackRole;
  selected: boolean;
}
interface PreferenceState {
  audioTracks: readonly PreferenceTrack[];
  subtitleTracks: readonly PreferenceTrack[];
  subtitlesEnabled: boolean;
  subtitle: PlayerSubtitleSettings;
}
interface PreferenceCommands {
  audio?(id: number): void;
  subtitle?(id: number): void;
  settings?(settings: PlayerSubtitleSettings): void;
}
interface PreferenceConfig<T> {
  load(item: T): Promise<TitleTrackPreferences | null>;
  save(
    item: T,
    patch: TitleTrackPreferences,
    confirmedAt: number,
  ): Promise<void>;
  onError?(error: unknown): void;
}

function sameSettings(
  a: PlayerSubtitleSettings,
  b: PlayerSubtitleSettings,
): boolean {
  return (Object.keys(a) as (keyof PlayerSubtitleSettings)[]).every((key) =>
    typeof a[key] === "string"
      ? String(a[key]).toLowerCase() === String(b[key]).toLowerCase()
      : a[key] === b[key],
  );
}

/** Restore saved choices, but record only user commands that the engine confirms. */
export class TitlePreferenceCoordinator<T> {
  private generation = 0;
  private item: T | null = null;
  private preferences: TitleTrackPreferences = {};
  private pending: TitleTrackPreferences = {};
  private applied = { audio: false, subtitle: false, subtitleSettings: false };
  private loaded = false;
  private restoring = false;
  private lastConfirmedAt = 0;
  constructor(private readonly config: PreferenceConfig<T>) {}

  begin(item: T | null): void {
    const generation = ++this.generation;
    this.item = item;
    this.pending = {};
    this.preferences = {};
    this.applied = { audio: false, subtitle: false, subtitleSettings: false };
    this.loaded = false;
    if (item === null) return;
    void Promise.resolve()
      .then(() => this.config.load(item))
      .then((preferences) => {
        if (generation !== this.generation) return;
        this.preferences = preferences ?? {};
        this.loaded = true;
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.loaded = true;
          this.config.onError?.(error);
        }
      });
  }

  record(intent: PlayerPreferenceIntent): void {
    if (this.item === null || this.restoring) return;
    if (intent.kind === "audio") {
      this.pending.audio = intent.preference;
      this.applied.audio = true;
    } else if (intent.kind === "subtitle") {
      this.pending.subtitle = intent.preference;
      this.applied.subtitle = true;
    } else {
      this.pending.subtitleSettings = { ...intent.settings };
      this.applied.subtitleSettings = true;
    }
  }

  observe(state: PreferenceState, commands: PreferenceCommands): void {
    const item = this.item;
    if (item === null) return;
    const patch: TitleTrackPreferences = {};
    if (
      this.pending.audio &&
      matchPreferredTrack(
        state.audioTracks.filter((track) => track.selected),
        this.pending.audio,
      )
    ) {
      patch.audio = this.pending.audio;
      delete this.pending.audio;
    }
    if (this.pending.subtitle === "off" && !state.subtitlesEnabled) {
      patch.subtitle = "off";
      delete this.pending.subtitle;
    } else if (
      this.pending.subtitle &&
      this.pending.subtitle !== "off" &&
      state.subtitlesEnabled &&
      matchPreferredTrack(
        state.subtitleTracks.filter((track) => track.selected),
        this.pending.subtitle,
      )
    ) {
      patch.subtitle = this.pending.subtitle;
      delete this.pending.subtitle;
    }
    if (
      this.pending.subtitleSettings &&
      sameSettings(state.subtitle, this.pending.subtitleSettings)
    ) {
      patch.subtitleSettings = this.pending.subtitleSettings;
      delete this.pending.subtitleSettings;
    }
    if (Object.keys(patch).length) {
      this.preferences = { ...this.preferences, ...patch };
      this.lastConfirmedAt = Math.max(Date.now(), this.lastConfirmedAt + 1);
      void this.config
        .save(item, patch, this.lastConfirmedAt)
        .catch((error) => this.config.onError?.(error));
    }
    if (!this.loaded) return;
    this.restoring = true;
    try {
      const audio =
        !this.applied.audio && this.preferences.audio
          ? matchPreferredTrack(state.audioTracks, this.preferences.audio)
          : null;
      if (audio && commands.audio) {
        this.applied.audio = true;
        if (!audio.selected) commands.audio(audio.id);
      }
      if (!this.applied.subtitle && commands.subtitle) {
        if (this.preferences.subtitle === "off") {
          this.applied.subtitle = true;
          if (state.subtitlesEnabled) commands.subtitle(-1);
        } else if (this.preferences.subtitle) {
          const subtitle = matchPreferredTrack(
            state.subtitleTracks,
            this.preferences.subtitle,
          );
          if (subtitle) {
            this.applied.subtitle = true;
            if (!subtitle.selected || !state.subtitlesEnabled)
              commands.subtitle(subtitle.id);
          }
        }
      }
      if (
        !this.applied.subtitleSettings &&
        this.preferences.subtitleSettings &&
        commands.settings
      ) {
        this.applied.subtitleSettings = true;
        if (!sameSettings(state.subtitle, this.preferences.subtitleSettings))
          commands.settings(this.preferences.subtitleSettings);
      }
    } finally {
      this.restoring = false;
    }
  }
}

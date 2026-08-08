import { KsPlayerMetalControls } from "@arm-nator/shared/interfaces";

export const EMPTY_KSPLAYER_METAL_CONTROLS: KsPlayerMetalControls = {
  pause: false,
  seek: false,
  volume: false,
  audioTracks: false,
  subtitles: false,
  playbackSpeed: false,
  displayMode: false,
  aspectOverride: false,
  pictureAdjustments: false,
};

/** Normalizes additive runtime controls without advertising a missing addon API. */
export function normalizeKsPlayerMetalControls(
  value: unknown,
  supportsPictureAdjustments = false,
  supportsAspectOverride = false,
): KsPlayerMetalControls {
  const controls = value as Partial<KsPlayerMetalControls> | null;
  return {
    pause: controls?.pause === true,
    seek: controls?.seek === true,
    volume: controls?.volume === true,
    audioTracks: controls?.audioTracks === true,
    subtitles: controls?.subtitles === true,
    playbackSpeed: controls?.playbackSpeed === true,
    displayMode: controls?.displayMode === true,
    aspectOverride: supportsAspectOverride && controls?.aspectOverride === true,
    pictureAdjustments:
      supportsPictureAdjustments && controls?.pictureAdjustments === true,
  };
}

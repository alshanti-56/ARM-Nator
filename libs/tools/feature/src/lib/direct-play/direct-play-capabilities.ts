import {
  type KsPlayerMetalSupport,
  VideoPlayer,
} from "@arm-nator/shared/interfaces";

export interface DirectPlayEmbeddedSupport {
  available: boolean;
  reason?: string;
  engine?: string;
}

export interface DirectPlayNativeEngineAccess {
  readonly native: boolean;
  readonly canSelect: boolean;
  readonly canLaunch: boolean;
  readonly detail?: string;
}

export function isDirectPlayNativeEngine(engine: VideoPlayer): boolean {
  return engine === VideoPlayer.EmbeddedMpv || engine === VideoPlayer.KsPlayer;
}

export function getDirectPlayNativeSupport(
  engine: VideoPlayer,
  embeddedSupport: DirectPlayEmbeddedSupport | null,
  ksPlayerMetalSupport: KsPlayerMetalSupport | null,
): { available: boolean; detail: string } | null {
  if (engine === VideoPlayer.EmbeddedMpv) {
    const available = embeddedSupport?.available ?? false;
    return {
      available,
      detail: available
        ? (embeddedSupport?.engine ?? "Available")
        : (embeddedSupport?.reason ?? "Checking native runtime"),
    };
  }

  if (engine === VideoPlayer.KsPlayer) {
    const available = ksPlayerMetalSupport?.supported ?? false;
    return {
      available,
      detail: available
        ? (ksPlayerMetalSupport?.runtimePath ?? "Available")
        : (ksPlayerMetalSupport?.reason ?? "Checking native runtime"),
    };
  }

  return null;
}

/**
 * Bundled native engines share one strict access decision so UI selection and
 * launch paths cannot disagree. Optional external engines are checked by the
 * platform availability probe and gated separately by the controller.
 */
export function getDirectPlayNativeEngineAccess(
  engine: VideoPlayer,
  embeddedSupport: DirectPlayEmbeddedSupport | null,
  ksPlayerMetalSupport: KsPlayerMetalSupport | null,
): DirectPlayNativeEngineAccess {
  const support = getDirectPlayNativeSupport(
    engine,
    embeddedSupport,
    ksPlayerMetalSupport,
  );
  if (!support) {
    return { native: false, canSelect: true, canLaunch: true };
  }

  return {
    native: true,
    canSelect: support.available,
    canLaunch: support.available,
    detail: support.detail,
  };
}

export function getDirectPlayStaticCapabilities(
  engine: VideoPlayer,
  isLive: boolean,
): readonly string[] {
  switch (engine) {
    case VideoPlayer.EmbeddedMpv:
      return [
        "Play / pause",
        "Seek",
        "Volume",
        "Audio tracks",
        "Subtitles",
        "Speed",
        "Aspect",
        "Fullscreen",
      ];
    case VideoPlayer.KsPlayer:
      return ["Play / pause", "Seek", "Volume", "Fullscreen"];
    case VideoPlayer.ArtPlayer:
    case VideoPlayer.ArtPlayer2:
    case VideoPlayer.Html5Player:
      return [
        "Play / pause",
        isLive ? "Live timeline" : "Seek",
        "Volume",
        "Speed",
        "Picture in picture",
        "Fullscreen",
      ];
    case VideoPlayer.MPV:
    case VideoPlayer.VLC:
      return ["Controlled in external player"];
  }
}

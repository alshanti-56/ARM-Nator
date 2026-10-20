import type { AutoPlaybackPreparation } from "@arm-nator/shared/interfaces";

/** Return a browser-recognized media extension from response metadata. */
export function getPreparedProxyMediaExtension(
  preparedProxy: AutoPlaybackPreparation | undefined,
): string | undefined {
  if (!preparedProxy) {
    return undefined;
  }

  switch (preparedProxy.format) {
    case "hls":
      return "m3u8";
    case "mpegts":
      return "ts";
    case "dash":
      return "mpd";
    case "progressive":
      switch (preparedProxy.container) {
        case "mp4":
          return "mp4";
        case "webm":
          return "webm";
        case "matroska":
          return "mkv";
        default:
          return extensionFromMimeType(preparedProxy.mimeType);
      }
    default:
      return undefined;
  }
}

export function getPreparedProxyMimeType(
  preparedProxy: AutoPlaybackPreparation | undefined,
): string | undefined {
  const explicit = preparedProxy?.mimeType?.trim();
  if (!preparedProxy) {
    return explicit || undefined;
  }

  const detected = getDetectedMimeType(preparedProxy, explicit);
  if (!detected) {
    return preparedProxy.format === "progressive"
      ? undefined
      : explicit || undefined;
  }

  const explicitBase = getMimeBase(explicit);
  if (!explicitBase || !detected.compatibleBases.includes(explicitBase)) {
    return detected.canonical;
  }

  const codecParameters = getCodecParameters(explicit);
  return codecParameters.length > 0
    ? `${detected.canonical}; ${codecParameters.join("; ")}`
    : detected.canonical;
}

/** ArtPlayer's explicit type override for extensionless local proxy URLs. */
export function getPreparedProxyPlayerType(
  preparedProxy: AutoPlaybackPreparation | undefined,
): string | undefined {
  switch (preparedProxy?.format) {
    case "hls":
      return "m3u8";
    case "mpegts":
      return "ts";
    case "dash":
      return "mpd";
    case "progressive":
      switch (getPreparedProxyMediaExtension(preparedProxy)) {
        case "mp4":
          return "mp4";
        case "webm":
          return "webm";
        case "mkv":
          return "video/matroska";
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

function extensionFromMimeType(mimeType: string | undefined): string | undefined {
  switch (getMimeBase(mimeType)) {
    case "video/mp4":
      return "mp4";
    case "video/webm":
      return "webm";
    case "video/x-matroska":
    case "video/matroska":
      return "mkv";
    default:
      return undefined;
  }
}

interface DetectedMimeType {
  canonical: string;
  compatibleBases: string[];
}

function getDetectedMimeType(
  preparedProxy: AutoPlaybackPreparation,
  explicitMimeType: string | undefined,
): DetectedMimeType | undefined {
  switch (preparedProxy.format) {
    case "hls":
      return {
        canonical: "application/x-mpegURL",
        compatibleBases: [
          "application/x-mpegurl",
          "application/vnd.apple.mpegurl",
        ],
      };
    case "mpegts":
      return { canonical: "video/mp2t", compatibleBases: ["video/mp2t"] };
    case "dash":
      return {
        canonical: "application/dash+xml",
        compatibleBases: ["application/dash+xml"],
      };
    case "progressive":
      switch (preparedProxy.container) {
        case "mp4":
          return { canonical: "video/mp4", compatibleBases: ["video/mp4"] };
        case "webm":
          return {
            canonical: "video/webm",
            compatibleBases: ["video/webm"],
          };
        case "matroska":
          return {
            canonical: "video/x-matroska",
            compatibleBases: ["video/x-matroska", "video/matroska"],
          };
        default:
          return getDetectedProgressiveMimeType(explicitMimeType);
      }
    default:
      return undefined;
  }
}

function getDetectedProgressiveMimeType(
  mimeType: string | undefined,
): DetectedMimeType | undefined {
  switch (getMimeBase(mimeType)) {
    case "video/mp4":
      return { canonical: "video/mp4", compatibleBases: ["video/mp4"] };
    case "video/webm":
      return { canonical: "video/webm", compatibleBases: ["video/webm"] };
    case "video/x-matroska":
    case "video/matroska":
      return {
        canonical: "video/x-matroska",
        compatibleBases: ["video/x-matroska", "video/matroska"],
      };
    default:
      return undefined;
  }
}

function getMimeBase(mimeType: string | undefined): string | undefined {
  const base = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  return base || undefined;
}

function getCodecParameters(mimeType: string | undefined): string[] {
  return mimeType
    ?.split(";")
    .slice(1)
    .map((parameter) => parameter.trim())
    .filter((parameter) => /^codecs\s*=/i.test(parameter)) ?? [];
}

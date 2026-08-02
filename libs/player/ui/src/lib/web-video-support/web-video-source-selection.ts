const MPEG_TS_EXTENSIONS = new Set(["ts", "m2ts"]);
const HLS_EXTENSIONS = new Set(["m3u8"]);

const NATIVE_MIME_TYPES: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  flac: "audio/flac",
  m3u8: "application/vnd.apple.mpegurl",
  m4v: "video/x-m4v",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  ogv: "video/ogg",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  webm: "video/webm",
};

export function shouldUseMpegTs(extension: string): boolean {
  // Preserve the established extensionless IPTV fallback until content-type
  // probing can distinguish raw transport streams from manifest endpoints.
  return !extension || MPEG_TS_EXTENSIONS.has(extension);
}

export function shouldUseHls(extension: string): boolean {
  return HLS_EXTENSIONS.has(extension);
}

export function getNativeMediaMimeType(extension: string): string | undefined {
  return NATIVE_MIME_TYPES[extension];
}

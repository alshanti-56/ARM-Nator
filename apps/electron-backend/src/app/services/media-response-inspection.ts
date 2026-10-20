export type AutoPlaybackFormat =
  | "hls"
  | "mpegts"
  | "progressive"
  | "dash"
  | "unknown";

export type InspectedMediaContainer =
  | "hls"
  | "mpegts"
  | "mp4"
  | "webm"
  | "matroska"
  | "dash";

export interface InspectedMediaResponse {
  format: AutoPlaybackFormat;
  container?: InspectedMediaContainer;
  mimeType?: string;
  videoCodecs?: readonly string[];
  audioCodecs?: readonly string[];
  audioOnly?: boolean;
  encrypted?: boolean;
}

export type MediaInspectionErrorCode =
  | "http-error"
  | "html-response"
  | "startup-timeout"
  | "cancelled"
  | "unsupported-dash";

export class MediaInspectionError extends Error {
  constructor(
    readonly code: MediaInspectionErrorCode,
    readonly status: number | null,
    message: string,
    options?: ErrorOptions,
    readonly format?: AutoPlaybackFormat,
  ) {
    super(message, options);
    this.name = "MediaInspectionError";
  }
}

export interface InspectResponseOptions {
  readonly maxPrefixBytes?: number;
  readonly prefixTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onTimeout?: () => void;
}

export interface InspectedResponse {
  readonly response: Response;
  readonly media: InspectedMediaResponse;
}

const DEFAULT_PREFIX_BYTES = 8 * 1024;
const DEFAULT_PREFIX_TIMEOUT_MS = 15_000;

/** Classify reliable container signatures first, then MIME type, then URL suffix. */
export function inspectMediaPrefix(
  prefix: Uint8Array,
  contentType: string | null,
  sourceUrl: string,
  prefixComplete = false,
): InspectedMediaResponse {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const mediaTypeValue = contentType?.trim() || undefined;

  if (startsWithAscii(prefix, "#EXTM3U")) {
    return addHlsMetadata(
      { format: "hls", container: "hls", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) },
      new TextDecoder().decode(prefix),
      prefixComplete,
    );
  }
  if (isMpegTs(prefix)) {
    return { format: "mpegts", container: "mpegts", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) };
  }
  if (hasAsciiAt(prefix, 4, "ftyp")) {
    return { format: "progressive", container: "mp4", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) };
  }

  const ebmlDocType = readEbmlDocType(prefix);
  if (ebmlDocType === "webm") {
    return { format: "progressive", container: "webm", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) };
  }
  if (ebmlDocType === "matroska") {
    return { format: "progressive", container: "matroska", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) };
  }

  const text = new TextDecoder().decode(prefix);
  if (/<(?:[\w.-]+:)?MPD(?:\s|>)/i.test(text)) {
    return addDashMetadata(
      { format: "dash", container: "dash", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) },
      text,
      prefixComplete,
    );
  }

  if (isHtmlResponse(prefix, mediaType)) {
    return { format: "unknown", ...(mediaTypeValue ? { mimeType: mediaTypeValue } : {}) };
  }

  const byMime = inspectMimeType(mediaType, mediaTypeValue);
  if (byMime) return addAudioMimeMetadata(byMime, mediaType, contentType);
  return inspectUrlSuffix(sourceUrl, mediaTypeValue);
}

/** Read only a bounded prefix, then return a response that replays every byte. */
export async function inspectResponseForMedia(
  response: Response,
  sourceUrl: string,
  options: InspectResponseOptions = {},
): Promise<InspectedResponse> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaInspectionError(
      "http-error",
      response.status,
      `The source returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`,
    );
  }

  const maxPrefixBytes = Math.max(1, options.maxPrefixBytes ?? DEFAULT_PREFIX_BYTES);
  const prefixTimeoutMs = Math.max(1, options.prefixTimeoutMs ?? DEFAULT_PREFIX_TIMEOUT_MS);
  const prefixChunks: Uint8Array[] = [];
  let prefixBytes = 0;
  let prefixComplete = !response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let timeoutError: MediaInspectionError | undefined;
  let signalAbort: (() => void) | undefined;

  if (options.signal?.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw new MediaInspectionError("cancelled", response.status, "Media inspection was cancelled.", {
      cause: options.signal.reason,
    });
  }

  if (response.body) {
    reader = response.body.getReader();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        timeoutError = new MediaInspectionError(
          "startup-timeout",
          response.status,
          `The source did not provide enough media data within ${prefixTimeoutMs} ms.`,
        );
        options.onTimeout?.();
        reject(timeoutError);
      }, prefixTimeoutMs);
      timeout.unref?.();
    });
    const abortPromise = options.signal
      ? new Promise<never>((_resolve, reject) => {
          signalAbort = () =>
            reject(
              new MediaInspectionError("cancelled", response.status, "Media inspection was cancelled.", {
                cause: options.signal?.reason,
              }),
            );
          options.signal?.addEventListener("abort", signalAbort, { once: true });
        })
      : undefined;

    try {
      while (prefixBytes < maxPrefixBytes) {
        const read = reader.read();
        const { done, value } = await Promise.race([
          read,
          timeoutPromise,
          ...(abortPromise ? [abortPromise] : []),
        ]);
        if (done) {
          prefixComplete = true;
          break;
        }
        prefixChunks.push(value);
        prefixBytes += value.byteLength;
        const inspectedBytes = concatPrefix(prefixChunks, maxPrefixBytes);
        if (
          (hasAuthoritativeSignature(inspectedBytes) && !isManifestSignature(inspectedBytes)) ||
          isHtmlBody(inspectedBytes)
        ) {
          break;
        }
      }
    } catch (error) {
      if (timedOut || error instanceof MediaInspectionError) {
        await reader.cancel(error).catch(() => undefined);
        try { reader.releaseLock(); } catch { /* A pending read can retain its lock until abort settles. */ }
        if (timedOut && timeoutError) throw timeoutError;
        throw error;
      }
      if (options.signal?.aborted) {
        await reader.cancel(error).catch(() => undefined);
        try { reader.releaseLock(); } catch { /* A pending read can retain its lock until abort settles. */ }
        throw new MediaInspectionError("cancelled", response.status, "Media inspection was cancelled.", {
          cause: error,
        });
      }
      await reader.cancel(error).catch(() => undefined);
      try { reader.releaseLock(); } catch { /* A failed read can retain its lock until it settles. */ }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (signalAbort) options.signal?.removeEventListener("abort", signalAbort);
    }
  }

  const prefix = concatPrefix(prefixChunks, maxPrefixBytes);
  const hasMediaSignature = hasAuthoritativeSignature(prefix);
  const mediaType = normalizedMediaType(response.headers.get("content-type"));
  if (isHtmlBody(prefix) || (isHtmlMediaType(mediaType) && !hasMediaSignature)) {
    await reader?.cancel().catch(() => undefined);
    try { reader?.releaseLock(); } catch { /* Cancellation can settle after the pending read. */ }
    throw new MediaInspectionError(
      "html-response",
      response.status,
      "The source returned an HTML page instead of media. Check the provider credentials or stream URL.",
    );
  }

  const media = inspectMediaPrefix(prefix, response.headers.get("content-type"), sourceUrl, prefixComplete);
  if (reader && response.body) {
    return { response: replayResponse(response, reader, prefixChunks), media };
  }
  return { response, media };
}

function addAudioMimeMetadata(
  media: InspectedMediaResponse,
  mediaType: string | undefined,
  contentType: string | null,
): InspectedMediaResponse {
  if (!mediaType?.startsWith("audio/")) return media;
  const codecs = extractCodecParameter(contentType);
  const { audioCodecs } = splitCodecs(codecs);
  return {
    ...media,
    audioOnly: true,
    ...(audioCodecs.length ? { audioCodecs } : {}),
  };
}

function addHlsMetadata(
  media: InspectedMediaResponse,
  text: string,
  prefixComplete: boolean,
): InspectedMediaResponse {
  const variants = [...text.matchAll(/^\s*#EXT-X-STREAM-INF:([^\r\n]*)/gim)];
  const codecDeclarations = variants.map((match) => getAttribute(match[1] ?? "", "CODECS"));
  const parsedCodecs = codecDeclarations.flatMap((value) => value === null ? [] : splitCodecs([value]).all);
  const { videoCodecs, audioCodecs } = splitCodecs(parsedCodecs);
  const hasCompleteAudioOnlyDeclaration = prefixComplete &&
    variants.length > 0 &&
    codecDeclarations.every((value) => value !== null && splitCodecs([value]).all.length > 0) &&
    audioCodecs.length > 0 &&
    videoCodecs.length === 0 &&
    codecDeclarations.every((value) => splitCodecs(value === null ? [] : [value]).unknown.length === 0);
  const hasDrmKeyFormat = [...text.matchAll(/^\s*#EXT-X-KEY:([^\r\n]*)/gim)].some((match) => {
    const attributes = match[1] ?? "";
    const method = getAttribute(attributes, "METHOD")?.toUpperCase();
    const keyFormat = getAttribute(attributes, "KEYFORMAT") ?? "identity";
    return method !== "NONE" && keyFormat.toLowerCase() !== "identity";
  });

  return {
    ...media,
    ...(videoCodecs.length ? { videoCodecs } : {}),
    ...(audioCodecs.length ? { audioCodecs } : {}),
    ...(hasCompleteAudioOnlyDeclaration ? { audioOnly: true } : {}),
    ...(hasDrmKeyFormat ? { encrypted: true } : {}),
  };
}

function addDashMetadata(
  media: InspectedMediaResponse,
  text: string,
  prefixComplete: boolean,
): InspectedMediaResponse {
  const trackTags = [...text.matchAll(/<(?:[\w.-]+:)?(?:AdaptationSet|Representation)\b([^>]*)>/gi)];
  const allCodecs: string[] = [];
  let hasAudioTrack = false;
  let hasVideoTrack = false;
  for (const match of trackTags) {
    const attributes = match[1] ?? "";
    const codecValue = getAttribute(attributes, "codecs");
    const codecs = codecValue === null ? [] : splitCodecs([codecValue]).all;
    allCodecs.push(...codecs);
    const contentType = `${getAttribute(attributes, "mimeType") ?? ""} ${getAttribute(attributes, "contentType") ?? ""}`.toLowerCase();
    const classified = splitCodecs(codecs);
    hasAudioTrack ||= /(?:^|[\s/])audio(?:$|[\s/])/i.test(contentType) || classified.audioCodecs.length > 0;
    hasVideoTrack ||= /(?:^|[\s/])video(?:$|[\s/])/i.test(contentType) || classified.videoCodecs.length > 0;
  }
  const { videoCodecs, audioCodecs } = splitCodecs(allCodecs);
  const hasContentProtection = /<(?:[\w.-]+:)?ContentProtection\b/i.test(text);
  return {
    ...media,
    ...(videoCodecs.length ? { videoCodecs } : {}),
    ...(audioCodecs.length ? { audioCodecs } : {}),
    ...(prefixComplete && hasAudioTrack && !hasVideoTrack ? { audioOnly: true } : {}),
    ...(hasContentProtection ? { encrypted: true } : {}),
  };
}

function extractCodecParameter(contentType: string | null): string[] {
  if (!contentType) return [];
  const codecs = getAttribute(contentType.replace(/^.*?;/, ""), "codecs");
  return codecs === null ? [] : splitCodecs([codecs]).all;
}

function getAttribute(attributes: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[,;\\s])${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^,;\\s]+))`, "i").exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
}

function splitCodecs(values: readonly string[]): {
  all: string[];
  videoCodecs: string[];
  audioCodecs: string[];
  unknown: string[];
} {
  const unique = [...new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean))];
  const videoCodecs: string[] = [];
  const audioCodecs: string[] = [];
  const unknown: string[] = [];
  for (const codec of unique) {
    if (/^(?:avc1|avc3|hev1|hvc1|dvhe|dvh1|vp0?9|vp8|av01|theora)(?:\.|$)/i.test(codec)) {
      videoCodecs.push(codec);
    } else if (/^(?:mp4a|aac|ac-3|ec-3|ac-4|opus|vorbis|flac|alac|mp3|mha1|mhm1)(?:\.|$)/i.test(codec)) {
      audioCodecs.push(codec);
    } else {
      unknown.push(codec);
    }
  }
  return { all: unique, videoCodecs, audioCodecs, unknown };
}

function inspectMimeType(
  mediaType: string | undefined,
  mimeType: string | undefined,
): InspectedMediaResponse | null {
  if (!mediaType) return null;
  if (/(?:application|audio)\/(?:vnd\.apple\.|x-)?mpegurl/.test(mediaType)) {
    return { format: "hls", container: "hls", ...(mimeType ? { mimeType } : {}) };
  }
  if (mediaType === "video/mp2t" || mediaType === "video/mpegts") {
    return { format: "mpegts", container: "mpegts", ...(mimeType ? { mimeType } : {}) };
  }
  if (mediaType === "application/dash+xml") {
    return { format: "dash", container: "dash", ...(mimeType ? { mimeType } : {}) };
  }
  if (mediaType === "video/mp4" || mediaType === "video/quicktime" || mediaType === "application/mp4") {
    return { format: "progressive", container: "mp4", ...(mimeType ? { mimeType } : {}) };
  }
  if (mediaType === "video/webm") {
    return { format: "progressive", container: "webm", ...(mimeType ? { mimeType } : {}) };
  }
  if (mediaType.includes("matroska")) {
    return { format: "progressive", container: "matroska", ...(mimeType ? { mimeType } : {}) };
  }
  if (mediaType.startsWith("video/") || mediaType.startsWith("audio/")) {
    return { format: "progressive", ...(mimeType ? { mimeType } : {}) };
  }
  return null;
}

function inspectUrlSuffix(sourceUrl: string, mimeType: string | undefined): InspectedMediaResponse {
  const pathname = (() => {
    try {
      return new URL(sourceUrl).pathname.toLowerCase();
    } catch {
      return sourceUrl.split(/[?#]/, 1)[0].toLowerCase();
    }
  })();
  if (/\.m3u8?$/.test(pathname)) return { format: "hls", container: "hls", ...(mimeType ? { mimeType } : {}) };
  if (/\.ts$/.test(pathname)) return { format: "mpegts", container: "mpegts", ...(mimeType ? { mimeType } : {}) };
  if (/\.mpd$/.test(pathname)) return { format: "dash", container: "dash", ...(mimeType ? { mimeType } : {}) };
  if (/\.(?:mp4|m4v|mov)$/.test(pathname)) return { format: "progressive", container: "mp4", ...(mimeType ? { mimeType } : {}) };
  if (/\.webm$/.test(pathname)) return { format: "progressive", container: "webm", ...(mimeType ? { mimeType } : {}) };
  if (/\.mkv$/.test(pathname)) return { format: "progressive", container: "matroska", ...(mimeType ? { mimeType } : {}) };
  return { format: "unknown", ...(mimeType ? { mimeType } : {}) };
}

function hasAuthoritativeSignature(prefix: Uint8Array): boolean {
  return startsWithAscii(prefix, "#EXTM3U") || isMpegTs(prefix) || hasAsciiAt(prefix, 4, "ftyp") ||
    readEbmlDocType(prefix) !== null ||
    /<(?:[\w.-]+:)?MPD(?:\s|>)/i.test(new TextDecoder().decode(prefix));
}

function isManifestSignature(prefix: Uint8Array): boolean {
  return startsWithAscii(prefix, "#EXTM3U") ||
    /<(?:[\w.-]+:)?MPD(?:\s|>)/i.test(new TextDecoder().decode(prefix));
}

function readEbmlDocType(bytes: Uint8Array): "webm" | "matroska" | null {
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3
  ) {
    return null;
  }
  const headerSize = readEbmlVint(bytes, 4, false);
  if (!headerSize) return null;
  let offset = 4 + headerSize.width;
  const headerEnd = offset + headerSize.value;
  if (headerEnd > bytes.length) return null;

  while (offset < headerEnd) {
    const elementId = readEbmlVint(bytes, offset, true);
    if (!elementId) return null;
    const elementSize = readEbmlVint(bytes, offset + elementId.width, false);
    if (!elementSize) return null;
    const valueStart = offset + elementId.width + elementSize.width;
    const valueEnd = valueStart + elementSize.value;
    if (valueEnd > headerEnd) return null;
    if (elementId.value === 0x4282) {
      const docType = new TextDecoder().decode(bytes.subarray(valueStart, valueEnd)).toLowerCase();
      return docType === "webm" || docType === "matroska" ? docType : null;
    }
    offset = valueEnd;
  }
  return null;
}

function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { width: number; value: number } | null {
  const first = bytes[offset];
  if (first === undefined || first === 0) return null;
  let marker = 0x80;
  let width = 1;
  while (width <= 8 && (first & marker) === 0) {
    marker >>= 1;
    width += 1;
  }
  if (width > 8 || (keepMarker && width > 4) || offset + width > bytes.length) return null;

  let value = BigInt(keepMarker ? first : first & (marker - 1));
  for (let index = 1; index < width; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { width, value: Number(value) };
}

function startsWithAscii(bytes: Uint8Array, expected: string): boolean {
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  while (index < bytes.length && (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)) index += 1;
  if (bytes.length - index < expected.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    if (bytes[index + offset] !== expected.charCodeAt(offset)) return false;
  }
  return true;
}

function hasAsciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function isMpegTs(bytes: Uint8Array): boolean {
  for (const [stride, offset] of [[188, 0], [192, 4], [204, 0]] as const) {
    if (bytes.length < offset + stride * 2 + 1) continue;
    if (bytes[offset] === 0x47 && bytes[offset + stride] === 0x47 && bytes[offset + stride * 2] === 0x47) {
      return true;
    }
  }
  return false;
}

function isHtmlResponse(bytes: Uint8Array, mediaType: string | null): boolean {
  return isHtmlMediaType(mediaType) || isHtmlBody(bytes);
}

function isHtmlMediaType(mediaType: string | null): boolean {
  return mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function isHtmlBody(bytes: Uint8Array): boolean {
  let documentStart = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
  while (documentStart.startsWith("<!--")) {
    const commentEnd = documentStart.indexOf("-->");
    if (commentEnd < 0) return false;
    documentStart = documentStart.slice(commentEnd + 3).trimStart();
  }
  documentStart = documentStart.replace(/^<\?xml[^>]*>\s*/i, "");
  return /^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(documentStart);
}

function normalizedMediaType(contentType: string | null): string | null {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function concatPrefix(chunks: Uint8Array[], maxBytes: number): Uint8Array {
  const total = Math.min(maxBytes, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.byteLength, total - offset);
    output.set(chunk.subarray(0, count), offset);
    offset += count;
    if (offset === total) break;
  }
  return output;
}

function replayResponse(
  original: Response,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  prefixChunks: Uint8Array[],
): Response {
  const chunks = [...prefixChunks];
  let index = 0;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]);
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          closed = true;
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        closed = true;
        try { reader.releaseLock(); } catch { /* A pending read may still hold the lock. */ }
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      await reader.cancel(reason).catch(() => undefined);
      try { reader.releaseLock(); } catch { /* cancellation may finish after a pending read */ }
    },
  });
  const response = new Response(body, {
    status: original.status,
    statusText: original.statusText,
    headers: original.headers,
  });
  Object.defineProperty(response, "url", { value: original.url });
  return response;
}

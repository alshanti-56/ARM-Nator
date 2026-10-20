export interface SeekPreviewCue {
  start: number;
  end: number;
  url: string;
  crop?: { x: number; y: number; width: number; height: number };
}
export interface SeekPreviewSource {
  cues?: SeekPreviewCue[];
  vttUrl?: string;
  sprite?: {
    url: string;
    number: number;
    column: number;
    width: number;
    height: number;
  };
}

/** Preview loading never accepts a video URL. Only supplied image/VTT resources qualify. */
export function previewResourceUrl(
  value: unknown,
  kind: "image" | "vtt",
  base?: string,
): string | null {
  if (typeof value !== "string" || value.length > 250_000) return null;
  if (
    kind === "image" &&
    /^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(value)
  )
    return value;
  if (kind === "image" && value.startsWith("blob:")) return value;
  try {
    const url = new URL(value, base);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (
      !(kind === "vtt" ? /\.vtt$/i : /\.(?:jpe?g|png|webp|gif|avif)$/i).test(
        url.pathname,
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
function cue(value: unknown, base?: string): SeekPreviewCue | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const start = Number(row["start"]),
    end = Number(row["end"]);
  const url = previewResourceUrl(row["url"], "image", base);
  if (
    !url ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start
  )
    return null;
  const result: SeekPreviewCue = { start, end, url };
  const crop = row["crop"] as SeekPreviewCue["crop"];
  if (crop) {
    if (
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x + crop.width > 8192 ||
      crop.y + crop.height > 8192
    )
      return null;
    result.crop = crop;
  }
  return result;
}
export function readProviderSeekPreviews(
  metadata: unknown,
): SeekPreviewSource | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const data = metadata as Record<string, unknown>;
  for (const record of [data["info"], data, data["movie_data"]]) {
    if (!record || typeof record !== "object") continue;
    const row = record as Record<string, unknown>;
    const raw = row["seek_previews"] ?? row["thumbnails"];
    if (Array.isArray(raw)) {
      const cues = raw
        .slice(0, 1000)
        .map((value) => cue(value))
        .filter((value): value is SeekPreviewCue => !!value)
        .sort((a, b) => a.start - b.start);
      if (cues.length) return { cues };
    }
    const vttUrl = previewResourceUrl(
      row["thumbnails_vtt"] ??
        row["preview_vtt"] ??
        row["storyboard_vtt"] ??
        (typeof raw === "string" ? raw : undefined),
      "vtt",
    );
    if (vttUrl) return { vttUrl };
    if (raw && typeof raw === "object") {
      const sprite = raw as Record<string, unknown>,
        url = previewResourceUrl(sprite["url"], "image");
      const number = Number(sprite["number"]),
        column = Number(sprite["column"]),
        width = Number(sprite["width"]),
        height = Number(sprite["height"]);
      if (
        url &&
        [number, column, width, height].every(
          (value) => Number.isSafeInteger(value) && value > 0,
        ) &&
        number <= 1000 &&
        column * width <= 8192 &&
        Math.ceil(number / column) * height <= 8192
      )
        return { sprite: { url, number, column, width, height } };
    }
  }
  return undefined;
}
function time(value: string): number {
  if (!/^(?:\d+:)?[0-5]\d:[0-5]\d\.\d{3}$/.test(value)) return NaN;
  const parts = value.split(":").map(Number);
  return parts.length >= 2 && parts.length <= 3 && parts.every(Number.isFinite)
    ? parts.reduce((total, n) => total * 60 + n, 0)
    : NaN;
}
export function parseSeekPreviewVtt(
  text: string,
  base: string,
): SeekPreviewCue[] {
  if (text.length > 262144 || !/^\uFEFF?WEBVTT(?:\s|$)/.test(text)) return [];
  const result: SeekPreviewCue[] = [];
  for (const block of text.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n"),
      index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const match = lines[index].match(/^(\S+)\s+-->\s+(\S+)/),
      image = lines[index + 1]?.trim();
    if (!match || !image) continue;
    const [path, fragment] = image.split("#");
    const xywh = fragment?.match(/^xywh=(\d+),(\d+),(\d+),(\d+)$/);
    if (fragment && !xywh) continue;
    const parsed = cue(
      {
        start: time(match[1]),
        end: time(match[2]),
        url: path,
        ...(xywh
          ? {
              crop: {
                x: Number(xywh[1]),
                y: Number(xywh[2]),
                width: Number(xywh[3]),
                height: Number(xywh[4]),
              },
            }
          : {}),
      },
      base,
    );
    if (parsed) result.push(parsed);
    if (result.length >= 1000) break;
  }
  return result.sort((a, b) => a.start - b.start);
}
export function seekPreviewAt(
  source: SeekPreviewSource | readonly SeekPreviewCue[],
  seconds: number,
  duration?: number,
): SeekPreviewCue | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const data = source as SeekPreviewSource;
  const cues = Array.isArray(source) ? source : data.cues;
  const match = cues?.find((cue) => seconds >= cue.start && seconds < cue.end);
  if (match) return match;
  const sprite = data.sprite;
  if (
    !sprite ||
    !duration ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    seconds > duration
  )
    return null;
  const index = Math.min(
    sprite.number - 1,
    Math.floor((seconds / duration) * sprite.number),
  );
  return {
    start: (index * duration) / sprite.number,
    end: ((index + 1) * duration) / sprite.number,
    url: sprite.url,
    crop: {
      x: (index % sprite.column) * sprite.width,
      y: Math.floor(index / sprite.column) * sprite.height,
      width: sprite.width,
      height: sprite.height,
    },
  };
}

import type { PlayerSubtitleSettings } from "./player-subtitle-settings.interface";

export type TrackRole =
  "main" | "commentary" | "description" | "forced" | "sdh" | "unknown";
export interface SemanticTrackPreference {
  language: string;
  role: TrackRole;
}
export interface TitleTrackPreferences {
  audio?: SemanticTrackPreference;
  subtitle?: SemanticTrackPreference | "off";
  subtitleSettings?: PlayerSubtitleSettings;
}
interface TrackMetadata {
  language?: string;
  role?: TrackRole;
}
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  eng: "en",
  ara: "ar",
  fra: "fr",
  fre: "fr",
  deu: "de",
  ger: "de",
  spa: "es",
  por: "pt",
  ita: "it",
  rus: "ru",
  jpn: "ja",
  kor: "ko",
  zho: "zh",
  chi: "zh",
  hin: "hi",
  tur: "tr",
  nld: "nl",
  dut: "nl",
  fas: "fa",
  per: "fa",
  urd: "ur",
  pol: "pl",
  ukr: "uk",
  heb: "he",
  ell: "el",
  gre: "el",
  ron: "ro",
  rum: "ro",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  ces: "cs",
  cze: "cs",
  hun: "hu",
  tha: "th",
};
export function normalizeTrackLanguage(
  language: string | undefined,
): string | null {
  const primary = language
    ?.trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .split("-")[0];
  if (
    !primary ||
    primary === "und" ||
    primary === "unknown" ||
    !/^[a-z]{2,3}$/.test(primary)
  )
    return null;
  return LANGUAGE_ALIASES[primary] ?? primary;
}
export function captureTrackPreference(
  track: TrackMetadata,
): SemanticTrackPreference | null {
  const language = normalizeTrackLanguage(track.language);
  return language ? { language, role: track.role ?? "unknown" } : null;
}
export function matchPreferredTrack<T extends TrackMetadata>(
  tracks: readonly T[],
  preferred: SemanticTrackPreference | null | undefined,
): T | null {
  if (!preferred) return null;
  return (
    tracks.find(
      (track) =>
        normalizeTrackLanguage(track.language) ===
          normalizeTrackLanguage(preferred.language) &&
        (track.role ?? "unknown") === preferred.role,
    ) ?? null
  );
}
/** Use explicit track metadata, with named roles in the supplied label as a final hint. */
export function inferTrackRole(metadata: {
  forced?: boolean;
  kind?: string | null;
  roles?: readonly string[];
  characteristics?: string;
  label?: string;
}): TrackRole {
  if (metadata.forced) return "forced";
  const roles = metadata.roles?.join(" ").toLowerCase() ?? "";
  const label = metadata.label?.toLowerCase() ?? "";
  if (/commentary/.test(roles) || /\bcommentary\b/.test(label))
    return "commentary";
  if (
    /description|descriptive/.test(roles) ||
    metadata.characteristics?.includes("describes-video") ||
    /\baudio description\b/.test(label)
  )
    return "description";
  if (
    metadata.kind === "captions" ||
    /caption|sdh/.test(roles) ||
    metadata.characteristics?.includes("transcribes-spoken-dialog") ||
    /\bsdh\b/.test(label)
  )
    return "sdh";
  return "main";
}

export type PlayerPreferenceIntent =
  | { kind: "audio"; preference: SemanticTrackPreference }
  | { kind: "subtitle"; preference: SemanticTrackPreference | "off" }
  | { kind: "subtitle-settings"; settings: PlayerSubtitleSettings };

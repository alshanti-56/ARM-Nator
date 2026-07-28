export type SponsorBlockCategory =
  | "sponsor"
  | "selfpromo"
  | "interaction"
  | "intro"
  | "outro"
  | "preview"
  | "music_offtopic"
  | "filler";

export interface SponsorBlockSegment {
  readonly category: SponsorBlockCategory;
  readonly segment: readonly [startSeconds: number, endSeconds: number];
  readonly uuid?: string;
  readonly actionType?: "skip" | "mute" | "full" | "poi" | "chapter";
  readonly description?: string;
}

export interface SponsorBlockQuery {
  readonly videoId: string;
  readonly categories: readonly SponsorBlockCategory[];
}

export interface SponsorBlockClient {
  getSegments(query: SponsorBlockQuery): Promise<readonly SponsorBlockSegment[]>;
}

export interface SourcePlaybackOccupancy {
  playback: boolean;
  stopped: boolean;
  preparing: boolean;
  recovering: boolean;
  youtube: boolean;
  external: { status: string } | null;
}
export function sourcePlaybackOccupied(s: SourcePlaybackOccupancy): boolean {
  return (
    (s.playback && !s.stopped) ||
    s.preparing ||
    s.recovering ||
    s.youtube ||
    (!!s.external && s.external.status !== "closed")
  );
}

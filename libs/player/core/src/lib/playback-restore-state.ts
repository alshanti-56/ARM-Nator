interface TrackIdentity { label: string; language?: string; role?: string; }
/** Engine-local numeric IDs are deliberately excluded from persisted recovery identity. */
export function matchRecoveryTrack(target: TrackIdentity, tracks: readonly (TrackIdentity & { id: number })[]): number | null {
    const normalize = (value?: string) => value?.trim().toLowerCase();
    const candidates = tracks.filter(track => target.language
        ? normalize(track.language) === normalize(target.language) && (!target.role || track.role === target.role)
        : normalize(track.label) === normalize(target.label) && (!target.role || track.role === target.role));
    if (candidates.length === 1) return candidates[0].id;
    return candidates.find(track => normalize(track.label) === normalize(target.label))?.id ?? null;
}

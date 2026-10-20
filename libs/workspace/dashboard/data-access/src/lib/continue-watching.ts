import {
  catalogueIdentityKey,
  isViewingPositionFinished,
  trustedWorkIds,
  worksMatch,
  transferablePosition,
} from "@arm-nator/shared/interfaces";
import type {
  PlaybackPositionData,
  PortalRecentItem,
  ViewingHistoryEntry,
  WorkDescriptor,
} from "@arm-nator/shared/interfaces";

export function recentViewingEntry(
  item: PortalRecentItem,
  history: readonly ViewingHistoryEntry[],
): ViewingHistoryEntry | null {
  const source = item.source ?? "xtream",
    id = String(item.xtream_id);
  return (
    history.find((row) => {
      const identity = row.item.identity;
      if (
        identity.sourceType !== source ||
        identity.playlistId !== item.playlist_id
      )
        return false;
      if (item.type === "movie")
        return identity.contentKind === "vod" && identity.providerItemId === id;
      if (item.type !== "series" || identity.contentKind !== "episode")
        return false;
      return (
        row.item.seriesIdentity?.providerItemId === id ||
        (row.item.legacyContentInfo?.seriesXtreamId !== undefined &&
          String(row.item.legacyContentInfo.seriesXtreamId) === id) ||
        identity.providerItemId === id
      );
    }) ?? null
  );
}

export function viewingHistoryPosition(
  entry: ViewingHistoryEntry,
): PlaybackPositionData {
  const resume = entry.resume ?? entry.raw;
  return {
    ...entry.item.legacyContentInfo,
    contentXtreamId: entry.item.legacyContentInfo?.contentXtreamId ?? 0,
    contentType:
      entry.item.identity.contentKind === "episode" ? "episode" : "vod",
    positionSeconds: resume.positionSeconds,
    durationSeconds: resume.durationSeconds ?? undefined,
    confirmedAt: resume.confirmedAt,
    action: resume.action,
    updatedAt: new Date(resume.confirmedAt).toISOString(),
  };
}
export interface ContinueWatchingGroup {
  primary: PortalRecentItem;
  versions: PortalRecentItem[];
  position: PlaybackPositionData;
}
interface Candidate {
  item: PortalRecentItem;
  position: PlaybackPositionData | null;
  entry: ViewingHistoryEntry | null;
  work?: WorkDescriptor;
  key: string;
  time: number;
  trusted: boolean;
}

/** Complete-link matching prevents a title-only version from bridging contradictory trusted identities. */
export function groupContinueWatching(
  items: readonly PortalRecentItem[],
  positionFor: (item: PortalRecentItem) => PlaybackPositionData | null,
  history: readonly ViewingHistoryEntry[] = [],
): ContinueWatchingGroup[] {
  const unique = new Map<string, Candidate>();
  for (const item of items) {
    if (item.type === "live") continue;
    const key = catalogueIdentityKey({
      sourceType: item.source ?? "xtream",
      playlistId: item.playlist_id,
      contentKind: item.type === "series" ? "series" : "vod",
      providerItemId: String(item.xtream_id),
    });
    if (unique.has(key)) continue;
    const entry = recentViewingEntry(item, history),
      position = entry ? viewingHistoryPosition(entry) : positionFor(item);
    const work = entry?.item.work ?? item.work;
    const ids = work
      ? trustedWorkIds(
          work.kind === "episode" && work.series ? work.series : work,
        )
      : {};
    const stamp = position
      ? (position.confirmedAt ??
        Date.parse(position.updatedAt ?? item.viewed_at))
      : 0;
    unique.set(key, {
      key,
      item,
      entry,
      position,
      work,
      time: Number.isFinite(stamp) ? stamp : 0,
      trusted: !!(ids.tmdb || ids.imdb),
    });
  }
  const compatible = (a: Candidate, b: Candidate) => {
    if (a.entry?.sharedAllowed === false || b.entry?.sharedAllowed === false)
      return false;
    if (a.item.type === "series" && b.item.type === "series") {
      const parentA = a.work?.kind === "episode" ? a.work.series : a.work;
      const parentB = b.work?.kind === "episode" ? b.work.series : b.work;
      return !!parentA && !!parentB && worksMatch(parentA, parentB);
    }
    if (a.entry?.workId && b.entry?.workId)
      return a.entry.workId === b.entry.workId;
    return !!a.work && !!b.work && worksMatch(a.work, b.work);
  };
  const groups: Candidate[][] = [];
  for (const candidate of [...unique.values()].sort(
    (a, b) =>
      Number(b.trusted) - Number(a.trusted) ||
      b.time - a.time ||
      a.key.localeCompare(b.key),
  )) {
    const matches = groups.filter((group) =>
      group.every((other) => compatible(candidate, other)),
    );
    if (matches.length === 1) matches[0].push(candidate);
    else groups.push([candidate]);
  }
  return groups
    .map((group) =>
      group.sort((a, b) => b.time - a.time || a.key.localeCompare(b.key)),
    )
    .sort((a, b) => b[0].time - a[0].time || a[0].key.localeCompare(b[0].key))
    .flatMap((group) => {
      const latest = group[0];
      if (
        latest.position?.action === "finished" ||
        latest.position?.action === "reset"
      )
        return [];
      for (const candidate of group) {
        let position = candidate.position;
        if (!position) continue;
        if (
          latest.position &&
          latest.time > candidate.time &&
          (latest.item.type !== "series" ||
            (!!latest.work &&
              !!candidate.work &&
              worksMatch(latest.work, candidate.work))) &&
          latest.position.durationSeconds &&
          position.durationSeconds
        ) {
          const transferred = transferablePosition(
            latest.position.positionSeconds,
            latest.position.durationSeconds,
            position.durationSeconds,
          );
          if (transferred !== null)
            position = {
              ...position,
              positionSeconds: transferred,
              confirmedAt: latest.time,
            };
        }
        if (
          position.positionSeconds > 0 &&
          !isViewingPositionFinished(position)
        )
          return [
            {
              primary: candidate.item,
              versions: group.map((version) => version.item),
              position,
            },
          ];
      }
      return [];
    });
}

export function recentVersionIdentity(item: PortalRecentItem): string {
  return catalogueIdentityKey({
    sourceType: item.source ?? "xtream",
    playlistId: item.playlist_id,
    contentKind:
      item.type === "series" ? "series" : item.type === "live" ? "live" : "vod",
    providerItemId: String(item.xtream_id),
  });
}

export function recentVersionLabel(item: PortalRecentItem): string {
  return `${item.playlist_name?.trim() || item.playlist_id} · ${item.title}`;
}

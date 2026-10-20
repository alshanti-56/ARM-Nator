import { catalogueIdentityKey, worksMatch } from "./viewing-continuity";
import { describeDiscoveryWork } from "./discovery-presentation";
import { groupDiscoveryVersions } from "./unified-discovery";
import type { DiscoveryVersion } from "./unified-discovery";
import type { ResolvedPortalPlayback } from "./portal-playback.interface";

/** Episodes choose a series version; they never imply matching episode numbers. */
export function playbackDiscoveryVersion(
  playback: ResolvedPortalPlayback,
): DiscoveryVersion | null {
  if (playback.isLive) return null;
  const identity = playback.seriesIdentity ?? playback.itemIdentity;
  if (!identity || !["vod", "series"].includes(identity.contentKind))
    return null;
  const contentType = identity.contentKind === "series" ? "series" : "movie";
  const work =
    playback.work?.kind === "episode" ? playback.work.series : playback.work;
  return {
    identity,
    contentType,
    providerName: "Current source",
    originalTitle:
      playback.historyContext?.title ?? work?.title ?? playback.title,
    categoryId: playback.historyContext?.categoryId ?? "",
    posterUrl: playback.thumbnail ?? undefined,
    work: work ?? {
      ...describeDiscoveryWork(playback.title, null),
      kind: contentType,
    },
    // The current source is displayed, never navigated through this fallback.
    navigation: [],
  };
}

/** Reuse complete-link matching so a weak alias cannot bridge conflicting IDs. */
export function matchingPlaybackVersions(
  current: DiscoveryVersion,
  candidates: readonly DiscoveryVersion[],
): DiscoveryVersion[] {
  const key = catalogueIdentityKey(current.identity);
  const rows = [
    ...candidates.filter(
      (v) =>
        catalogueIdentityKey(v.identity) !== key &&
        current.work &&
        v.work &&
        worksMatch(current.work, v.work),
    ),
    current,
  ];
  return (
    groupDiscoveryVersions(rows).find((group) =>
      group.versions.some((v) => catalogueIdentityKey(v.identity) === key),
    )?.versions ?? [current]
  );
}

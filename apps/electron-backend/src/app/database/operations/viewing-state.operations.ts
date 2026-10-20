import { randomUUID } from "node:crypto";
import { and, eq, or, desc, inArray, ne, sql } from "drizzle-orm";
import * as schema from "@arm-nator/database/schema";
import {
  catalogueIdentityKey,
  normalizeTrackLanguage,
  isPlaybackFinished,
  transferablePosition,
  trustedWorkIds,
  workTitleYearKey,
  worksMatch,
} from "@arm-nator/shared/interfaces";
import type {
  CatalogueItemIdentity,
  WorkDescriptor,
  ViewingStateUpdate,
  ViewingItem,
  ViewingHistoryEntry,
  TitleTrackPreferences,
  SemanticTrackPreference,
} from "@arm-nator/shared/interfaces";
import type { AppDatabase } from "../database.types";

type ViewingAction = "progress" | "finished" | "reset";
export interface ConfirmedViewingState {
  successfulAt?: number;
  identity: CatalogueItemIdentity;
  positionSeconds: number;
  durationSeconds?: number;
  confirmedAt: number;
  action?: ViewingAction;
}

function lookup(work: WorkDescriptor) {
  if (work.kind !== "episode")
    return { titleKey: workTitleYearKey(work), ...trustedWorkIds(work) };
  if (
    !work.series ||
    !Number.isSafeInteger(work.seasonNumber) ||
    (work.seasonNumber ?? -1) < 0 ||
    !Number.isSafeInteger(work.episodeNumber) ||
    (work.episodeNumber ?? 0) < 1
  )
    return { titleKey: null };
  const suffix = JSON.stringify([work.seasonNumber, work.episodeNumber]);
  const ids = trustedWorkIds(work.series),
    titleKey = workTitleYearKey(work.series);
  return {
    titleKey: titleKey ? JSON.stringify([titleKey, suffix]) : null,
    tmdb: ids.tmdb ? `${ids.tmdb}:${suffix}` : undefined,
    imdb: ids.imdb ? `${ids.imdb}:${suffix}` : undefined,
  };
}

function conflictingIds(a: WorkDescriptor, b: WorkDescriptor): boolean {
  const left = trustedWorkIds(a.kind === "episode" && a.series ? a.series : a);
  const right = trustedWorkIds(b.kind === "episode" && b.series ? b.series : b);
  return (["tmdb", "imdb"] as const).some((key) =>
    Boolean(left[key] && right[key] && left[key] !== right[key]),
  );
}

function combineDescriptors(
  a: WorkDescriptor,
  b: WorkDescriptor,
): WorkDescriptor {
  if (a.kind === "episode" && a.series && b.series) {
    return { ...a, series: combineDescriptors(a.series, b.series) };
  }
  // Retain every known trusted namespace so a later alias cannot bridge contradictory IDs.
  return {
    ...a,
    releaseYear: a.releaseYear ?? b.releaseYear,
    trustedIds: { ...trustedWorkIds(a), ...trustedWorkIds(b) },
  };
}

/** Reconciliation never rewrites any version's raw progress. Ambiguous matches stay isolated. */
export function reconcileViewingItem(
  db: AppDatabase,
  identity: CatalogueItemIdentity,
  descriptor: WorkDescriptor,
) {
  const identityKey = catalogueIdentityKey(identity);
  if (
    (identity.contentKind === "vod" && descriptor.kind !== "movie") ||
    (identity.contentKind === "series" && descriptor.kind !== "series") ||
    (identity.contentKind === "episode" && descriptor.kind !== "episode") ||
    identity.contentKind === "live"
  )
    throw new Error("Invalid viewing content kind");
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.sourceAliases)
      .where(eq(schema.sourceAliases.identityKey, identityKey))
      .get();
    const previous: WorkDescriptor | undefined = existing?.descriptor
      ? JSON.parse(existing.descriptor)
      : undefined;
    const keys = lookup(descriptor);
    const criteria = [
      ...(keys.titleKey
        ? [eq(schema.matchedWorks.titleKey, keys.titleKey)]
        : []),
      ...(keys.tmdb ? [eq(schema.matchedWorks.tmdbId, keys.tmdb)] : []),
      ...(keys.imdb ? [eq(schema.matchedWorks.imdbId, keys.imdb)] : []),
      ...(existing?.workId &&
      previous &&
      JSON.stringify(previous) === JSON.stringify(descriptor)
        ? [eq(schema.matchedWorks.id, existing.workId)]
        : []),
    ];
    const candidates = criteria.length
      ? tx
          .select()
          .from(schema.matchedWorks)
          .where(
            and(eq(schema.matchedWorks.kind, descriptor.kind), or(...criteria)),
          )
          .all()
          .filter(
            (row) =>
              (row.id === existing?.workId &&
                previous &&
                JSON.stringify(previous) === JSON.stringify(descriptor)) ||
              worksMatch(JSON.parse(row.descriptor), descriptor),
          )
      : [];
    const oldCandidate = candidates.find((row) => row.id === existing?.workId);
    let work =
      oldCandidate ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!work) {
      work = {
        id: randomUUID(),
        kind: descriptor.kind,
        titleKey: keys.titleKey,
        tmdbId: keys.tmdb ?? null,
        imdbId: keys.imdb ?? null,
        descriptor: JSON.stringify(descriptor),
      };
      tx.insert(schema.matchedWorks).values(work).run();
    } else {
      const combined = combineDescriptors(
        JSON.parse(work.descriptor),
        descriptor,
      );
      const combinedKeys = lookup(combined);
      tx.update(schema.matchedWorks)
        .set({
          descriptor: JSON.stringify(combined),
          titleKey: combinedKeys.titleKey,
          tmdbId: combinedKeys.tmdb ?? null,
          imdbId: combinedKeys.imdb ?? null,
        })
        .where(eq(schema.matchedWorks.id, work.id))
        .run();
    }
    const sharedAllowed =
      previous && conflictingIds(previous, descriptor)
        ? false
        : (existing?.sharedAllowed ?? true);
    const alias = {
      identityKey,
      ...identity,
      workId: work.id,
      descriptor: JSON.stringify(descriptor),
      sharedAllowed,
    };
    tx.insert(schema.sourceAliases)
      .values(alias)
      .onConflictDoUpdate({
        target: schema.sourceAliases.identityKey,
        set: alias,
      })
      .run();
    return alias;
  });
}

export function saveConfirmedViewingState(
  db: AppDatabase,
  data: ConfirmedViewingState,
): boolean {
  const identityKey = catalogueIdentityKey(data.identity),
    action = data.action ?? "progress";
  if (
    !["progress", "finished", "reset"].includes(action) ||
    !Number.isFinite(data.positionSeconds) ||
    data.positionSeconds < 0 ||
    !Number.isSafeInteger(data.confirmedAt) ||
    data.confirmedAt < 0 ||
    (data.successfulAt !== undefined && (!Number.isSafeInteger(data.successfulAt) || data.successfulAt <= 0 || data.successfulAt > data.confirmedAt)) ||
    (data.durationSeconds !== undefined &&
      (!Number.isFinite(data.durationSeconds) || data.durationSeconds <= 0))
  ) {
    throw new Error("Invalid confirmed viewing state");
  }
  return db.transaction((tx) => {
    const alias = tx
      .select()
      .from(schema.sourceAliases)
      .where(eq(schema.sourceAliases.identityKey, identityKey))
      .get();
    if (!alias) throw new Error("Unknown viewing item");
    const old = tx
      .select()
      .from(schema.versionViewingState)
      .where(eq(schema.versionViewingState.identityKey, identityKey))
      .get();
    if (old && old.confirmedAt >= data.confirmedAt) return false;
    const values = {
      identityKey,
      action,
      confirmedAt: data.confirmedAt,
      positionSeconds: action === "reset" ? 0 : data.positionSeconds,
      durationSeconds: data.durationSeconds ?? old?.durationSeconds ?? null,
      successfulAt: Math.max(data.successfulAt ?? 0, old?.successfulAt ?? 0) || null,
    };
    tx.insert(schema.versionViewingState)
      .values(values)
      .onConflictDoUpdate({
        target: schema.versionViewingState.identityKey,
        set: values,
      })
      .run();
    tx.update(schema.sourceAliases)
      .set({ sharedAllowed: true })
      .where(eq(schema.sourceAliases.identityKey, identityKey))
      .run();
    if (alias.workId) {
      const shared = tx
        .select()
        .from(schema.sharedViewingState)
        .where(eq(schema.sharedViewingState.workId, alias.workId))
        .get();
      if (!shared || shared.confirmedAt < data.confirmedAt) {
        const state = { workId: alias.workId, ...values };
        tx.insert(schema.sharedViewingState)
          .values(state)
          .onConflictDoUpdate({
            target: schema.sharedViewingState.workId,
            set: state,
          })
          .run();
      }
    }
    return true;
  });
}

export function readViewingResume(
  db: AppDatabase,
  identity: CatalogueItemIdentity,
  actualDuration?: number,
) {
  const identityKey = catalogueIdentityKey(identity);
  const alias = db
    .select()
    .from(schema.sourceAliases)
    .where(eq(schema.sourceAliases.identityKey, identityKey))
    .get();
  if (!alias) return null;
  const own = db
    .select()
    .from(schema.versionViewingState)
    .where(eq(schema.versionViewingState.identityKey, identityKey))
    .get();
  // Older enrichment can leave identical aliases in separate work records.
  // Read their latest state without merging records or changing raw history.
  // Unknown title/year descriptors must remain isolated.
  const keys = lookup(JSON.parse(alias.descriptor) as WorkDescriptor);
  const canMatchDuplicates = !!(keys.tmdb || keys.imdb || keys.titleKey);
  const shared =
    alias.workId && alias.sharedAllowed
      ? db
          .select({ state: schema.sharedViewingState })
          .from(schema.sharedViewingState)
          .innerJoin(schema.matchedWorks, eq(schema.sharedViewingState.workId, schema.matchedWorks.id))
          .innerJoin(schema.sourceAliases, eq(schema.sharedViewingState.identityKey, schema.sourceAliases.identityKey))
          .where(and(
            eq(schema.sourceAliases.sharedAllowed, true),
            or(
              eq(schema.sharedViewingState.workId, alias.workId),
              canMatchDuplicates ? eq(schema.matchedWorks.descriptor, alias.descriptor) : undefined,
            ),
          ))
          .orderBy(desc(schema.sharedViewingState.confirmedAt))
          .limit(1)
          .get()?.state
      : undefined;
  return resolveResume(own, shared, actualDuration);
}

function resolveResume(
  own: typeof schema.versionViewingState.$inferSelect | undefined,
  shared: typeof schema.sharedViewingState.$inferSelect | undefined,
  actualDuration?: number,
) {
  const view = (
    state: NonNullable<typeof own> | NonNullable<typeof shared>,
    positionSeconds = state.positionSeconds,
    durationSeconds = state.durationSeconds,
  ) => ({
    successfulAt: own?.successfulAt ?? undefined,
    positionSeconds: state.action === "reset" ? 0 : positionSeconds,
    durationSeconds,
    confirmedAt: state.confirmedAt,
    action: state.action,
    finished:
      state.action === "finished" ||
      (state.action !== "reset" &&
        isPlaybackFinished(positionSeconds, durationSeconds)),
  });
  if (shared && (!own || shared.confirmedAt > own.confirmedAt)) {
    if (shared.action !== "progress")
      return view(
        shared,
        shared.action === "finished"
          ? (actualDuration ?? shared.positionSeconds)
          : 0,
      );
    if (actualDuration !== undefined && shared.durationSeconds !== null) {
      const position = transferablePosition(
        shared.positionSeconds,
        shared.durationSeconds,
        actualDuration,
      );
      if (position !== null) return view(shared, position, actualDuration);
    }
  }
  return own ? view(own) : null;
}

export function saveViewingItemProgress(
  db: AppDatabase,
  update: ViewingStateUpdate,
): { success: true } {
  const legacy = update.item.legacyContentInfo;
  if (
    legacy &&
    (legacy.playlistId !== update.item.identity.playlistId ||
      !Number.isSafeInteger(legacy.contentXtreamId) ||
      legacy.contentXtreamId < 0 ||
      !["vod", "episode"].includes(legacy.contentType))
  )
    throw new Error("Invalid legacy viewing identity");
  return db.transaction((tx) => {
    if (
      !tx
        .select({ id: schema.playlists.id })
        .from(schema.playlists)
        .where(eq(schema.playlists.id, update.item.identity.playlistId))
        .get()
    )
      throw new Error("Viewing source no longer exists");
    const alias = reconcileViewingItem(
      tx,
      update.item.identity,
      update.item.work,
    );
    const accepted = saveConfirmedViewingState(tx, {
      ...update,
      identity: update.item.identity,
    });
    if (accepted)
      tx.update(schema.sourceAliases)
        .set({
          versionMetadata: JSON.stringify({
            legacyContentInfo: update.item.legacyContentInfo,
            seriesIdentity: update.item.seriesIdentity,
            activity: update.item.activity,
          }),
        })
        .where(eq(schema.sourceAliases.identityKey, alias.identityKey))
        .run();
    const collision =
      legacy &&
      update.item.identity.sourceType === "stalker" &&
      ((legacy.contentXtreamId === 0 &&
        update.item.identity.providerItemId !== "0") ||
        !!tx
          .select({ key: schema.sourceAliases.identityKey })
          .from(schema.sourceAliases)
          .where(
            and(
              eq(schema.sourceAliases.sourceType, "stalker"),
              eq(schema.sourceAliases.playlistId, legacy.playlistId),
              ne(schema.sourceAliases.identityKey, alias.identityKey),
              sql`json_extract(${schema.sourceAliases.versionMetadata}, '$.legacyContentInfo.contentXtreamId') = ${legacy.contentXtreamId}`,
              sql`json_extract(${schema.sourceAliases.versionMetadata}, '$.legacyContentInfo.contentType') = ${legacy.contentType}`,
            ),
          )
          .limit(1)
          .get());
    if (legacy && !collision) {
      const playlist = tx
        .select({ id: schema.playlists.id })
        .from(schema.playlists)
        .where(eq(schema.playlists.id, legacy.playlistId))
        .get();
      if (!playlist) throw new Error("Viewing source no longer exists");
      const old = tx
        .select()
        .from(schema.playbackPositions)
        .where(
          and(
            eq(schema.playbackPositions.playlistId, legacy.playlistId),
            eq(
              schema.playbackPositions.contentXtreamId,
              legacy.contentXtreamId,
            ),
            eq(schema.playbackPositions.contentType, legacy.contentType),
          ),
        )
        .get();
      if (!old?.confirmedAt || old.confirmedAt < update.confirmedAt) {
        const position =
          update.action === "reset"
            ? 0
            : update.action === "finished"
              ? (update.durationSeconds ?? update.positionSeconds)
              : update.positionSeconds;
        const values = {
          ...legacy,
          positionSeconds: position,
          durationSeconds:
            update.durationSeconds ?? old?.durationSeconds ?? null,
          confirmedAt: update.confirmedAt,
          action: update.action ?? "progress",
          updatedAt: new Date(update.confirmedAt).toISOString(),
        };
        tx.insert(schema.playbackPositions)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.playbackPositions.contentXtreamId,
              schema.playbackPositions.playlistId,
              schema.playbackPositions.contentType,
            ],
            set: values,
          })
          .run();
      }
    }
    if (!alias.workId) throw new Error("Unable to reconcile viewing identity");
    return { success: true };
  });
}

function preferenceOwner(db: AppDatabase, item: ViewingItem): string | null {
  const alias = reconcileViewingItem(db, item.identity, item.work);
  if (!alias.sharedAllowed) return null;
  if (item.work.kind === "episode" && item.work.series && item.seriesIdentity) {
    if (
      item.seriesIdentity.sourceType !== item.identity.sourceType ||
      item.seriesIdentity.playlistId !== item.identity.playlistId ||
      item.seriesIdentity.contentKind !== "series"
    )
      throw new Error("Invalid series preference identity");
    const series = reconcileViewingItem(
      db,
      item.seriesIdentity,
      item.work.series,
    );
    return series.sharedAllowed ? series.workId : null;
  }
  return alias.workId;
}
export function getViewingTitlePreferences(
  db: AppDatabase,
  item: ViewingItem,
): TitleTrackPreferences | null {
  const workId = preferenceOwner(db, item);
  if (!workId) return null;
  const row = db
    .select()
    .from(schema.titlePreferences)
    .where(eq(schema.titlePreferences.workId, workId))
    .get();
  return row ? validatePreferencePatch(JSON.parse(row.preferences)) : null;
}
function validatePreferencePatch(
  patch: TitleTrackPreferences,
): TitleTrackPreferences {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("Invalid title preferences");
  const result: TitleTrackPreferences = {};
  const preference = (value: SemanticTrackPreference) => {
    if (
      !value ||
      ![
        "main",
        "commentary",
        "description",
        "forced",
        "sdh",
        "unknown",
      ].includes(value.role) ||
      !normalizeTrackLanguage(value.language)
    )
      throw new Error("Invalid track preference");
    return {
      language: normalizeTrackLanguage(value.language) as string,
      role: value.role,
    };
  };
  if (patch.audio !== undefined) result.audio = preference(patch.audio);
  if (patch.subtitle !== undefined)
    result.subtitle =
      patch.subtitle === "off" ? "off" : preference(patch.subtitle);
  if (patch.subtitleSettings !== undefined) {
    const settings = patch.subtitleSettings;
    if (
      !settings ||
      ![
        "fontSize",
        "backgroundOpacity",
        "outlineSize",
        "position",
        "delaySeconds",
      ].every((key) =>
        Number.isFinite(settings[key as keyof typeof settings]),
      ) ||
      !/^#[0-9a-f]{6}$/i.test(settings.textColor) ||
      !/^#[0-9a-f]{6}$/i.test(settings.backgroundColor)
    )
      throw new Error("Invalid subtitle adjustments");
    result.subtitleSettings = { ...settings };
  }
  return result;
}
export function saveViewingTitlePreferences(
  db: AppDatabase,
  item: ViewingItem,
  patch: TitleTrackPreferences,
  confirmedAt: number,
): { success: true } {
  const validated = validatePreferencePatch(patch);
  if (!Number.isSafeInteger(confirmedAt) || confirmedAt < 0)
    throw new Error("Invalid preference timestamp");
  return db.transaction((tx) => {
    const workId = preferenceOwner(tx, item);
    if (!workId)
      throw new Error(
        "Conflicting title identity must be confirmed before sharing preferences",
      );
    const old = tx
      .select()
      .from(schema.titlePreferences)
      .where(eq(schema.titlePreferences.workId, workId))
      .get();
    if (old && old.updatedAt >= confirmedAt) return { success: true };
    const preferences = {
      ...(old ? validatePreferencePatch(JSON.parse(old.preferences)) : {}),
      ...validated,
    };
    const values = {
      workId,
      preferences: JSON.stringify(preferences),
      updatedAt: confirmedAt,
    };
    tx.insert(schema.titlePreferences)
      .values(values)
      .onConflictDoUpdate({
        target: schema.titlePreferences.workId,
        set: values,
      })
      .run();
    return { success: true };
  });
}

/** A bounded recent history read uses batched shared-state lookup rather than per-item IPC/queries. */
export function getViewingHistory(
  db: AppDatabase,
  playlistId?: string,
): ViewingHistoryEntry[] {
  if (
    playlistId !== undefined &&
    (typeof playlistId !== "string" || !playlistId.trim())
  )
    throw new Error("Invalid history source");
  const rows = db
    .select({ alias: schema.sourceAliases, raw: schema.versionViewingState })
    .from(schema.versionViewingState)
    .innerJoin(
      schema.sourceAliases,
      eq(
        schema.sourceAliases.identityKey,
        schema.versionViewingState.identityKey,
      ),
    )
    .innerJoin(
      schema.playlists,
      eq(schema.playlists.id, schema.sourceAliases.playlistId),
    )
    .where(
      playlistId === undefined
        ? undefined
        : eq(schema.sourceAliases.playlistId, playlistId),
    )
    .orderBy(desc(schema.versionViewingState.confirmedAt))
    .limit(5000)
    .all();
  const workIds = [
    ...new Set(
      rows.map((row) => row.alias.workId).filter((id): id is string => !!id),
    ),
  ];
  const shared = new Map(
    (workIds.length
      ? db
          .select()
          .from(schema.sharedViewingState)
          .where(inArray(schema.sharedViewingState.workId, workIds))
          .all()
      : []
    ).map((row) => [row.workId, row]),
  );
  return rows.map(({ alias, raw }) => {
    // Stored identity keys are tuples, not objects.
    const [sourceType, sourceId, contentKind, providerItemId] = JSON.parse(
      alias.identityKey,
    ) as [
      CatalogueItemIdentity["sourceType"],
      string,
      CatalogueItemIdentity["contentKind"],
      string,
    ];
    const metadata = alias.versionMetadata
      ? (JSON.parse(alias.versionMetadata) as Pick<
          ViewingItem,
          "legacyContentInfo" | "seriesIdentity" | "activity"
        >)
      : {};
    return {
      item: {
        ...metadata,
        identity: {
          sourceType,
          playlistId: sourceId,
          contentKind,
          providerItemId,
        },
        work: JSON.parse(alias.descriptor ?? "{}"),
      },
      workId: alias.workId,
      sharedAllowed: alias.sharedAllowed,
      raw: resolveResume(raw, undefined)!,
      resume: resolveResume(
        raw,
        alias.sharedAllowed && alias.workId
          ? shared.get(alias.workId)
          : undefined,
        raw.durationSeconds ?? undefined,
      ),
    };
  });
}

/** Adopt an unambiguous legacy clock lazily; leave provider-specific history untouched. */
export function reconcileViewingHistoryItem(
  db: AppDatabase,
  item: ViewingItem,
) {
  return db.transaction((tx) => {
    const alias = reconcileViewingItem(tx, item.identity, item.work),
      legacy = item.legacyContentInfo;
    const own = tx
      .select()
      .from(schema.versionViewingState)
      .where(eq(schema.versionViewingState.identityKey, alias.identityKey))
      .get();
    const canonical =
      item.identity.sourceType === "xtream" ||
      (item.identity.contentKind === "vod" &&
        String(legacy?.contentXtreamId) === item.identity.providerItemId);
    if (
      !own &&
      legacy &&
      canonical &&
      legacy.playlistId === item.identity.playlistId
    ) {
      const raw = tx
        .select()
        .from(schema.playbackPositions)
        .where(
          and(
            eq(schema.playbackPositions.playlistId, legacy.playlistId),
            eq(
              schema.playbackPositions.contentXtreamId,
              legacy.contentXtreamId,
            ),
            eq(schema.playbackPositions.contentType, legacy.contentType),
          ),
        )
        .get();
      if (
        raw &&
        (legacy.seriesXtreamId === undefined ||
          raw.seriesXtreamId === legacy.seriesXtreamId)
      ) {
        const parsed = Date.parse(
          raw.updatedAt.includes("T")
            ? raw.updatedAt
            : raw.updatedAt.replace(" ", "T") + "Z",
        );
        saveConfirmedViewingState(tx, {
          identity: item.identity,
          positionSeconds: raw.positionSeconds,
          durationSeconds:
            raw.durationSeconds && raw.durationSeconds > 0
              ? raw.durationSeconds
              : undefined,
          confirmedAt:
            raw.confirmedAt ?? (Number.isFinite(parsed) ? parsed : 1),
          action: raw.action,
        });
      }
    }
    tx.update(schema.sourceAliases)
      .set({
        versionMetadata: JSON.stringify({
          legacyContentInfo: legacy,
          seriesIdentity: item.seriesIdentity,
          activity: item.activity,
        }),
      })
      .where(eq(schema.sourceAliases.identityKey, alias.identityKey))
      .run();
    return alias;
  });
}

/** Clear only requested raw versions; preserve other versions and recompute their shared state. */
export function clearViewingHistory(
  db: AppDatabase,
  playlistId: string,
  legacy?: { contentXtreamId: number; contentType: "vod" | "episode" },
): void {
  db.transaction((tx) => {
    const aliases = tx
      .select()
      .from(schema.sourceAliases)
      .where(eq(schema.sourceAliases.playlistId, playlistId))
      .all()
      .filter((alias) => {
        if (!legacy) return true;
        const info = alias.versionMetadata
          ? (
              JSON.parse(alias.versionMetadata) as Pick<
                ViewingItem,
                "legacyContentInfo"
              >
            ).legacyContentInfo
          : undefined;
        return info
          ? info.contentXtreamId === legacy.contentXtreamId &&
              info.contentType === legacy.contentType
          : alias.sourceType === "xtream" &&
              alias.providerItemId === String(legacy.contentXtreamId) &&
              alias.contentKind === legacy.contentType;
      });
    const keys = aliases.map((alias) => alias.identityKey);
    if (!keys.length) return;
    const removedShared = tx
      .select()
      .from(schema.sharedViewingState)
      .where(inArray(schema.sharedViewingState.identityKey, keys))
      .all();
    tx.delete(schema.sharedViewingState)
      .where(inArray(schema.sharedViewingState.identityKey, keys))
      .run();
    tx.delete(schema.versionViewingState)
      .where(inArray(schema.versionViewingState.identityKey, keys))
      .run();
    for (const shared of removedShared) {
      const latest = tx
        .select({ raw: schema.versionViewingState })
        .from(schema.versionViewingState)
        .innerJoin(
          schema.sourceAliases,
          eq(
            schema.sourceAliases.identityKey,
            schema.versionViewingState.identityKey,
          ),
        )
        .innerJoin(
          schema.playlists,
          eq(schema.playlists.id, schema.sourceAliases.playlistId),
        )
        .where(
          and(
            eq(schema.sourceAliases.workId, shared.workId),
            eq(schema.sourceAliases.sharedAllowed, true),
          ),
        )
        .orderBy(desc(schema.versionViewingState.confirmedAt))
        .limit(1)
        .get();
      if (latest)
        tx.insert(schema.sharedViewingState)
          .values({ workId: shared.workId, ...latest.raw })
          .run();
    }
  });
}

import { clearViewingHistory } from "./viewing-state.operations";
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "@arm-nator/database/schema";
import type { AppDatabase } from "../database.types";

type PlaylistType = "xtream";

type PlaybackPositionPayload = {
  contentXtreamId: number;
  contentType: "vod" | "episode";
  seriesXtreamId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  positionSeconds: number;
  durationSeconds?: number;
  playlistType?: PlaylistType;
  confirmedAt?: number;
  action?: "progress" | "finished" | "reset";
};

async function ensurePlaylistExists(
  db: AppDatabase,
  playlistId: string,
  playlistType: PlaylistType = "xtream",
): Promise<void> {
  const existing = await db
    .select()
    .from(schema.playlists)
    .where(eq(schema.playlists.id, playlistId))
    .limit(1);

  if (existing.length === 0) {
    await db
      .insert(schema.playlists)
      .values({
        id: playlistId,
        name: "Imported Playlist",
        type: playlistType,
      })
      .onConflictDoNothing();
  }
}

export async function savePlaybackPosition(
  db: AppDatabase,
  playlistId: string,
  data: PlaybackPositionPayload,
): Promise<{ success: boolean }> {
  if (
    !playlistId ||
    !Number.isSafeInteger(data.contentXtreamId) ||
    data.contentXtreamId < 0 ||
    !["vod", "episode"].includes(data.contentType) ||
    !Number.isFinite(data.positionSeconds) ||
    data.positionSeconds < 0 ||
    (data.durationSeconds !== undefined &&
      (!Number.isFinite(data.durationSeconds) || data.durationSeconds < 0)) ||
    (data.action !== undefined &&
      !["progress", "finished", "reset"].includes(data.action)) ||
    (data.confirmedAt !== undefined &&
      (!Number.isSafeInteger(data.confirmedAt) || data.confirmedAt < 0))
  ) {
    throw new Error("Invalid playback position");
  }
  await ensurePlaylistExists(db, playlistId, data.playlistType);

  const values = {
    playlistId,
    contentXtreamId: data.contentXtreamId,
    contentType: data.contentType,
    seriesXtreamId: data.seriesXtreamId,
    seasonNumber: data.seasonNumber,
    episodeNumber: data.episodeNumber,
    positionSeconds: data.positionSeconds,
    durationSeconds: data.durationSeconds,
    updatedAt:
      data.confirmedAt === undefined
        ? sql`CURRENT_TIMESTAMP`
        : new Date(data.confirmedAt).toISOString(),
    confirmedAt: data.confirmedAt ?? Date.now(),
    action: data.action ?? "progress",
  };

  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(schema.playbackPositions)
      .where(
        and(
          eq(schema.playbackPositions.playlistId, playlistId),
          eq(schema.playbackPositions.contentXtreamId, data.contentXtreamId),
          eq(schema.playbackPositions.contentType, data.contentType),
        ),
      )
      .limit(1)
      .all();

    if (
      existing[0]?.confirmedAt != null &&
      existing[0].confirmedAt >= values.confirmedAt
    )
      return { success: true };
    if (existing.length > 0) {
      tx.update(schema.playbackPositions)
        .set(values)
        .where(eq(schema.playbackPositions.id, existing[0].id))
        .run();
    } else {
      tx.insert(schema.playbackPositions).values(values).run();
    }

    return { success: true };
  });
}

export async function getPlaybackPosition(
  db: AppDatabase,
  playlistId: string,
  contentXtreamId: number,
  contentType: "vod" | "episode",
) {
  const result = await db
    .select()
    .from(schema.playbackPositions)
    .where(
      and(
        eq(schema.playbackPositions.playlistId, playlistId),
        eq(schema.playbackPositions.contentXtreamId, contentXtreamId),
        eq(schema.playbackPositions.contentType, contentType),
      ),
    )
    .limit(1);

  return result[0] || null;
}

export async function getSeriesPlaybackPositions(
  db: AppDatabase,
  playlistId: string,
  seriesXtreamId: number,
) {
  return db
    .select()
    .from(schema.playbackPositions)
    .where(
      and(
        eq(schema.playbackPositions.playlistId, playlistId),
        eq(schema.playbackPositions.seriesXtreamId, seriesXtreamId),
        eq(schema.playbackPositions.contentType, "episode"),
      ),
    );
}

export async function getRecentPlaybackPositions(
  db: AppDatabase,
  playlistId: string,
  limit = 20,
) {
  return db
    .select()
    .from(schema.playbackPositions)
    .where(eq(schema.playbackPositions.playlistId, playlistId))
    .orderBy(desc(schema.playbackPositions.updatedAt))
    .limit(limit);
}

export async function getAllPlaybackPositions(
  db: AppDatabase,
  playlistId: string,
) {
  return db
    .select()
    .from(schema.playbackPositions)
    .where(eq(schema.playbackPositions.playlistId, playlistId));
}

export async function clearAllPlaybackPositions(
  db: AppDatabase,
  playlistId: string,
): Promise<{ success: boolean }> {
  db.transaction((tx) => {
    clearViewingHistory(tx, playlistId);
    tx.delete(schema.playbackPositions)
      .where(eq(schema.playbackPositions.playlistId, playlistId))
      .run();
  });

  return { success: true };
}

export async function clearPlaybackPosition(
  db: AppDatabase,
  playlistId: string,
  contentXtreamId: number,
  contentType: "vod" | "episode",
): Promise<{ success: boolean }> {
  db.transaction((tx) => {
    clearViewingHistory(tx, playlistId, { contentXtreamId, contentType });
    tx.delete(schema.playbackPositions)
      .where(
        and(
          eq(schema.playbackPositions.playlistId, playlistId),
          eq(schema.playbackPositions.contentXtreamId, contentXtreamId),
          eq(schema.playbackPositions.contentType, contentType),
        ),
      )
      .run();
  });

  return { success: true };
}

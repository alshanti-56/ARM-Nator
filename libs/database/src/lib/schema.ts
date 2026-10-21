/**
 * Drizzle ORM schema for ARM-Nator database
 * This schema defines the structure for Xtream Codes API data storage
 *
 * Single source of truth for the database schema. The Electron backend uses it
 * for read-write access; optional consumers can open it read-only.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Playlists table
export const playlists = sqliteTable("playlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  serverUrl: text("serverUrl"),
  username: text("username"),
  password: text("password"),
  dateCreated: text("date_created").default(sql`CURRENT_TIMESTAMP`),
  lastUpdated: text("last_updated"),
  type: text("type", {
    enum: ["xtream"],
  }).notNull(),
  userAgent: text("userAgent"),
  origin: text("origin"),
  referrer: text("referrer"),
  filePath: text("filePath"),
  autoRefresh: integer("autoRefresh", { mode: "boolean" }).default(false),
  macAddress: text("macAddress"),
  url: text("url"),
  portalUrl: text("portal_url"),
  count: integer("count"),
  importDate: text("import_date"),
  updateDate: integer("update_date"),
  position: integer("position"),
  favorites: text("favorites"),
  recentlyViewed: text("recently_viewed"),
  payload: text("payload"),
  lastUsage: text("last_usage"),
});

// App key-value state table (e.g. one-time migration flags)
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
});

// Categories table
export const categories = sqliteTable(
  "categories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type", { enum: ["live", "movies", "series"] }).notNull(),
    xtreamId: integer("xtream_id").notNull(),
    hidden: integer("hidden", { mode: "boolean" }).default(false),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
  },
  (table) => ({
    playlistIdx: index("idx_categories_playlist").on(table.playlistId),
    typeIdx: index("idx_categories_type").on(table.type),
    playlistTypeXtreamUnique: uniqueIndex(
      "categories_playlist_type_xtream_unique",
    ).on(table.playlistId, table.type, table.xtreamId),
    // Partial covering index for visible categories — see connection.ts
    // for the full rationale. SQLite can satisfy joins + hidden filter
    // directly from this index for the dashboard / search queries.
    visibleIdx: index("idx_categories_visible")
      .on(table.id, table.playlistId, table.type)
      .where(sql`hidden = 0`),
  }),
);

// Content table (streams/VODs/series)
export const content = sqliteTable(
  "content",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    rating: text("rating"),
    genre: text("genre"),
    releaseDate: text("release_date"),
    country: text("country"),
    director: text("director"),
    cast: text("cast"),
    description: text("description"),
    metadataStatus: text("metadata_status", {
      enum: ["complete", "failed"],
    }),
    metadataAttemptedAt: text("metadata_attempted_at"),
    metadataRetryAfter: text("metadata_retry_after"),
    added: text("added"),
    posterUrl: text("poster_url"),
    backdropUrl: text("backdrop_url"),
    directSource: text("direct_source"),
    xtreamId: integer("xtream_id").notNull(),
    type: text("type", { enum: ["live", "movie", "series"] }).notNull(),
  },
  (table) => ({
    typeIdx: index("idx_content_type").on(table.type),
    categoryIdx: index("idx_content_category").on(table.categoryId),
    titleIdx: index("idx_content_title").on(table.title),
    xtreamIdx: index("idx_content_xtream").on(table.xtreamId),
    categoryTypeXtreamUnique: uniqueIndex(
      "content_category_type_xtream_unique",
    ).on(table.categoryId, table.type, table.xtreamId),
    typeAddedIdx: index("idx_content_type_added").on(table.type, table.added),
  }),
);

// Recently viewed table
export const recentlyViewed = sqliteTable(
  "recently_viewed",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentId: integer("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    viewedAt: text("viewed_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    contentPlaylistUnique: uniqueIndex(
      "recently_viewed_content_playlist_unique",
    ).on(table.contentId, table.playlistId),
    playlistIdx: index("recently_viewed_playlist_idx").on(table.playlistId),
    viewedAtIdx: index("recently_viewed_viewed_at_idx").on(table.viewedAt),
    playlistViewedIdx: index("recently_viewed_playlist_viewed_idx").on(
      table.playlistId,
      sql`${table.viewedAt} DESC`,
    ),
  }),
);

// Favorites table
export const favorites = sqliteTable(
  "favorites",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contentId: integer("content_id")
      .notNull()
      .references(() => content.id, { onDelete: "cascade" }),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    addedAt: text("added_at").default(sql`CURRENT_TIMESTAMP`),
    /** Display order position in the global favorites list (lower = first) */
    position: integer("position").default(0),
  },
  (table) => ({
    contentPlaylistUnique: uniqueIndex("favorites_content_playlist_unique").on(
      table.contentId,
      table.playlistId,
    ),
    playlistIdx: index("favorites_playlist_idx").on(table.playlistId),
    contentIdx: index("favorites_content_idx").on(table.contentId),
    playlistPositionIdx: index("favorites_playlist_position_idx").on(
      table.playlistId,
      table.position,
      sql`${table.addedAt} DESC`,
    ),
  }),
);

// Playback Positions table
export const playbackPositions = sqliteTable(
  "playback_positions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    // For VOD: store xtream_id of the movie
    // For Series: store episode ID (from XtreamSerieEpisode.id)
    contentXtreamId: integer("content_xtream_id").notNull(),
    // 'vod' | 'episode'
    contentType: text("content_type", {
      enum: ["vod", "episode"],
    }).notNull(),
    // For episodes: store series xtream_id for grouping
    seriesXtreamId: integer("series_xtream_id"),
    // For episodes: store season and episode numbers for display
    seasonNumber: integer("season_number"),
    episodeNumber: integer("episode_number"),
    // Playback position in seconds
    positionSeconds: integer("position_seconds").notNull().default(0),
    // Total duration in seconds (for percentage calculation)
    durationSeconds: integer("duration_seconds"),
    // Last updated timestamp
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
    confirmedAt: integer("confirmed_at"),
    action: text("viewing_action", { enum: ["progress", "finished", "reset"] })
      .notNull()
      .default("progress"),
  },
  (table) => ({
    // Unique constraint: one position per content per playlist
    contentPlaylistUnique: uniqueIndex(
      "playback_positions_content_playlist_unique",
    ).on(table.contentXtreamId, table.playlistId, table.contentType),
    playlistIdx: index("playback_positions_playlist_idx").on(table.playlistId),
    seriesIdx: index("playback_positions_series_idx").on(table.seriesXtreamId),
    updatedIdx: index("playback_positions_updated_idx").on(table.updatedAt),
    playlistUpdatedIdx: index("playback_positions_playlist_updated_idx").on(
      table.playlistId,
      sql`${table.updatedAt} DESC`,
    ),
  }),
);

// Type exports for TypeScript
export type Playlist = typeof playlists.$inferSelect;
export type NewPlaylist = typeof playlists.$inferInsert;
export type AppState = typeof appState.$inferSelect;
export type NewAppState = typeof appState.$inferInsert;

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type Content = typeof content.$inferSelect;
export type NewContent = typeof content.$inferInsert;

export type RecentlyViewed = typeof recentlyViewed.$inferSelect;
export type NewRecentlyViewed = typeof recentlyViewed.$inferInsert;

export type Favorite = typeof favorites.$inferSelect;
export type NewFavorite = typeof favorites.$inferInsert;

export type PlaybackPosition = typeof playbackPositions.$inferSelect;
export type NewPlaybackPosition = typeof playbackPositions.$inferInsert;

// TMDB metadata cache table.
// Two row kinds share the table, discriminated by the lookup_key prefix:
// - 'id:<tmdbId>'                 → full TMDB details payload (JSON)
// - 'title:<normalized>|year:<y>' → search resolution; tmdb_id NULL means
//                                   "no confident match" (negative cache)
export const tmdbMetadata = sqliteTable(
  "tmdb_metadata",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaType: text("media_type", {
      enum: ["movie", "tv", "person"],
    }).notNull(),
    lookupKey: text("lookup_key").notNull(),
    language: text("language").notNull(),
    tmdbId: integer("tmdb_id"),
    payload: text("payload"),
    fetchedAt: text("fetched_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    lookupUnique: uniqueIndex("tmdb_metadata_lookup_unique").on(
      table.mediaType,
      table.lookupKey,
      table.language,
    ),
  }),
);

export type TmdbMetadata = typeof tmdbMetadata.$inferSelect;
export type NewTmdbMetadata = typeof tmdbMetadata.$inferInsert;

// Provider-neutral aliases are independent of legacy numeric Xtream positions.
export const matchedWorks = sqliteTable("matched_works", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  titleKey: text("title_key"),
  tmdbId: text("tmdb_id"),
  imdbId: text("imdb_id"),
  descriptor: text("descriptor").notNull(),
});
export const sourceAliases = sqliteTable("source_aliases", {
  identityKey: text("identity_key").primaryKey(),
  sourceType: text("source_type").notNull(),
  playlistId: text("playlist_id").notNull(),
  contentKind: text("content_kind").notNull(),
  providerItemId: text("provider_item_id").notNull(),
  workId: text("work_id").references(() => matchedWorks.id, {
    onDelete: "set null",
  }),
  descriptor: text("descriptor"),
  sharedAllowed: integer("shared_allowed", { mode: "boolean" })
    .notNull()
    .default(true),
  versionMetadata: text("version_metadata"),
});
export const versionViewingState = sqliteTable("version_viewing_state", {
  identityKey: text("identity_key")
    .primaryKey()
    .references(() => sourceAliases.identityKey, { onDelete: "cascade" }),
  positionSeconds: real("position_seconds").notNull(),
  durationSeconds: real("duration_seconds"),
  successfulAt: integer("successful_at"),
  confirmedAt: integer("confirmed_at").notNull(),
  action: text("action", { enum: ["progress", "finished", "reset"] }).notNull(),
});
export const sharedViewingState = sqliteTable("shared_viewing_state", {
  workId: text("work_id")
    .primaryKey()
    .references(() => matchedWorks.id, { onDelete: "cascade" }),
  identityKey: text("identity_key")
    .notNull()
    .references(() => sourceAliases.identityKey),
  positionSeconds: real("position_seconds").notNull(),
  durationSeconds: real("duration_seconds"),
  confirmedAt: integer("confirmed_at").notNull(),
  action: text("action", { enum: ["progress", "finished", "reset"] }).notNull(),
});
export const titlePreferences = sqliteTable("title_preferences", {
  workId: text("work_id")
    .primaryKey()
    .references(() => matchedWorks.id, { onDelete: "cascade" }),
  preferences: text("preferences").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Evidence is separate from provider credentials and catalogue payloads.
export const sourcePlaybackSources = sqliteTable('source_playback_sources', {
 sourceId:text('source_id').primaryKey().references(()=>playlists.id,{onDelete:'cascade'}),revision:text('revision').notNull(),
});
export const sourcePlaybackCategories = sqliteTable('source_playback_categories', {
 sourceId:text('source_id').notNull().references(()=>sourcePlaybackSources.sourceId,{onDelete:'cascade'}),category:text('category').notNull(),latest:text('latest'),successfulAt:integer('successful_at'),attempt:text('attempt'),cursor:text('cursor'),nextEligibleAt:integer('next_eligible_at'),inconclusiveCount:integer('inconclusive_count').default(0),
},table=>[uniqueIndex('source_playback_categories_key').on(table.sourceId,table.category)]);
export const sourcePlaybackObservations = sqliteTable('source_playback_observations', {
 sourceId:text('source_id').notNull().references(()=>sourcePlaybackSources.sourceId,{onDelete:'cascade'}),category:text('category').notNull(),checkId:text('check_id').notNull(),completedAt:integer('completed_at').notNull(),observation:text('observation').notNull(),
},table=>[uniqueIndex('source_playback_observations_key').on(table.sourceId,table.category,table.checkId)]);
export const sourcePlaybackAccounts = sqliteTable('source_playback_accounts', {
 sourceId:text('source_id').primaryKey().references(()=>sourcePlaybackSources.sourceId,{onDelete:'cascade'}),snapshot:text('snapshot').notNull(),
});

/**
 * Shared Database module for ARM-Nator
 * Provides Drizzle ORM schema and connection utilities for SQLite database
 * Used by both electron-backend (read-write) and agent-backend (read-only)
 */

export * from './lib/schema';
export * from './lib/connection';
export * from './lib/path-utils';

/**
 * Shared Database module for ARM-Nator
 * Provides Drizzle ORM schema and connection utilities for SQLite database
 * Used by the Electron backend and by optional read-only consumers such as
 * diagnostics and test tooling.
 */

export * from './lib/schema';
export * from './lib/connection';
export * from './lib/path-utils';

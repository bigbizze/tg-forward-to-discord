/**
 * Database Connection Management
 * 
 * Provides SQLite connection management with WAL mode enabled for
 * better concurrent access between TypeScript and Python processes.
 */

import Database from "better-sqlite3";
import {
  type Result,
  ok,
  err,
  type AppError,
  appErrorFromException,
  ErrorCodes
} from "@tg-discord/result";
import { getConfig } from "@tg-discord/config";

let db: Database.Database | null = null;

/**
 * Gets or creates the database connection.
 * Enables WAL mode for better concurrent access.
 * 
 * The database connection is cached and reused throughout the application
 * lifetime. SQLite with WAL mode handles concurrent reads well, and we
 * use a single writer pattern to avoid conflicts.
 */
export function getConnection(): Result<Database.Database, AppError> {
  if (db) {
    return ok(db);
  }

  try {
    const config = getConfig();
    db = new Database(config.SQLITE_PATH);
    
    // Enable WAL mode for better concurrent access
    // WAL allows readers to not block writers and vice versa
    db.pragma("journal_mode = WAL");
    
    // Enable foreign key enforcement
    db.pragma("foreign_keys = ON");
    
    // Improve performance for our use case
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = 10000");
    
    return ok(db);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_CONNECTION_ERROR,
      "Failed to connect to SQLite database"
    ));
  }
}

/**
 * Closes the database connection.
 * Should be called during graceful shutdown.
 */
export function closeConnection(): Result<void, AppError> {
  if (!db) {
    return ok(undefined);
  }

  try {
    db.close();
    db = null;
    return ok(undefined);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_CONNECTION_ERROR,
      "Failed to close database connection"
    ));
  }
}

/**
 * Gets the current timestamp in ISO 8601 format for database storage.
 */
export function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * Re-export Database type for consumers who need it.
 */
export type { Database };

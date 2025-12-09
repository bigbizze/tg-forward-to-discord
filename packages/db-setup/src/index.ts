/**
 * Database Setup Package
 * 
 * Provides idempotent database schema creation and management.
 * This script can be run multiple times safely - it will only create
 * tables that don't exist and won't modify existing data.
 * 
 * The schema supports both TypeScript and Python applications accessing
 * the same SQLite database with WAL mode enabled for concurrent access.
 */

import Database from "better-sqlite3";
import { getConfig } from "@tg-discord/config";

/**
 * SQL schema for the entire application.
 * Uses SQLite-specific syntax with proper foreign key constraints.
 */
const SCHEMA = `
-- Enable WAL mode for better concurrent access between TypeScript and Python
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================================
-- telegram_channel: Canonical source of Telegram channel information
-- ============================================================================
-- This table stores unique Telegram channels. The discord_webhook table
-- references this via foreign key, ensuring data consistency.
-- telegram_id may be NULL initially (resolved later by the scraper).
CREATE TABLE IF NOT EXISTS telegram_channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE,                     -- Telegram's channel ID (can be null until resolved)
    telegram_url TEXT NOT NULL UNIQUE,              -- The t.me URL (e.g., https://t.me/channel_name)
    telegram_username TEXT,                         -- Channel username without @
    created_at TEXT NOT NULL,                       -- ISO 8601 timestamp
    updated_at TEXT NOT NULL                        -- ISO 8601 timestamp
);

-- Index for efficient lookups by telegram_id (used by scraper)
CREATE INDEX IF NOT EXISTS idx_telegram_channel_telegram_id 
    ON telegram_channel(telegram_id) WHERE telegram_id IS NOT NULL;

-- ============================================================================
-- discord_channel_info: Stores Discord channel/server metadata
-- ============================================================================
-- This table caches Discord channel and server information so we don't need
-- to query Discord's API every time we need channel info.
CREATE TABLE IF NOT EXISTS discord_channel_info (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,                       -- Discord channel snowflake ID
    server_id TEXT NOT NULL,                        -- Discord server/guild snowflake ID
    channel_name TEXT NOT NULL,                     -- Discord channel name
    server_name TEXT NOT NULL,                      -- Discord server/guild name
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(channel_id, server_id)                   -- One record per channel per server
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_discord_channel_info_channel
    ON discord_channel_info(channel_id);
CREATE INDEX IF NOT EXISTS idx_discord_channel_info_server
    ON discord_channel_info(server_id);

-- ============================================================================
-- discord_webhook: Webhook subscriptions linking Discord to Telegram channels
-- ============================================================================
-- Each row represents a subscription: "forward messages from this Telegram
-- channel to this Discord webhook, grouped under this subscription ID"
CREATE TABLE IF NOT EXISTS discord_webhook (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_group_id TEXT NOT NULL,            -- Normalized group identifier (lowercase alphanumeric)
    description TEXT,                               -- Optional human-readable description
    discord_webhook_url TEXT NOT NULL,              -- Discord webhook URL for posting messages
    telegram_channel_id INTEGER NOT NULL,           -- FK to telegram_channel
    discord_channel_info_id INTEGER,                -- FK to discord_channel_info (nullable for legacy records)
    is_active INTEGER NOT NULL DEFAULT 1,           -- Soft delete flag (1=active, 0=inactive)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (telegram_channel_id) REFERENCES telegram_channel(id) ON DELETE CASCADE,
    FOREIGN KEY (discord_channel_info_id) REFERENCES discord_channel_info(id) ON DELETE SET NULL,
    UNIQUE(subscription_group_id, telegram_channel_id)  -- One subscription per group per channel
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_discord_webhook_active 
    ON discord_webhook(is_active) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_discord_webhook_channel 
    ON discord_webhook(telegram_channel_id);
CREATE INDEX IF NOT EXISTS idx_discord_webhook_group 
    ON discord_webhook(subscription_group_id);

-- ============================================================================
-- tg_msgs: Stores raw Telegram messages
-- ============================================================================
-- Each Telegram message is stored once with its raw data as JSON.
-- The combination of tg_ext_id and telegram_channel_id is unique
-- (same message ID can exist in different channels).
CREATE TABLE IF NOT EXISTS tg_msgs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_ext_id INTEGER NOT NULL,                     -- Telegram's message ID
    telegram_channel_id INTEGER NOT NULL,           -- FK to telegram_channel
    data TEXT NOT NULL,                             -- JSON string of raw message data
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (telegram_channel_id) REFERENCES telegram_channel(id) ON DELETE CASCADE,
    UNIQUE(tg_ext_id, telegram_channel_id)          -- Message ID unique per channel
);

-- Index for efficient message lookups
CREATE INDEX IF NOT EXISTS idx_tg_msgs_ext_id 
    ON tg_msgs(tg_ext_id);
CREATE INDEX IF NOT EXISTS idx_tg_msgs_channel 
    ON tg_msgs(telegram_channel_id);

-- ============================================================================
-- join_tg_msgs_forwarded_to_discord: Tracks message forwarding status
-- ============================================================================
-- One-to-many join table: a single tg_msg can be forwarded to multiple
-- discord_webhooks (different subscription groups).
-- Status tracks the forwarding state: pending -> success | error
CREATE TABLE IF NOT EXISTS join_tg_msgs_forwarded_to_discord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_msgs_id INTEGER NOT NULL,                    -- FK to tg_msgs
    tg_ext_msg_id INTEGER NOT NULL,                 -- Denormalized for efficient queries
    discord_webhook_id INTEGER NOT NULL,            -- FK to discord_webhook
    status TEXT NOT NULL CHECK(status IN ('pending', 'error', 'success')),
    error TEXT,                                     -- Error message if status='error'
    created_at TEXT NOT NULL,                       -- Cannot be updated (audit trail)
    FOREIGN KEY (tg_msgs_id) REFERENCES tg_msgs(id) ON DELETE CASCADE,
    FOREIGN KEY (discord_webhook_id) REFERENCES discord_webhook(id) ON DELETE CASCADE,
    UNIQUE(tg_msgs_id, discord_webhook_id)          -- One forward record per message per webhook
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_forward_status 
    ON join_tg_msgs_forwarded_to_discord(status);
CREATE INDEX IF NOT EXISTS idx_forward_pending 
    ON join_tg_msgs_forwarded_to_discord(status, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_forward_ext_msg 
    ON join_tg_msgs_forwarded_to_discord(tg_ext_msg_id);
CREATE INDEX IF NOT EXISTS idx_forward_webhook 
    ON join_tg_msgs_forwarded_to_discord(discord_webhook_id);

-- ============================================================================
-- general_config: Single-row application configuration
-- ============================================================================
CREATE TABLE IF NOT EXISTS general_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron TEXT,                                      -- Cron expression for polling schedule
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- ============================================================================
-- msg_cursor: Tracks scraping progress per Telegram channel
-- ============================================================================
-- One cursor per telegram_channel. Updated after successfully processing
-- messages to enable resumable scraping.
CREATE TABLE IF NOT EXISTS msg_cursor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_channel_id INTEGER NOT NULL UNIQUE,    -- One cursor per channel
    last_seen_msg_id INTEGER NOT NULL,              -- Last processed Telegram message ID
    last_seen_msg_time TEXT,                        -- ISO 8601 timestamp of last message
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (telegram_channel_id) REFERENCES telegram_channel(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cursor_channel 
    ON msg_cursor(telegram_channel_id);
`;

/**
 * Initial data to insert after schema creation.
 * Ensures configuration table has a default row.
 */
const INITIAL_DATA = `
-- Insert default config if not exists
INSERT OR IGNORE INTO general_config (id, cron, created_at, updated_at)
VALUES (1, '*/10 * * * *', datetime('now'), datetime('now'));
`;

/**
 * Migration statements for adding columns to existing tables.
 * These are safe to run multiple times (they check if column exists first).
 */
const MIGRATIONS = [
  {
    name: "Add discord_channel_info_id to discord_webhook",
    check: `SELECT COUNT(*) as count FROM pragma_table_info('discord_webhook') WHERE name='discord_channel_info_id'`,
    migrate: `ALTER TABLE discord_webhook ADD COLUMN discord_channel_info_id INTEGER REFERENCES discord_channel_info(id) ON DELETE SET NULL`
  }
];

/**
 * Sets up the database schema idempotently.
 * Safe to call multiple times - only creates missing objects.
 * 
 * @param dbPath - Optional path to the SQLite database file.
 *                 If not provided, uses SQLITE_PATH from config.
 */
export function setupDatabase(dbPath?: string): void {
  // Load environment variables
  const config = getConfig();
  const path = dbPath ?? config.SQLITE_PATH;
  
  console.log(`Setting up database at: ${path}`);
  
  // Create/open database with WAL mode
  const db = new Database(path);
  
  try {
    // Execute schema (CREATE IF NOT EXISTS makes this idempotent)
    db.exec(SCHEMA);
    console.log("Schema created/verified successfully");

    // Run migrations for existing databases
    for (const migration of MIGRATIONS) {
      const result = db.prepare(migration.check).get() as { count: number };
      if (result.count === 0) {
        console.log(`Running migration: ${migration.name}`);
        db.exec(migration.migrate);
        console.log(`  Migration complete: ${migration.name}`);
      }
    }

    // Insert default data
    db.exec(INITIAL_DATA);
    console.log("Default data ensured");

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;

    console.log("Tables in database:", tables.map(t => t.name).join(", "));

    // Verify WAL mode is enabled
    const journalMode = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    console.log("Journal mode:", journalMode[0]?.journal_mode);

    console.log("Database setup complete!");
  } finally {
    db.close();
  }
}

/**
 * Resets the database by dropping all tables and recreating them.
 * WARNING: This deletes all data! Use only for development/testing.
 */
export function resetDatabase(dbPath?: string): void {
  const config = getConfig();
  const path = dbPath ?? config.SQLITE_PATH;
  
  console.log(`Resetting database at: ${path}`);
  console.log("WARNING: This will delete all data!");
  
  const db = new Database(path);
  
  try {
    // Disable foreign keys temporarily for dropping
    db.pragma("foreign_keys = OFF");
    
    // Drop all tables in reverse dependency order
    const dropStatements = `
      DROP TABLE IF EXISTS join_tg_msgs_forwarded_to_discord;
      DROP TABLE IF EXISTS msg_cursor;
      DROP TABLE IF EXISTS tg_msgs;
      DROP TABLE IF EXISTS discord_webhook;
      DROP TABLE IF EXISTS discord_channel_info;
      DROP TABLE IF EXISTS telegram_channel;
      DROP TABLE IF EXISTS general_config;
    `;
    
    db.exec(dropStatements);
    console.log("All tables dropped");
    
    // Re-enable foreign keys
    db.pragma("foreign_keys = ON");
    
    // Recreate schema
    db.exec(SCHEMA);
    db.exec(INITIAL_DATA);
    console.log("Schema recreated");
    
    console.log("Database reset complete!");
  } finally {
    db.close();
  }
}

// Run setup if this file is executed directly
// Using process.argv to detect direct execution in ES modules
const isMainModule = process.argv[1]?.endsWith("db-setup") || 
                     process.argv[1]?.includes("db-setup/dist");

if (isMainModule) {
  // Load dotenv for direct execution
  const { config: loadDotenv } = await import("dotenv");
  loadDotenv();
  
  const args = process.argv.slice(2);
  
  if (args.includes("--reset")) {
    resetDatabase();
  } else {
    setupDatabase();
  }
}

export { SCHEMA };

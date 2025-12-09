/**
 * Configuration and Cursor Queries
 * 
 * Database operations for the general_config and msg_cursor tables.
 * - general_config: Single-row configuration storage (cron settings)
 * - msg_cursor: Tracks scraping progress per telegram channel
 */

import {
  type Result,
  ok,
  err,
  type AppError,
  appErrorFromException,
  ErrorCodes
} from "@tg-discord/result";
import type { GeneralConfig, MsgCursor } from "@tg-discord/shared-types";
import { getConnection, nowUtc } from "../connection.js";

// ============================================================================
// general_config table operations
// ============================================================================

/**
 * Gets the general configuration (single row).
 * Returns null if no configuration exists yet.
 */
export function getGeneralConfig(): Result<GeneralConfig | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, cron, created_at, updated_at
      FROM general_config
      LIMIT 1
    `).get() as GeneralConfig | undefined;
    
    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get general config"
    ));
  }
}

/**
 * Updates the general configuration.
 * Creates the config row if it doesn't exist.
 * 
 * @param cron - The cron expression for polling schedule
 */
export function updateGeneralConfig(cron: string): Result<GeneralConfig, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const now = nowUtc();
    
    // Check if config exists
    const existing = db.prepare("SELECT id FROM general_config LIMIT 1").get() as { id: number } | undefined;
    
    if (existing) {
      // Update existing
      db.prepare(`
        UPDATE general_config
        SET cron = ?, updated_at = ?
        WHERE id = ?
      `).run(cron, now, existing.id);
    } else {
      // Insert new
      db.prepare(`
        INSERT INTO general_config (cron, created_at, updated_at)
        VALUES (?, ?, ?)
      `).run(cron, now, now);
    }
    
    // Fetch and return the config
    const row = db.prepare(`
      SELECT id, cron, created_at, updated_at
      FROM general_config
      LIMIT 1
    `).get() as GeneralConfig;
    
    return ok(row);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to update general config"
    ));
  }
}

/**
 * Ensures a config row exists with default values.
 * Used during initialization.
 * 
 * @param defaultCron - Default cron expression to use if creating new
 */
export function ensureConfigExists(defaultCron: string): Result<GeneralConfig, AppError> {
  const existingResult = getGeneralConfig();
  if (!existingResult.ok) return existingResult;
  
  if (existingResult.value) {
    return ok(existingResult.value);
  }
  
  return updateGeneralConfig(defaultCron);
}

// ============================================================================
// msg_cursor table operations
// ============================================================================

/**
 * Gets the cursor for a specific telegram channel.
 * The cursor tracks the last processed message ID for resumable scraping.
 */
export function getMsgCursor(
  telegramChannelId: number
): Result<MsgCursor | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, telegram_channel_id, last_seen_msg_id, last_seen_msg_time, created_at, updated_at
      FROM msg_cursor
      WHERE telegram_channel_id = ?
    `).get(telegramChannelId) as MsgCursor | undefined;
    
    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get message cursor"
    ));
  }
}

/**
 * Updates or creates a cursor for a telegram channel.
 * This should be called after successfully processing messages to track progress.
 * 
 * @param telegramChannelId - The internal channel ID
 * @param lastSeenMsgId - The Telegram message ID of the last processed message
 * @param lastSeenMsgTime - Optional ISO timestamp of the last message
 */
export function updateMsgCursor(
  telegramChannelId: number,
  lastSeenMsgId: number,
  lastSeenMsgTime?: string | null
): Result<MsgCursor, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const now = nowUtc();
    
    // Check if cursor exists
    const existing = db.prepare(`
      SELECT id FROM msg_cursor WHERE telegram_channel_id = ?
    `).get(telegramChannelId) as { id: number } | undefined;
    
    if (existing) {
      // Update existing - only update if new message ID is greater
      db.prepare(`
        UPDATE msg_cursor
        SET last_seen_msg_id = MAX(last_seen_msg_id, ?),
            last_seen_msg_time = COALESCE(?, last_seen_msg_time),
            updated_at = ?
        WHERE id = ?
      `).run(lastSeenMsgId, lastSeenMsgTime ?? null, now, existing.id);
    } else {
      // Insert new
      db.prepare(`
        INSERT INTO msg_cursor (telegram_channel_id, last_seen_msg_id, last_seen_msg_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(telegramChannelId, lastSeenMsgId, lastSeenMsgTime ?? null, now, now);
    }
    
    // Fetch and return the cursor
    const row = db.prepare(`
      SELECT id, telegram_channel_id, last_seen_msg_id, last_seen_msg_time, created_at, updated_at
      FROM msg_cursor
      WHERE telegram_channel_id = ?
    `).get(telegramChannelId) as MsgCursor;
    
    return ok(row);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to update message cursor"
    ));
  }
}

/**
 * Gets all cursors with their associated telegram channel info.
 * Useful for debugging and status reporting.
 */
export function getAllCursorsWithChannelInfo(): Result<Array<{
  cursor: MsgCursor;
  channelUrl: string;
  channelUsername: string | null;
}>, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const rows = db.prepare(`
      SELECT 
        mc.id, mc.telegram_channel_id, mc.last_seen_msg_id, mc.last_seen_msg_time,
        mc.created_at, mc.updated_at,
        tc.telegram_url as channel_url, tc.telegram_username as channel_username
      FROM msg_cursor mc
      INNER JOIN telegram_channel tc ON tc.id = mc.telegram_channel_id
      ORDER BY mc.updated_at DESC
    `).all() as Array<{
      id: number;
      telegram_channel_id: number;
      last_seen_msg_id: number;
      last_seen_msg_time: string | null;
      created_at: string;
      updated_at: string;
      channel_url: string;
      channel_username: string | null;
    }>;
    
    return ok(rows.map(row => ({
      cursor: {
        id: row.id,
        telegram_channel_id: row.telegram_channel_id,
        last_seen_msg_id: row.last_seen_msg_id,
        last_seen_msg_time: row.last_seen_msg_time,
        created_at: row.created_at,
        updated_at: row.updated_at
      },
      channelUrl: row.channel_url,
      channelUsername: row.channel_username
    })));
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get all cursors with channel info"
    ));
  }
}

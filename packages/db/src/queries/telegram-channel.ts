/**
 * Telegram Channel Queries
 *
 * Database operations for the telegram_channel table.
 * This table stores canonical information about Telegram channels,
 * acting as a single source of truth that discord_webhook references.
 */

import {
  type Result,
  ok,
  err,
  type AppError,
  appErrorFromException,
  ErrorCodes
} from "@tg-discord/result";
import type { TelegramChannel } from "@tg-discord/shared-types";
import { getConnection, nowUtc } from "../connection.js";

/**
 * Gets a telegram channel by its URL.
 *
 * @param telegramUrl - The t.me URL of the channel
 * @returns The channel record if found, null if not found
 */
export function getTelegramChannelByUrl(
  telegramUrl: string
): Result<TelegramChannel | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, telegram_id, telegram_url, telegram_username, created_at, updated_at
      FROM telegram_channel
      WHERE telegram_url = ?
    `).get(telegramUrl) as TelegramChannel | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get telegram channel by URL"
    ));
  }
}

/**
 * Gets a telegram channel by its Telegram ID.
 *
 * @param telegramId - The Telegram channel ID (integer)
 * @returns The channel record if found, null if not found
 */
export function getTelegramChannelByTelegramId(
  telegramId: number
): Result<TelegramChannel | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, telegram_id, telegram_url, telegram_username, created_at, updated_at
      FROM telegram_channel
      WHERE telegram_id = ?
    `).get(telegramId) as TelegramChannel | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get telegram channel by Telegram ID"
    ));
  }
}

/**
 * Gets a telegram channel by its internal database ID.
 */
export function getTelegramChannelById(
  id: number
): Result<TelegramChannel | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, telegram_id, telegram_url, telegram_username, created_at, updated_at
      FROM telegram_channel
      WHERE id = ?
    `).get(id) as TelegramChannel | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get telegram channel by ID"
    ));
  }
}

/**
 * Creates a new telegram channel record.
 *
 * @param telegramUrl - The t.me URL (required)
 * @param telegramId - The Telegram channel ID (optional, can be resolved later)
 * @param telegramUsername - The channel username (optional)
 * @returns The created channel record
 */
export function createTelegramChannel(
  telegramUrl: string,
  telegramId?: number | null,
  telegramUsername?: string | null
): Result<TelegramChannel, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const now = nowUtc();

    const result = db.prepare(`
      INSERT INTO telegram_channel (telegram_url, telegram_id, telegram_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(telegramUrl, telegramId ?? null, telegramUsername ?? null, now, now);

    // Fetch the created record
    const row = db.prepare(`
      SELECT id, telegram_id, telegram_url, telegram_username, created_at, updated_at
      FROM telegram_channel
      WHERE id = ?
    `).get(result.lastInsertRowid) as TelegramChannel;

    return ok(row);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to create telegram channel"
    ));
  }
}

/**
 * Gets or creates a telegram channel by URL.
 * If the channel exists, returns it. Otherwise creates a new one.
 *
 * @param telegramUrl - The t.me URL
 * @param telegramUsername - The telegram channel's username
 * @returns The existing or newly created channel
 */
export function getOrCreateTelegramChannelRecord(
  telegramUrl: string,
  telegramUsername: string
): Result<TelegramChannel, AppError> {
  const existingResult = getTelegramChannelByUrl(telegramUrl);
  if (!existingResult.ok) return existingResult;

  if (existingResult.value) {
    return ok(existingResult.value);
  }

  return createTelegramChannel(telegramUrl, null, telegramUsername);
}

/**
 * Updates a telegram channel's resolved ID and username.
 * Used when the Python scraper resolves channel info from Telegram API.
 *
 * @param id - The internal database ID
 * @param telegramId - The resolved Telegram channel ID
 * @param telegramUsername - The resolved username
 */
export function updateTelegramChannelInfo(
  id: number,
  telegramId: number,
  telegramUsername?: string | null
): Result<TelegramChannel, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const now = nowUtc();

    db.prepare(`
      UPDATE telegram_channel
      SET telegram_id = ?, telegram_username = ?, updated_at = ?
      WHERE id = ?
    `).run(telegramId, telegramUsername ?? null, now, id);

    // Fetch the updated record
    const row = db.prepare(`
      SELECT id, telegram_id, telegram_url, telegram_username, created_at, updated_at
      FROM telegram_channel
      WHERE id = ?
    `).get(id) as TelegramChannel | undefined;

    if (!row) {
      return err({
        code: ErrorCodes.DB_NOT_FOUND,
        message: `Telegram channel with id ${id} not found`,
        timestamp: nowUtc()
      });
    }

    return ok(row);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to update telegram channel info"
    ));
  }
}

/**
 * Gets all telegram channels that have active webhook subscriptions.
 * Used by the scraper to determine which channels to monitor.
 */
export function getActiveSubscribedChannels(): Result<TelegramChannel[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const rows = db.prepare(`
      SELECT DISTINCT tc.id, tc.telegram_id, tc.telegram_url, tc.telegram_username, 
             tc.created_at, tc.updated_at
      FROM telegram_channel tc
      INNER JOIN discord_webhook dw ON dw.telegram_channel_id = tc.id
      WHERE dw.is_active = 1
    `).all() as TelegramChannel[];

    return ok(rows);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get active subscribed channels"
    ));
  }
}

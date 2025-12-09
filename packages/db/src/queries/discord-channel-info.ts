/**
 * Discord Channel Info Queries
 *
 * CRUD operations for the discord_channel_info table.
 * Stores Discord channel/server metadata to avoid repeated API calls.
 */

import {
  type Result,
  ok,
  err,
  createAppError,
  ErrorCodes,
  appErrorFromException,
  type AppError
} from "@tg-discord/result";
import { getConnection, nowUtc } from "../connection.js";

/**
 * Discord channel info record shape.
 */
export interface DiscordChannelInfo {
  id: number;
  channel_id: string;
  server_id: string;
  channel_name: string;
  server_name: string;
  created_at: string;
  updated_at: string;
}

/**
 * Gets a discord channel info record by channel_id and server_id.
 */
export function getDiscordChannelInfo(
  channelId: string,
  serverId: string
): Result<DiscordChannelInfo | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;

    const row = db.prepare(`
      SELECT id, channel_id, server_id, channel_name, server_name, created_at, updated_at
      FROM discord_channel_info
      WHERE channel_id = ? AND server_id = ?
    `).get(channelId, serverId) as DiscordChannelInfo | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get discord channel info"
    ));
  }
}

/**
 * Gets a discord channel info record by its ID.
 */
export function getDiscordChannelInfoById(
  id: number
): Result<DiscordChannelInfo | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;

    const row = db.prepare(`
      SELECT id, channel_id, server_id, channel_name, server_name, created_at, updated_at
      FROM discord_channel_info
      WHERE id = ?
    `).get(id) as DiscordChannelInfo | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get discord channel info by id"
    ));
  }
}

/**
 * Creates or updates a discord channel info record.
 * If a record with the same channel_id and server_id exists, it updates the names.
 * Otherwise, creates a new record.
 * Returns the record (either existing updated or newly created).
 */
export function getOrCreateDiscordChannelInfo(
  channelId: string,
  serverId: string,
  channelName: string,
  serverName: string
): Result<DiscordChannelInfo, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const now = nowUtc();

    // Check if record exists
    const existing = db.prepare(`
      SELECT id, channel_id, server_id, channel_name, server_name, created_at, updated_at
      FROM discord_channel_info
      WHERE channel_id = ? AND server_id = ?
    `).get(channelId, serverId) as DiscordChannelInfo | undefined;

    if (existing) {
      // Update names if they changed
      if (existing.channel_name !== channelName || existing.server_name !== serverName) {
        db.prepare(`
          UPDATE discord_channel_info
          SET channel_name = ?, server_name = ?, updated_at = ?
          WHERE id = ?
        `).run(channelName, serverName, now, existing.id);

        return ok({
          ...existing,
          channel_name: channelName,
          server_name: serverName,
          updated_at: now
        });
      }
      return ok(existing);
    }

    // Create new record
    const result = db.prepare(`
      INSERT INTO discord_channel_info (channel_id, server_id, channel_name, server_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(channelId, serverId, channelName, serverName, now, now);

    const row = db.prepare(`
      SELECT id, channel_id, server_id, channel_name, server_name, created_at, updated_at
      FROM discord_channel_info
      WHERE id = ?
    `).get(result.lastInsertRowid) as DiscordChannelInfo;

    return ok(row);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get or create discord channel info"
    ));
  }
}

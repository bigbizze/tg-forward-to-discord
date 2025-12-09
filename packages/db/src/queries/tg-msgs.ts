/**
 * Telegram Message Queries
 *
 * Database operations for the tg_msgs and join_tg_msgs_forwarded_to_discord tables.
 * These tables track telegram messages and their forwarding status to Discord.
 */

import {
  type Result,
  ok,
  err,
  type AppError,
  appErrorFromException,
  ErrorCodes
} from "@tg-discord/result";
import {
  type TgMsg,
  type TgMsgForwarded,
  type PendingForwardDetails,
  PendingForwardDetailsSchemaArray
} from "@tg-discord/shared-types";
import { getConnection, nowUtc } from "../connection.js";

// ============================================================================
// tg_msgs table operations
// ============================================================================

/**
 * Gets a telegram message by its external Telegram message ID and channel.
 * The combination of tg_ext_id and telegram_channel_id is unique.
 */
export function getTgMsgByExtId(
  tgExtId: number,
  telegramChannelId: number
): Result<TgMsg | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, tg_ext_id, telegram_channel_id, data, created_at, updated_at
      FROM tg_msgs
      WHERE tg_ext_id = ? AND telegram_channel_id = ?
    `).get(tgExtId, telegramChannelId) as TgMsg | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get telegram message by external ID"
    ));
  }
}

/**
 * Creates a new telegram message record.
 *
 * @param tgExtId - The Telegram message ID
 * @param telegramChannelId - The internal channel ID (FK to telegram_channel)
 * @param data - JSON string of the raw message data
 */
export function createTgMsg(
  tgExtId: number,
  telegramChannelId: number,
  data: string
): Result<TgMsg, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const now = nowUtc();

    const result = db.prepare(`
      INSERT INTO tg_msgs (tg_ext_id, telegram_channel_id, data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tgExtId, telegramChannelId, data, now, now);

    const row = db.prepare(`
      SELECT id, tg_ext_id, telegram_channel_id, data, created_at, updated_at
      FROM tg_msgs
      WHERE id = ?
    `).get(result.lastInsertRowid) as TgMsg;

    return ok(row);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to create telegram message"
    ));
  }
}

/**
 * Gets or creates a telegram message record.
 * If the message already exists (same tg_ext_id and channel), returns existing.
 */
export function getOrCreateTgMsg(
  tgExtId: number,
  telegramChannelId: number,
  data: string
): Result<{ msg: TgMsg; created: boolean }, AppError> {
  const existingResult = getTgMsgByExtId(tgExtId, telegramChannelId);
  if (!existingResult.ok) return existingResult;

  if (existingResult.value) {
    return ok({ msg: existingResult.value, created: false });
  }

  const createResult = createTgMsg(tgExtId, telegramChannelId, data);
  if (!createResult.ok) return createResult;

  return ok({ msg: createResult.value, created: true });
}

// ============================================================================
// join_tg_msgs_forwarded_to_discord table operations
// ============================================================================

/**
 * Gets all forward records for a specific telegram message (by external ID).
 * Used to check which webhooks have already received this message.
 */
export function getForwardRecordsForMessage(
  tgExtMsgId: number
): Result<TgMsgForwarded[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const rows = db.prepare(`
      SELECT id, tg_msgs_id, tg_ext_msg_id, discord_webhook_id, status, error, created_at
      FROM join_tg_msgs_forwarded_to_discord
      WHERE tg_ext_msg_id = ?
    `).all(tgExtMsgId) as TgMsgForwarded[];

    return ok(rows);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get forward records for message"
    ));
  }
}

/**
 * Gets pending forward records (messages waiting to be sent to Discord).
 * Optionally limited to a specific batch size for processing.
 */
export function getPendingForwardRecords(
  limit?: number
): Result<TgMsgForwarded[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const query = limit
      ? `SELECT id, tg_msgs_id, tg_ext_msg_id, discord_webhook_id, status, error, created_at
         FROM join_tg_msgs_forwarded_to_discord
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`
      : `SELECT id, tg_msgs_id, tg_ext_msg_id, discord_webhook_id, status, error, created_at
         FROM join_tg_msgs_forwarded_to_discord
         WHERE status = 'pending'
         ORDER BY created_at ASC`;

    const rows = limit
      ? db.prepare(query).all(limit) as TgMsgForwarded[]
      : db.prepare(query).all() as TgMsgForwarded[];

    return ok(rows);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get pending forward records"
    ));
  }
}

/**
 * Creates a pending forward record.
 * This is called when a new message needs to be forwarded to a webhook.
 */
export function createPendingForwardRecord(
  tgMsgsId: number,
  tgExtMsgId: number,
  discordWebhookId: number
): Result<TgMsgForwarded, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const now = nowUtc();

    const result = db.prepare(`
      INSERT INTO join_tg_msgs_forwarded_to_discord 
        (tg_msgs_id, tg_ext_msg_id, discord_webhook_id, status, error, created_at)
      VALUES (?, ?, ?, 'pending', NULL, ?)
    `).run(tgMsgsId, tgExtMsgId, discordWebhookId, now);

    const row = db.prepare(`
      SELECT id, tg_msgs_id, tg_ext_msg_id, discord_webhook_id, status, error, created_at
      FROM join_tg_msgs_forwarded_to_discord
      WHERE id = ?
    `).get(result.lastInsertRowid) as TgMsgForwarded;

    return ok(row);
  } catch (error) {
    // Handle unique constraint violation - record already exists
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      // This isn't an error - just means record already exists
      const existingResult = getForwardRecordByMsgAndWebhook(tgMsgsId, discordWebhookId);
      if (existingResult.ok && existingResult.value) {
        return ok(existingResult.value);
      }
    }
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to create pending forward record"
    ));
  }
}

/**
 * Gets a forward record by message ID and webhook ID.
 */
export function getForwardRecordByMsgAndWebhook(
  tgMsgsId: number,
  discordWebhookId: number
): Result<TgMsgForwarded | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, tg_msgs_id, tg_ext_msg_id, discord_webhook_id, status, error, created_at
      FROM join_tg_msgs_forwarded_to_discord
      WHERE tg_msgs_id = ? AND discord_webhook_id = ?
    `).get(tgMsgsId, discordWebhookId) as TgMsgForwarded | undefined;

    return ok(row ?? null);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get forward record"
    ));
  }
}

/**
 * Updates a forward record's status to success.
 */
export function markForwardSuccess(
  id: number
): Result<void, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    db.prepare(`
      UPDATE join_tg_msgs_forwarded_to_discord
      SET status = 'success'
      WHERE id = ?
    `).run(id);

    return ok(undefined);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to mark forward as success"
    ));
  }
}

/**
 * Updates a forward record's status to error with an error message.
 */
export function markForwardError(
  id: number,
  errorMessage: string
): Result<void, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    db.prepare(`
      UPDATE join_tg_msgs_forwarded_to_discord
      SET status = 'error', error = ?
      WHERE id = ?
    `).run(errorMessage, id);

    return ok(undefined);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to mark forward as error"
    ));
  }
}

/**
 * Finds webhooks that should receive a message but haven't yet.
 * Used to determine which pending forward records need to be created.
 *
 * @param tgExtMsgId - The Telegram message external ID
 * @param telegramChannelId - The internal telegram_channel ID
 * @returns Array of discord_webhook IDs that need to receive this message
 */
export function getWebhooksMissingMessage(
  tgExtMsgId: number,
  telegramChannelId: number
): Result<number[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;

    // Find active webhooks for this channel that don't have a forward record for this message
    const rows = db.prepare(`
      SELECT dw.id
      FROM discord_webhook dw
      WHERE dw.telegram_channel_id = ?
        AND dw.is_active = 1
        AND dw.id NOT IN (
          SELECT discord_webhook_id
          FROM join_tg_msgs_forwarded_to_discord
          WHERE tg_ext_msg_id = ?
        )
    `).all(telegramChannelId, tgExtMsgId) as Array<{ id: number }>;

    return ok(rows.map(r => r.id));
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get webhooks missing message"
    ));
  }
}


/**
 * Gets detailed pending forward information for processing.
 * Joins with tg_msgs, discord_webhook, and discord_channel_info to get all needed data.
 */
export function getPendingForwardsWithDetails(
  limit?: number
): Result<PendingForwardDetails[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;

    const query = `
      SELECT
        f.id as forwardId,
        f.tg_msgs_id as tgMsgsId,
        f.tg_ext_msg_id as tgExtMsgId,
        m.telegram_channel_id as telegramChannelId,
        tc.telegram_username as telegramChannelUsername,
        tc.telegram_url as telegramChannelUrl,
        m.data as messageData,
        f.discord_webhook_id as discordWebhookId,
        dw.discord_webhook_url as discordWebhookUrl,
        dw.subscription_group_id as subscriptionGroupId,
        dci.channel_id as discordChannelId,
        dci.server_id as discordServerId,
        dci.channel_name as discordChannelName,
        dci.server_name as discordServerName
      FROM join_tg_msgs_forwarded_to_discord f
      INNER JOIN tg_msgs m ON m.id = f.tg_msgs_id
      INNER JOIN telegram_channel tc ON tc.id = m.telegram_channel_id
      INNER JOIN discord_webhook dw ON dw.id = f.discord_webhook_id
      INNER JOIN discord_channel_info dci ON dci.id = dw.discord_channel_info_id
      WHERE f.status = 'pending' AND dw.is_active = 1
      ORDER BY f.created_at ASC
      ${limit ? `LIMIT ${limit}` : ""}
    `;

    const rows = db.prepare(query).all() as unknown[];

    const parsed: PendingForwardDetails[] = PendingForwardDetailsSchemaArray.parse(rows);

    return ok(parsed);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get pending forwards with details"
    ));
  }
}

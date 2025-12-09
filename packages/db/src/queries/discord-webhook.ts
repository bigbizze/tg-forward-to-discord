/**
 * Discord Webhook Queries
 * 
 * Database operations for the discord_webhook table.
 * This table stores webhook subscriptions that link Discord channels
 * to Telegram channels via the telegram_channel table.
 */

import {
  type Result,
  ok,
  err,
  type AppError,
  appErrorFromException,
  ErrorCodes
} from "@tg-discord/result";
import type { DiscordWebhook } from "@tg-discord/shared-types";
import { getConnection, nowUtc } from "../connection.js";

/**
 * Gets all active discord webhooks.
 */
export function getActiveDiscordWebhooks(): Result<DiscordWebhook[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const rows = db.prepare(`
      SELECT id, subscription_group_id, description, discord_webhook_url,
             telegram_channel_id, is_active, created_at, updated_at
      FROM discord_webhook
      WHERE is_active = 1
    `).all() as Array<{
      id: number;
      subscription_group_id: string;
      description: string | null;
      discord_webhook_url: string;
      telegram_channel_id: number;
      is_active: number;
      created_at: string;
      updated_at: string;
    }>;
    
    // Convert is_active from SQLite integer to boolean
    const webhooks: DiscordWebhook[] = rows.map(row => ({
      ...row,
      is_active: row.is_active === 1
    }));
    
    return ok(webhooks);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get active discord webhooks"
    ));
  }
}

/**
 * Gets discord webhooks by subscription group ID.
 */
export function getDiscordWebhooksByGroup(
  subscriptionGroupId: string
): Result<DiscordWebhook[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const rows = db.prepare(`
      SELECT id, subscription_group_id, description, discord_webhook_url,
             telegram_channel_id, is_active, created_at, updated_at
      FROM discord_webhook
      WHERE subscription_group_id = ?
    `).all(subscriptionGroupId) as Array<{
      id: number;
      subscription_group_id: string;
      description: string | null;
      discord_webhook_url: string;
      telegram_channel_id: number;
      is_active: number;
      created_at: string;
      updated_at: string;
    }>;
    
    const webhooks: DiscordWebhook[] = rows.map(row => ({
      ...row,
      is_active: row.is_active === 1
    }));
    
    return ok(webhooks);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get discord webhooks by group"
    ));
  }
}

/**
 * Gets active discord webhooks that are subscribed to a specific telegram channel.
 * Used when processing incoming messages to determine where to forward them.
 */
export function getWebhooksForTelegramChannel(
  telegramChannelId: number
): Result<DiscordWebhook[], AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const rows = db.prepare(`
      SELECT id, subscription_group_id, description, discord_webhook_url,
             telegram_channel_id, is_active, created_at, updated_at
      FROM discord_webhook
      WHERE telegram_channel_id = ? AND is_active = 1
    `).all(telegramChannelId) as Array<{
      id: number;
      subscription_group_id: string;
      description: string | null;
      discord_webhook_url: string;
      telegram_channel_id: number;
      is_active: number;
      created_at: string;
      updated_at: string;
    }>;
    
    const webhooks: DiscordWebhook[] = rows.map(row => ({
      ...row,
      is_active: row.is_active === 1
    }));
    
    return ok(webhooks);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get webhooks for telegram channel"
    ));
  }
}

/**
 * Gets a specific discord webhook by group ID and telegram channel ID.
 */
export function getDiscordWebhook(
  subscriptionGroupId: string,
  telegramChannelId: number
): Result<DiscordWebhook | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, subscription_group_id, description, discord_webhook_url,
             telegram_channel_id, is_active, created_at, updated_at
      FROM discord_webhook
      WHERE subscription_group_id = ? AND telegram_channel_id = ?
    `).get(subscriptionGroupId, telegramChannelId) as {
      id: number;
      subscription_group_id: string;
      description: string | null;
      discord_webhook_url: string;
      telegram_channel_id: number;
      is_active: number;
      created_at: string;
      updated_at: string;
    } | undefined;
    
    if (!row) {
      return ok(null);
    }
    
    return ok({
      ...row,
      is_active: row.is_active === 1
    });
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get discord webhook"
    ));
  }
}

/**
 * Creates or reactivates a discord webhook subscription.
 * If a matching inactive subscription exists, it will be reactivated.
 * Otherwise, a new subscription is created.
 */
export function createOrActivateDiscordWebhook(
  subscriptionGroupId: string,
  discordWebhookUrl: string,
  telegramChannelId: number,
  description?: string | null,
  discordChannelInfoId?: number | null
): Result<DiscordWebhook, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;
    const now = nowUtc();

    // Check if a subscription already exists (active or inactive)
    const existing = db.prepare(`
      SELECT id, is_active FROM discord_webhook
      WHERE subscription_group_id = ? AND telegram_channel_id = ?
    `).get(subscriptionGroupId, telegramChannelId) as { id: number; is_active: number } | undefined;

    if (existing) {
      // Update existing record - reactivate and update webhook URL and channel info if needed
      db.prepare(`
        UPDATE discord_webhook
        SET is_active = 1, discord_webhook_url = ?, description = ?, discord_channel_info_id = ?, updated_at = ?
        WHERE id = ?
      `).run(discordWebhookUrl, description ?? null, discordChannelInfoId ?? null, now, existing.id);

      const row = db.prepare(`
        SELECT id, subscription_group_id, description, discord_webhook_url,
               telegram_channel_id, discord_channel_info_id, is_active, created_at, updated_at
        FROM discord_webhook
        WHERE id = ?
      `).get(existing.id) as {
        id: number;
        subscription_group_id: string;
        description: string | null;
        discord_webhook_url: string;
        telegram_channel_id: number;
        discord_channel_info_id: number | null;
        is_active: number;
        created_at: string;
        updated_at: string;
      };

      return ok({
        ...row,
        is_active: row.is_active === 1
      });
    }

    // Create new subscription
    const result = db.prepare(`
      INSERT INTO discord_webhook
        (subscription_group_id, description, discord_webhook_url, telegram_channel_id, discord_channel_info_id, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(subscriptionGroupId, description ?? null, discordWebhookUrl, telegramChannelId, discordChannelInfoId ?? null, now, now);

    const row = db.prepare(`
      SELECT id, subscription_group_id, description, discord_webhook_url,
             telegram_channel_id, discord_channel_info_id, is_active, created_at, updated_at
      FROM discord_webhook
      WHERE id = ?
    `).get(result.lastInsertRowid) as {
      id: number;
      subscription_group_id: string;
      description: string | null;
      discord_webhook_url: string;
      telegram_channel_id: number;
      discord_channel_info_id: number | null;
      is_active: number;
      created_at: string;
      updated_at: string;
    };

    return ok({
      ...row,
      is_active: row.is_active === 1
    });
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to create or activate discord webhook"
    ));
  }
}

/**
 * Deactivates (soft delete) a discord webhook subscription.
 * Returns true if a subscription was deactivated, false if not found.
 */
export function deactivateDiscordWebhook(
  subscriptionGroupId: string,
  telegramChannelId: number
): Result<boolean, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const now = nowUtc();
    
    const result = db.prepare(`
      UPDATE discord_webhook
      SET is_active = 0, updated_at = ?
      WHERE subscription_group_id = ? AND telegram_channel_id = ? AND is_active = 1
    `).run(now, subscriptionGroupId, telegramChannelId);
    
    return ok(result.changes > 0);
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to deactivate discord webhook"
    ));
  }
}

/**
 * Gets discord webhook by ID.
 */
export function getDiscordWebhookById(
  id: number
): Result<DiscordWebhook | null, AppError> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;
  
  try {
    const db = connResult.value;
    const row = db.prepare(`
      SELECT id, subscription_group_id, description, discord_webhook_url,
             telegram_channel_id, is_active, created_at, updated_at
      FROM discord_webhook
      WHERE id = ?
    `).get(id) as {
      id: number;
      subscription_group_id: string;
      description: string | null;
      discord_webhook_url: string;
      telegram_channel_id: number;
      is_active: number;
      created_at: string;
      updated_at: string;
    } | undefined;
    
    if (!row) {
      return ok(null);
    }
    
    return ok({
      ...row,
      is_active: row.is_active === 1
    });
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get discord webhook by ID"
    ));
  }
}

/**
 * Subscription group with discord channel info for GET /config response.
 */
export interface GroupedSubscription {
  subscription_group_id: string;
  discord_webhook_url: string;
  telegram_channels: string[];
  discord_channel_id: string | null;
  discord_server_id: string | null;
  discord_channel_name: string | null;
  discord_server_name: string | null;
}

/**
 * Gets grouped active subscriptions for the GET /config response.
 * Groups webhooks by subscription_group_id with their telegram channels.
 * Includes discord channel info if available.
 */
export function getGroupedActiveSubscriptions(): Result<
  Array<GroupedSubscription>,
  AppError
> {
  const connResult = getConnection();
  if (!connResult.ok) return connResult;

  try {
    const db = connResult.value;

    // Get all active webhooks with their telegram channel URLs and discord channel info
    const rows = db.prepare(`
      SELECT
        dw.subscription_group_id,
        dw.discord_webhook_url,
        tc.telegram_url,
        dci.channel_id AS discord_channel_id,
        dci.server_id AS discord_server_id,
        dci.channel_name AS discord_channel_name,
        dci.server_name AS discord_server_name
      FROM discord_webhook dw
      INNER JOIN telegram_channel tc ON tc.id = dw.telegram_channel_id
      LEFT JOIN discord_channel_info dci ON dci.id = dw.discord_channel_info_id
      WHERE dw.is_active = 1
      ORDER BY dw.subscription_group_id, tc.telegram_url
    `).all() as Array<{
      subscription_group_id: string;
      discord_webhook_url: string;
      telegram_url: string;
      discord_channel_id: string | null;
      discord_server_id: string | null;
      discord_channel_name: string | null;
      discord_server_name: string | null;
    }>;

    // Group by subscription_group_id
    const grouped = new Map<string, GroupedSubscription>();

    for (const row of rows) {
      const existing = grouped.get(row.subscription_group_id);
      if (existing) {
        existing.telegram_channels.push(row.telegram_url);
      } else {
        grouped.set(row.subscription_group_id, {
          subscription_group_id: row.subscription_group_id,
          discord_webhook_url: row.discord_webhook_url,
          telegram_channels: [ row.telegram_url ],
          discord_channel_id: row.discord_channel_id,
          discord_server_id: row.discord_server_id,
          discord_channel_name: row.discord_channel_name,
          discord_server_name: row.discord_server_name
        });
      }
    }

    return ok(Array.from(grouped.values()));
  } catch (error) {
    return err(appErrorFromException(
      error,
      ErrorCodes.DB_QUERY_ERROR,
      "Failed to get grouped active subscriptions"
    ));
  }
}

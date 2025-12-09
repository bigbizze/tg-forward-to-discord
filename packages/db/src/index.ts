/**
 * Database Package
 *
 * Provides the domain layer for database operations using SQLite.
 * All functions return Result types for safe error handling.
 *
 * This package is used by both TypeScript applications (Express, Discord bot)
 * and indirectly influences the Python scraper's queries (which are implemented
 * separately but follow the same schema).
 *
 * Usage:
 *   import { getConnection, getActiveDiscordWebhooks, ... } from "@tg-discord/db";
 */

// Connection management
export {
  getConnection,
  closeConnection,
  nowUtc,
  type Database
} from "./connection.js";

// Telegram channel queries
export {
  getTelegramChannelByUrl,
  getTelegramChannelByTelegramId,
  getTelegramChannelById,
  createTelegramChannel,
  getOrCreateTelegramChannelRecord,
  updateTelegramChannelInfo,
  getActiveSubscribedChannels
} from "./queries/telegram-channel.js";

// Discord webhook queries
export {
  getActiveDiscordWebhooks,
  getDiscordWebhooksByGroup,
  getWebhooksForTelegramChannel,
  getDiscordWebhook,
  createOrActivateDiscordWebhook,
  deactivateDiscordWebhook,
  deactivateDiscordWebhookById,
  getDiscordWebhookById,
  getGroupedActiveSubscriptions,
  updateWebhookUrlForSubscriptionGroup,
  type GroupedSubscription
} from "./queries/discord-webhook.js";

// Discord channel info queries
export {
  getDiscordChannelInfo,
  getDiscordChannelInfoById,
  getOrCreateDiscordChannelInfo,
  type DiscordChannelInfo
} from "./queries/discord-channel-info.js";

// Telegram message and forward tracking queries
export {
  getTgMsgByExtId,
  createTgMsg,
  getOrCreateTgMsg,
  getForwardRecordsForMessage,
  getPendingForwardRecords,
  createPendingForwardRecord,
  getForwardRecordByMsgAndWebhook,
  markForwardSuccess,
  markForwardError,
  getWebhooksMissingMessage,
  getPendingForwardsWithDetails
} from "./queries/tg-msgs.js";

// Configuration and cursor queries
export {
  getGeneralConfig,
  updateGeneralConfig,
  ensureConfigExists,
  getMsgCursor,
  updateMsgCursor,
  getAllCursorsWithChannelInfo
} from "./queries/config-cursor.js";

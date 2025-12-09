/**
 * Shared Types Package
 *
 * Contains Zod schemas and TypeScript types for all API contracts in the project.
 * These schemas are used for both runtime validation and compile-time type safety.
 *
 * By centralizing type definitions, we ensure consistency between:
 * - Express server request/response handling
 * - Discord bot command responses
 * - Python scraper message formats
 */

import { z } from "zod";

// ============================================================================
// Configuration API Types (POST /config)
// ============================================================================

/**
 * Schema for discord channel info in configuration requests.
 * Used to store Discord channel metadata to avoid repeated API calls.
 */
export const DiscordChannelInfoSchema = z.object({
  channel_id: z.string().min(1, "channel_id is required"),
  server_id: z.string().min(1, "server_id is required"),
  channel_name: z.string().min(1, "channel_name is required"),
  server_name: z.string().min(1, "server_name is required")
});

export type DiscordChannelInfoInput = z.infer<typeof DiscordChannelInfoSchema>;

/**
 * Schema for the discord_setup portion of configuration requests.
 * Manages webhook subscriptions to telegram channels.
 */
export const DiscordSetupSchema = z.object({
  subscription_group_id: z
    .string()
    .min(1, "subscription_group_id is required")
    .regex(
      /^[a-zA-Z0-9]+$/,
      "subscription_group_id must contain only letters and numbers (no spaces, dashes, or special characters)"
    )
    .transform((val) => val.toLowerCase()),
  description: z
    .string()
    .optional(),
  discord_webhook_url: z
    .string()
    .url("discord_webhook_url must be a valid URL")
    .refine(
      (url) => url.includes("discord.com/api/webhooks/"),
      "discord_webhook_url must be a valid Discord webhook URL"
    ),
  discord_channel_info: DiscordChannelInfoSchema.optional(),
  add_telegram_subscribed_channels: z
    .array(z.object({
      url: z.string().url("Each telegram URL must be a valid URL"),
      username: z.string().min(1, "channel_name is required")
    }))
    .optional(),
  remove_telegram_unsubscribed_channels: z
    .array(z.string().url("Each telegram URL must be a valid URL"))
    .optional()
}).refine(
  (data) => {
    const hasAdd = data.add_telegram_subscribed_channels && data.add_telegram_subscribed_channels.length > 0;
    const hasRemove = data.remove_telegram_unsubscribed_channels && data.remove_telegram_unsubscribed_channels.length > 0;
    return hasAdd || hasRemove;
  },
  {
    message: "At least one of add_telegram_subscribed_channels or remove_telegram_unsubscribed_channels must be provided and non-empty"
  }
).refine(
  (data) => {
    const addSet = new Set(data.add_telegram_subscribed_channels || []);
    const removeSet = new Set(data.remove_telegram_unsubscribed_channels || []);
    for (const url of addSet) {
      if (removeSet.has(url.url)) {
        return false;
      }
    }
    return true;
  },
  {
    message: "The same URL cannot appear in both add_telegram_subscribed_channels and remove_telegram_unsubscribed_channels"
  }
);

export type DiscordSetup = z.infer<typeof DiscordSetupSchema>;

/**
 * Schema for the full configuration POST request body.
 */
export const ConfigPostRequestSchema = z.object({
  cron: z
    .string()
    .regex(/^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/, "Invalid cron expression format")
    .optional(),
  discord_setup: DiscordSetupSchema.optional()
});

export type ConfigPostRequest = z.infer<typeof ConfigPostRequestSchema>;

/**
 * Schema for configuration POST response - discriminated union for ok/error.
 */
export const ConfigPostResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true)
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.number(),
      message: z.string()
    })
  })
]);

export type ConfigPostResponse = z.infer<typeof ConfigPostResponseSchema>;

// ============================================================================
// Configuration GET Response Types
// ============================================================================

/**
 * Schema for a subscription group in the GET /config response.
 */
export const SubscriptionGroupSchema = z.object({
  subscription_group_id: z.string(),
  discord_webhook_url: z.string(),
  telegram_channels: z.array(z.string()),
  discord_channel_id: z.string().nullable(),
  discord_server_id: z.string().nullable(),
  discord_channel_name: z.string().nullable(),
  discord_server_name: z.string().nullable()
});

export type SubscriptionGroup = z.infer<typeof SubscriptionGroupSchema>;

/**
 * Schema for the full GET /config response.
 */
export const ConfigGetResponseSchema = z.object({
  cron: z.string(),
  subscriptions: z.array(SubscriptionGroupSchema)
});

export type ConfigGetResponse = z.infer<typeof ConfigGetResponseSchema>;

// ============================================================================
// Message Processing API Types (POST /process)
// ============================================================================

/**
 * Schema for a single telegram message in the processing request.
 * This matches the format sent by the Python scraper.
 */
export const TelegramMessageSchema = z.object({
  id: z.number(),
  date: z.string(),
  message: z.string().nullable(),
  views: z.number().nullable().optional(),
  forwards: z.number().nullable().optional(),
  edit_date: z.string().nullable().optional(),
  post_author: z.string().nullable().optional(),
  media: z.unknown().nullable().optional(),
  entities: z.array(z.unknown()).nullable().optional(),
  reply_to: z.unknown().nullable().optional()
}).passthrough();

export type TelegramMessage = z.infer<typeof TelegramMessageSchema>;

/**
 * Schema for the message processing POST request body.
 * This is what the Python scraper sends to the Express server.
 */
export const ProcessMessageRequestSchema = z.object({
  channelId: z.number(),
  channelUsername: z.string(),
  channelUrl: z.string(),
  messages: z.array(TelegramMessageSchema).min(1, "At least one message is required")
});

export type ProcessMessageRequest = z.infer<typeof ProcessMessageRequestSchema>;

/**
 * Schema for the message processing response.
 */
export const ProcessMessageResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    processed: z.number(),
    pending: z.number()
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.number(),
      message: z.string()
    })
  })
]);

export type ProcessMessageResponse = z.infer<typeof ProcessMessageResponseSchema>;

// ============================================================================
// Logging API Types (POST /log)
// ============================================================================

/**
 * Valid log levels for the logging API.
 */
export const LogTypeSchema = z.enum([ "info", "warning", "error", "debug" ]);
export type LogType = z.infer<typeof LogTypeSchema>;

/**
 * Schema for log POST request body.
 */
export const LogPostRequestSchema = z.object({
  logType: LogTypeSchema,
  message: z.string().min(1, "Log message is required"),
  timestamp: z.string().datetime("Timestamp must be ISO 8601 format"),
  details: z.record(z.unknown()).optional()
});

export type LogPostRequest = z.infer<typeof LogPostRequestSchema>;

/**
 * Schema for log POST response.
 */
export const LogPostResponseSchema = z.object({
  received: z.literal(true)
});

export type LogPostResponse = z.infer<typeof LogPostResponseSchema>;

// ============================================================================
// Database Entity Types
// ============================================================================

/**
 * Schema for telegram_channel table records.
 */
export const TelegramChannelSchema = z.object({
  id: z.number(),
  telegram_id: z.number().nullable(),
  telegram_url: z.string(),
  telegram_username: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string()
});

export type TelegramChannel = z.infer<typeof TelegramChannelSchema>;

/**
 * Schema for discord_webhook table records.
 */
export const DiscordWebhookSchema = z.object({
  id: z.number(),
  subscription_group_id: z.string(),
  description: z.string().nullable(),
  discord_webhook_url: z.string(),
  telegram_channel_id: z.number(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string()
});

export type DiscordWebhook = z.infer<typeof DiscordWebhookSchema>;

/**
 * Schema for tg_msgs table records.
 */
export const TgMsgSchema = z.object({
  id: z.number(),
  tg_ext_id: z.number(),
  telegram_channel_id: z.number(),
  data: z.string(),
  created_at: z.string(),
  updated_at: z.string()
});

export type TgMsg = z.infer<typeof TgMsgSchema>;

/**
 * Forwarding status enum values.
 */
export const ForwardStatusSchema = z.enum([ "pending", "error", "success" ]);
export type ForwardStatus = z.infer<typeof ForwardStatusSchema>;

/**
 * Schema for join_tg_msgs_forwarded_to_discord table records.
 */
export const TgMsgForwardedSchema = z.object({
  id: z.number(),
  tg_msgs_id: z.number(),
  tg_ext_msg_id: z.number(),
  discord_webhook_id: z.number(),
  status: ForwardStatusSchema,
  error: z.string().nullable(),
  created_at: z.string()
});

export type TgMsgForwarded = z.infer<typeof TgMsgForwardedSchema>;

/**
 * Schema for general_config table record.
 */
export const GeneralConfigSchema = z.object({
  id: z.number(),
  cron: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string()
});

export type GeneralConfig = z.infer<typeof GeneralConfigSchema>;

/**
 * Schema for msg_cursor table records.
 */
export const MsgCursorSchema = z.object({
  id: z.number(),
  telegram_channel_id: z.number(),
  last_seen_msg_id: z.number(),
  last_seen_msg_time: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string()
});

export type MsgCursor = z.infer<typeof MsgCursorSchema>;

// ============================================================================
// Discord Webhook Message Format
// ============================================================================

/**
 * Schema for Discord webhook message payload.
 * This is what we send to Discord webhook URLs.
 */
export const DiscordWebhookMessageSchema = z.object({
  content: z.string().max(2000).optional(),
  username: z.string().max(80).optional(),
  avatar_url: z.string().url().optional(),
  embeds: z.array(z.object({
    title: z.string().max(256).optional(),
    description: z.string().max(4096).optional(),
    url: z.string().url().optional(),
    timestamp: z.string().optional(),
    color: z.number().optional(),
    footer: z.object({
      text: z.string().max(2048),
      icon_url: z.string().url().optional()
    }).optional(),
    author: z.object({
      name: z.string().max(256),
      url: z.string().url().optional(),
      icon_url: z.string().url().optional()
    }).optional(),
    fields: z.array(z.object({
      name: z.string().max(256),
      value: z.string().max(1024),
      inline: z.boolean().optional()
    })).max(25).optional()
  })).max(10).optional()
});

export type DiscordWebhookMessage = z.infer<typeof DiscordWebhookMessageSchema>;

// ============================================================================
// Pending Forward Details (for message processing)
// ============================================================================

/**
 * Schema for pending forward records with all joined data.
 * Used by getPendingForwardsWithDetails query result.
 */
export const PendingForwardDetailsSchema = z.object({
  forwardId: z.number(),
  tgMsgsId: z.number(),
  tgExtMsgId: z.number(),
  telegramChannelId: z.number(),
  telegramChannelUsername: z.string().nullable(),
  telegramChannelUrl: z.string(),
  messageData: z.string(),
  discordWebhookId: z.number(),
  discordWebhookUrl: z.string(),
  subscriptionGroupId: z.string(),
  discordChannelId: z.string(),
  discordServerId: z.string(),
  discordChannelName: z.string(),
  discordServerName: z.string()
});

export type PendingForwardDetails = z.infer<typeof PendingForwardDetailsSchema>;

export const PendingForwardDetailsSchemaArray = z.array(PendingForwardDetailsSchema);
// Re-export zod for convenience
export { z } from "zod";

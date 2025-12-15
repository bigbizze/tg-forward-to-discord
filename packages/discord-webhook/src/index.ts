/**
 * Discord Webhook Package
 *
 * Provides utilities for posting messages to Discord webhooks with proper
 * rate limiting to avoid hitting Discord's API limits.
 *
 * Discord webhook rate limits (approximate):
 * - 30 requests per minute per webhook
 * - 5 requests per 2 seconds per webhook
 *
 * This package uses the 'limiter' npm package to enforce these limits.
 */

import * as limiter from "limiter";
type RateLimiter = limiter.RateLimiter;
import retry from "async-retry";
import {
  type Result,
  ok,
  err,
  type AppError,
  appErrorFromException,
  ErrorCodes
} from "@tg-discord/result";
import type { DiscordWebhookMessage, TelegramMessage } from "@tg-discord/shared-types";


export const lineSeparator = "-# ~~---------------------~~";


/**
 * Rate limiter instances per webhook URL.
 * Each webhook has its own limiter to handle limits correctly.
 */
const rateLimiters = new Map<string, RateLimiter>();

let limiterPackage: typeof import("limiter") | null = null;
/**
 * Gets or creates a rate limiter for a specific webhook URL.
 * Configured conservatively at 25 requests per minute (Discord allows ~30).
 */
async function getRateLimiter(webhookUrl: string): Promise<RateLimiter> {
  if (limiterPackage === null) {
    limiterPackage = await import("limiter");
  }
  const Limiter = limiterPackage.RateLimiter;
  let limiter = rateLimiters.get(webhookUrl);

  if (!limiter) {
    // Conservative limit: 25 per minute (Discord allows ~30)
    // This gives us headroom for retries and other operations
    limiter = new Limiter({
      tokensPerInterval: 25,
      interval: "minute"
    });
    rateLimiters.set(webhookUrl, limiter);
  }

  return limiter;
}

/**
 * Fetches webhook information from Discord API.
 * Returns the channel ID associated with the webhook.
 */
export async function getWebhookChannelAndServerId(webhookUrl: string): Promise<{
  channelId: `${number}`;
  serverId: `${number}`;
} | null> {
  try {
    // Webhook URL format: https://discord.com/api/webhooks/{webhook.id}/{webhook.token}
    // Can make GET request directly to the webhook URL
    const response = await fetch(webhookUrl);

    if (!response.ok) {
      console.error(`Failed to fetch webhook info: ${response.status}`);
      return null;
    }

    const webhook = await response.json() as {
      channel_id?: string;
      guild_id?: string;
    };
    if (!webhook || !webhook.channel_id || !webhook.guild_id) {
      console.error("Invalid webhook info received");
      return null;
    }
    try {
      if (typeof BigInt(webhook.channel_id) !== "bigint") {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error("channel_id is not a valid bigint");
      } else if (typeof BigInt(webhook.guild_id) !== "bigint") {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error("guild_id is not a valid bigint");
      }
    } catch {
      console.error("Invalid channel_id format:", webhook.channel_id);
      return null;
    }

    return {
      channelId: webhook.channel_id as `${number}`,
      serverId: webhook.guild_id as `${number}`
    };
  } catch (error) {
    console.error("Error fetching webhook info:", error);
    return null;
  }
}


/**
 * Custom error class for webhook errors that includes the HTTP status code.
 */
export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

/**
 * Posts a message to a Discord webhook with rate limiting and retry logic.
 *
 * @param webhookUrl - The Discord webhook URL
 * @param message - The message payload to send
 * @returns Result indicating success or error (error includes status code for 4xx errors)
 */
export async function postToDiscordWebhook(
  webhookUrl: string,
  message: DiscordWebhookMessage
): Promise<Result<void, AppError>> {
  const limiter = await getRateLimiter(webhookUrl);

  // Wait for rate limiter token
  await limiter.removeTokens(1);

  try {
    // Use async-retry for automatic retries with exponential backoff
    await retry(
      async (bail, attemptNumber) => {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(message)
        });

        // Handle rate limiting
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;

          // Wait before retry (async-retry will handle this)
          await new Promise(resolve => setTimeout(resolve, waitMs));
          throw new Error(`Rate limited, retry after ${waitMs}ms`);
        }

        // Handle permanent errors (don't retry these)
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          const errorText = await response.text();
          // bail() prevents further retries - use WebhookError to preserve status
          bail(new WebhookError(`Discord webhook error ${response.status}: ${errorText}`, response.status));
          return;
        }

        // Handle other errors
        if (!response.ok) {
          const errorText = await response.text();
          throw new WebhookError(`Discord webhook error ${response.status}: ${errorText}`, response.status);
        }
      },
      {
        retries: 2,           // Retry up to 2 times (3 total attempts)
        minTimeout: 1000,     // First retry after 1 second
        maxTimeout: 2000,     // Second retry after 2 seconds
        factor: 2,
        // Double the timeout each retry
        onRetry: (error, attempt) => {
          console.log(`Discord webhook retry attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    return ok(undefined);
  } catch (error) {
    const appError = appErrorFromException(
      error,
      ErrorCodes.DISCORD_WEBHOOK_ERROR,
      "Failed to post to Discord webhook after retries"
    );
    // Preserve the HTTP status code in details if it's a WebhookError
    if (error instanceof WebhookError) {
      appError.details = { ...appError.details, httpStatus: error.status };
    }
    return err(appError);
  }
}

/**
 * Formats a Telegram message for Discord display.
 * Creates a nice embed with the message content.
 *
 * @param telegramMessage - The raw Telegram message data
 * @param channelInfo - Information about the source channel
 * @returns Formatted Discord webhook message
 */
export function formatTelegramMessageForDiscord(
  telegramMessage: TelegramMessage,
  channelInfo: {
    discordChannelId: string,
    channelId: number,
    channelUsername: string;
    channelUrl: string;
  }
): DiscordWebhookMessage {
  const timestamp = new Date(telegramMessage.date).toISOString();
  const content = telegramMessage.message || "(No text content)";

  // Truncate content if too long (Discord limit is 4096 for embed description)
  const truncatedContent = content.length > 4000
    ? content.substring(0, 4000) + "..."
    : content;

  // Build the embed
  const embed: NonNullable<DiscordWebhookMessage["embeds"]>[0] = {
    description: truncatedContent,
    timestamp,
    color: 0x0088cc // Telegram blue
  };

  if (telegramMessage.views !== null && telegramMessage.views !== undefined) {
    embed.color = 3066993;
    embed.fields = [
      {
        name: "",
        value: `
${lineSeparator}
`,
        inline: false
      },
      {
        name: "",
        value: `-# [Msg](https://t.me/${channelInfo.channelUsername}/${telegramMessage.id}) | [Channel](${channelInfo.channelUrl})`,
        inline: false
      }
    ];
  }

  return {
    username: `From "${channelInfo.channelUsername}"`,
    embeds: [ embed ]
  };
}

/**
 * Posts a Telegram message to a Discord webhook, formatting it nicely.
 * Combines formatting and posting in one convenient function.
 */
export async function forwardTelegramMessageToDiscord(
  webhookUrl: string,
  telegramMessage: TelegramMessage,
  channelInfo: {
    discordChannelId: string;
    channelUsername: string;
    channelUrl: string;
    channelId: number;
  }
): Promise<Result<void, AppError>> {
  const formattedMessage = formatTelegramMessageForDiscord(
    telegramMessage,
    channelInfo
  );

  return postToDiscordWebhook(webhookUrl, formattedMessage);
}

/**
 * Posts an error notification to a Discord webhook.
 * Used for the logging webhook channel.
 *
 * @param webhookUrl - The Discord webhook URL
 * @param error - The error to report
 * @param context - Optional additional context
 */
export async function postErrorToDiscord(
  webhookUrl: string,
  error: AppError,
  context?: string
): Promise<Result<void, AppError>> {
  const embed: NonNullable<DiscordWebhookMessage["embeds"]>[0] = {
    title: "🚨 Error Report",
    description: error.message,
    color: 0xff0000, // Red
    timestamp: error.timestamp,
    fields: [
      {
        name: "Error Code",
        value: error.code,
        inline: true
      }
    ]
  };

  if (context) {
    embed.fields?.push({
      name: "Context",
      value: context,
      inline: true
    });
  }

  if (error.stackTrace) {
    // Truncate stack trace if too long
    const truncatedStack = error.stackTrace.length > 1000
      ? error.stackTrace.substring(0, 1000) + "..."
      : error.stackTrace;

    embed.fields?.push({
      name: "Stack Trace",
      value: `\`\`\`\n${truncatedStack}\n\`\`\``,
      inline: false
    });
  }

  if (error.details) {
    embed.fields?.push({
      name: "Details",
      value: `\`\`\`json\n${JSON.stringify(error.details, null, 2)}\n\`\`\``,
      inline: false
    });
  }

  return postToDiscordWebhook(webhookUrl, { embeds: [ embed ] });
}

/**
 * Posts an info/log message to a Discord webhook.
 * Used for the logging webhook channel.
 */
export async function postLogToDiscord(
  webhookUrl: string,
  logType: "info" | "warning" | "error" | "debug",
  message: string,
  details?: Record<string, unknown>
): Promise<Result<void, AppError>> {
  const colors = {
    info: 0x0099ff,    // Blue
    warning: 0xffcc00, // Yellow
    error: 0xff0000,   // Red
    debug: 0x808080    // Gray
  };

  const icons = {
    info: "ℹ️",
    warning: "⚠️",
    error: "🚨",
    debug: "🔍"
  };

  const embed: NonNullable<DiscordWebhookMessage["embeds"]>[0] = {
    title: `${icons[logType]} ${logType.toUpperCase()}`,
    description: message,
    color: colors[logType],
    timestamp: new Date().toISOString()
  };

  if (details) {
    embed.fields = [
      {
        name: "Details",
        value: `\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``,
        inline: false
      }
    ];
  }

  return postToDiscordWebhook(webhookUrl, { embeds: [ embed ] });
}

/**
 * Clears rate limiter cache.
 * Useful for testing or when webhooks are removed.
 */
export function clearRateLimiters(): void {
  rateLimiters.clear();
}

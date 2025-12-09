/**
 * Process Route Handler
 *
 * Handles POST requests to /${PROCESSOR_SERVER_POST_MSG_PATH}
 *
 * This is the core message processing endpoint. It:
 * 1. Receives batches of Telegram messages from the Python scraper
 * 2. Stores each message in tg_msgs table
 * 3. Determines which Discord webhooks should receive each message
 * 4. Creates pending forward records for messages not yet forwarded
 * 5. Processes pending forwards with retry logic
 * 6. Updates forward status to success/error based on results
 */

import { Router, type Request, type Response } from "express";
import retry from "async-retry";
import {
  type PendingForwardDetails,
  PendingForwardDetailsSchema,
  ProcessMessageRequestSchema,
  type ProcessMessageResponse,
  type TelegramMessage,
  TelegramMessageSchema
} from "@tg-discord/shared-types";
import {
  getOrCreateTelegramChannelRecord,
  updateTelegramChannelInfo,
  getOrCreateTgMsg,
  getWebhooksMissingMessage,
  createPendingForwardRecord,
  getPendingForwardsWithDetails,
  markForwardSuccess,
  markForwardError,
  getDiscordWebhookById,
  updateMsgCursor
} from "@tg-discord/db";
import { getConfig, getLogUrl } from "@tg-discord/config";
import { postToDiscordWebhook, formatTelegramMessageForDiscord } from "@tg-discord/discord-webhook";
import type { AppError } from "@tg-discord/result";

/**
 * Sends an error log to the logging endpoint.
 * Fire-and-forget - doesn't wait for response.
 */
async function sendErrorLog(
  error: AppError | Error,
  context: string,
  details?: Record<string, unknown>
): Promise<void> {
  const body = JSON.stringify({
    logType: "error",
    message: error instanceof Error ? error.message : error.message,
    timestamp: new Date().toISOString(),
    details: {
      context,
      errorCode: "code" in error ? error.code : "UNKNOWN",
      ...details
    }
  }, null, 2);
  console.error("(process.ts sendErrorLog) Error: ", body);
  const config = getConfig();
  const logUrl = getLogUrl(config);

  try {
    await fetch(logUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.PROCESSOR_SERVER_TOKEN}`
      },
      body: body
    });
  } catch (logError) {
    // Don't let logging errors break the main flow
    console.error("Failed to send error log:", logError);
  }
}

/**
 * Processes a single pending forward record.
 * Attempts to send the message to Discord with retry logic.
 *
 * @returns true if successful, false if failed after all retries
 */
async function processPendingForward(
  forward: PendingForwardDetails
): Promise<boolean> {

  const {
    success, error
  } = PendingForwardDetailsSchema.safeParse(forward);
  if (!success) {
    const errorMsg = `Failed to parse forward: ${error?.issues.join("\n")} - ${JSON.stringify(forward)}`;
    // If we can't parse the message, mark as error immediately
    markForwardError(forward.forwardId, errorMsg);
    await sendErrorLog(
      error,
      `processPendingForward\n\n${errorMsg}}`,
      { forwardId: forward.forwardId, tgExtMsgId: forward.tgExtMsgId }
    );
  }
  // Parse the stored message data
  let telegramMessage: TelegramMessage;
  try {
    telegramMessage = TelegramMessageSchema.parse(JSON.parse(forward.messageData));
  } catch (parseError) {
    // If we can't parse the message, mark as error immediately
    markForwardError(forward.forwardId, `Failed to parse message data: ${parseError}`);
    await sendErrorLog(
      parseError instanceof Error ? parseError : new Error(String(parseError)),
      "processPendingForward:parse",
      { forwardId: forward.forwardId, tgExtMsgId: forward.tgExtMsgId }
    );
    return false;
  }

  // Get webhook details for channel info
  const webhookResult = getDiscordWebhookById(forward.discordWebhookId);
  if (!webhookResult.ok || !webhookResult.value) {
    const errorMsg = webhookResult.ok ? "Webhook not found" : webhookResult.error.message;
    markForwardError(forward.forwardId, errorMsg);
    await sendErrorLog(
      new Error(errorMsg),
      "processPendingForward:webhookLookup",
      { forwardId: forward.forwardId, discordWebhookId: forward.discordWebhookId }
    );
    return false;
  }

  // Format the message for Discord
  // We need to extract channel info - for now use what we have
  // const channelUsername = telegramMessage.post_author || "telegram";
  // const channelUrl = `https://t.me/c/${forward.telegramChannelId}`;

  const discordMessage = formatTelegramMessageForDiscord(telegramMessage, {
    channelUsername: forward.telegramChannelUsername || telegramMessage.post_author || "telegram",
    discordChannelId: forward.discordChannelId,
    channelUrl: forward.telegramChannelUrl || `https://t.me/c/${forward.telegramChannelId}`,
    channelId: forward.telegramChannelId
  });

  try {
    // Use async-retry with specific retry configuration:
    // - 2 retries (3 total attempts)
    // - First retry after 1 second
    // - Second retry after 2 seconds
    await retry(
      async (bail, attemptNumber) => {
        console.log(`Attempting to forward message ${forward.tgExtMsgId} to webhook (attempt ${attemptNumber})`);

        const result = await postToDiscordWebhook(forward.discordWebhookUrl, discordMessage);

        if (!result.ok) {
          // Check if this is a permanent error (4xx except 429)
          if (result.error.code === "DISCORD_WEBHOOK_ERROR" &&
              result.error.details?.status &&
              typeof result.error.details.status === "number" &&
              result.error.details.status >= 400 &&
              result.error.details.status < 500 &&
              result.error.details.status !== 429) {
            // Permanent error - don't retry
            bail(new Error(result.error.message));
            return;
          }

          // Transient error - throw to trigger retry
          throw new Error(result.error.message);
        }
      },
      {
        retries: 2,
        minTimeout: 1000,  // First retry after 1 second
        maxTimeout: 2000,  // Second retry after 2 seconds
        factor: 2,
        onRetry: (error, attempt) => {
          console.log(`Retry ${attempt} for message ${forward.tgExtMsgId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    );

    // Success! Mark the forward record
    const successResult = markForwardSuccess(forward.forwardId);
    if (!successResult.ok) {
      // This is a DB inconsistency - message sent but not tracked
      console.error(`Failed to mark forward ${forward.forwardId} as success:`, successResult.error);
      await sendErrorLog(
        successResult.error,
        "processPendingForward:markSuccess",
        { forwardId: forward.forwardId, tgExtMsgId: forward.tgExtMsgId }
      );
    }

    console.log(`Successfully forwarded message ${forward.tgExtMsgId} to ${forward.subscriptionGroupId}`);
    return true;

  } catch (error) {
    // All retries failed - mark as error
    const errorMessage = error instanceof Error ? error.message : String(error);

    const errorResult = markForwardError(forward.forwardId, errorMessage);
    if (!errorResult.ok) {
      // DB inconsistency - forward failed but we can't track it
      console.error(`Failed to mark forward ${forward.forwardId} as error:`, errorResult.error);
      await sendErrorLog(
        errorResult.error,
        "processPendingForward:markError",
        { forwardId: forward.forwardId, tgExtMsgId: forward.tgExtMsgId, originalError: errorMessage }
      );
    }

    // Send error log
    await sendErrorLog(
      error instanceof Error ? error : new Error(errorMessage),
      "processPendingForward:send",
      {
        forwardId: forward.forwardId,
        tgExtMsgId: forward.tgExtMsgId,
        webhookId: forward.discordWebhookId,
        subscriptionGroupId: forward.subscriptionGroupId
      }
    );

    console.error(`Failed to forward message ${forward.tgExtMsgId} after all retries:`, errorMessage);
    return false;
  }
}

/**
 * Creates the process router.
 */
export function createProcessRouter(): Router {
  const router = Router();

  // POST /process - Process incoming Telegram messages
  router.post("/", async (req: Request, res: Response) => {
    try {
      // Validate request body
      const parseResult = ProcessMessageRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        const errors = parseResult.error.issues
          .map(issue => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");

        const response: ProcessMessageResponse = {
          ok: false,
          error: {
            code: 400,
            message: `Validation error: ${errors}`
          }
        };
        res.status(400).json(response);
        return;
      }

      const { channelId, channelUsername, channelUrl, messages } = parseResult.data;

      console.log(`Processing ${messages.length} messages from ${channelUsername} (${channelId})`);

      // Step 1: Get or create the telegram channel record
      const channelResult = getOrCreateTelegramChannelRecord(channelUrl, channelUsername);
      if (!channelResult.ok) {
        const response: ProcessMessageResponse = {
          ok: false,
          error: {
            code: 500,
            message: `Failed to get/create channel: ${channelResult.error.message}`
          }
        };
        res.status(500).json(response);
        return;
      }

      const channel = channelResult.value;

      // Update channel info if we have more details now
      if (channel.telegram_id !== channelId || channel.telegram_username !== channelUsername) {
        const updateResult = updateTelegramChannelInfo(channel.id, channelId, channelUsername);
        if (!updateResult.ok) {
          // Non-critical - channel will still work, but metadata may be stale
          console.warn(`Failed to update channel info: ${updateResult.error.message}`);
          await sendErrorLog(
            updateResult.error,
            "POST /process:updateChannelInfo",
            { channelDbId: channel.id, newTelegramId: channelId, newUsername: channelUsername }
          );
        }
      }

      // Step 2: Process each message - store and create pending forwards
      let pendingCount = 0;
      let maxMsgId = 0;
      let maxMsgTime: string | null = null;

      for (const message of messages) {
        // Track the highest message ID for cursor update
        if (message.id > maxMsgId) {
          maxMsgId = message.id;
          maxMsgTime = message.date;
        }

        // Store the message in tg_msgs
        const msgResult = getOrCreateTgMsg(
          message.id,
          channel.id,
          JSON.stringify(message)
        );

        if (!msgResult.ok) {
          console.error(`Failed to store message ${message.id}:`, msgResult.error);
          await sendErrorLog(
            msgResult.error,
            "POST /process:storeTgMsg",
            { messageId: message.id, channelId: channel.id }
          );
          continue;
        }

        const { msg, created } = msgResult.value;

        // Find webhooks that should receive this message but haven't yet
        const missingWebhooksResult = getWebhooksMissingMessage(message.id, channel.id);
        if (!missingWebhooksResult.ok) {
          console.error(`Failed to find missing webhooks for message ${message.id}:`, missingWebhooksResult.error);
          await sendErrorLog(
            missingWebhooksResult.error,
            "POST /process:getMissingWebhooks",
            { messageId: message.id, channelId: channel.id }
          );
          continue;
        }

        const missingWebhookIds = missingWebhooksResult.value;

        if (missingWebhookIds.length === 0) {
          // All active webhooks have already received this message (or will via pending records)
          if (!created) {
            console.log(`Message ${message.id} already processed for all webhooks`);
          }
          continue;
        }

        // Create pending forward records for each webhook that needs this message
        for (const webhookId of missingWebhookIds) {
          const forwardResult = createPendingForwardRecord(msg.id, message.id, webhookId);
          if (!forwardResult.ok) {
            console.error(`Failed to create pending forward for message ${message.id} -> webhook ${webhookId}:`, forwardResult.error);
            await sendErrorLog(
              forwardResult.error,
              "POST /process:createPendingForward",
              { messageId: message.id, tgMsgsId: msg.id, webhookId }
            );
            continue;
          }
          pendingCount++;
        }

        console.log(`Created ${missingWebhookIds.length} pending forwards for message ${message.id}`);
      }

      // Step 3: Update the message cursor
      if (maxMsgId > 0) {
        const cursorResult = updateMsgCursor(channel.id, maxMsgId, maxMsgTime);
        if (!cursorResult.ok) {
          // Non-critical - may cause duplicate processing on next poll but won't lose messages
          console.warn(`Failed to update cursor: ${cursorResult.error.message}`);
          await sendErrorLog(
            cursorResult.error,
            "POST /process:updateCursor",
            { channelDbId: channel.id, maxMsgId, maxMsgTime }
          );
        }
      }

      // Step 4: Process pending forwards
      // Get all pending forwards (not just the ones we created - handle any backlog)
      const pendingResult = getPendingForwardsWithDetails(100); // Process up to 100 at a time
      if (!pendingResult.ok) {
        console.error("Failed to get pending forwards:", pendingResult.error);
        await sendErrorLog(
          pendingResult.error,
          "POST /process:getPendingForwards",
          { channelId: channel.id, messagesReceived: messages.length, pendingCreated: pendingCount }
        );
        // Messages were stored but we couldn't process forwards - this is a partial failure
        const response: ProcessMessageResponse = {
          ok: false,
          error: {
            code: 500,
            message: `Messages stored but failed to process forwards: ${pendingResult.error.message}`
          }
        };
        res.status(500).json(response);
        return;
      }

      const pendingForwards = pendingResult.value;
      console.log(`Processing ${pendingForwards.length} pending forwards`);

      let successCount = 0;
      let errorCount = 0;

      // Process forwards sequentially to respect rate limits
      for (const forward of pendingForwards) {
        const success = await processPendingForward(forward);
        if (success) {
          successCount++;
        } else {
          errorCount++;
        }
      }

      console.log(`Forward results: ${successCount} success, ${errorCount} errors`);

      const response: ProcessMessageResponse = {
        ok: true,
        processed: messages.length,
        pending: pendingForwards.length - successCount - errorCount
      };
      res.json(response);

    } catch (error) {
      console.error("Error in POST /process:", error);

      // Send error log
      await sendErrorLog(
        error instanceof Error ? error : new Error(String(error)),
        "POST /process",
        { body: req.body }
      );

      const response: ProcessMessageResponse = {
        ok: false,
        error: {
          code: 500,
          message: error instanceof Error ? error.message : "Internal server error"
        }
      };
      res.status(500).json(response);
    }
  });

  return router;
}
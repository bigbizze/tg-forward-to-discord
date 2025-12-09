/**
 * Configuration Route Handler
 *
 * Handles GET and POST requests to /${PROCESSOR_SERVER_CONFIG_PATH}
 *
 * GET: Returns current configuration and all active subscriptions
 * POST: Updates configuration and manages Discord webhook subscriptions
 */

import { Router, type Request, type Response } from "express";
import { ConfigPostRequestSchema, type ConfigPostResponse, type ConfigGetResponse } from "@tg-discord/shared-types";
import {
  getGeneralConfig,
  updateGeneralConfig,
  getGroupedActiveSubscriptions,
  getOrCreateTelegramChannelRecord,
  getTelegramChannelByUrl,
  createOrActivateDiscordWebhook,
  deactivateDiscordWebhook,
  getOrCreateDiscordChannelInfo
} from "@tg-discord/db";
import { getConfig } from "@tg-discord/config";

/**
 * Creates the config router with GET and POST handlers.
 */
export function createConfigRouter(): Router {
  const router = Router();

  // GET /config - Returns current configuration
  router.get("/", async (_req: Request, res: Response) => {
    try {
      // Get general config
      const configResult = getGeneralConfig();
      if (!configResult.ok) {
        const response: ConfigPostResponse = {
          ok: false,
          error: {
            code: 500,
            message: configResult.error.message
          }
        };
        res.status(500).json(response);
        return;
      }

      // Get grouped subscriptions
      const subsResult = getGroupedActiveSubscriptions();
      if (!subsResult.ok) {
        const response: ConfigPostResponse = {
          ok: false,
          error: {
            code: 500,
            message: subsResult.error.message
          }
        };
        res.status(500).json(response);
        return;
      }

      const appConfig = getConfig();
      const generalConfig = configResult.value;


      const response: ConfigGetResponse = {
        cron: generalConfig?.cron ?? appConfig.DEFAULT_CRON,
        subscriptions: subsResult.value
      };

      res.json(response);
    } catch (error) {
      console.error("Error in GET /config:", error);
      const response: ConfigPostResponse = {
        ok: false,
        error: {
          code: 500,
          message: error instanceof Error ? error.message : "Internal server error"
        }
      };
      res.status(500).json(response);
    }
  });

  // POST /config - Updates configuration
  router.post("/", async (req: Request, res: Response) => {
    try {
      // Validate request body
      const parseResult = ConfigPostRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        const errors = parseResult.error.issues
          .map(issue => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");

        const response: ConfigPostResponse = {
          ok: false,
          error: {
            code: 400,
            message: `Validation error: ${errors}`
          }
        };
        res.status(400).json(response);
        return;
      }

      const body = parseResult.data;

      // Update cron if provided
      if (body.cron) {
        const cronResult = updateGeneralConfig(body.cron);
        if (!cronResult.ok) {
          const response: ConfigPostResponse = {
            ok: false,
            error: {
              code: 500,
              message: `Failed to update cron: ${cronResult.error.message}`
            }
          };
          res.status(500).json(response);
          return;
        }
        console.log(`Updated cron to: ${body.cron}`);
      }

      // Handle discord_setup if provided
      if (body.discord_setup) {
        const setup = body.discord_setup;
        const {
          subscription_group_id,
          description,
          discord_webhook_url,
          discord_channel_info,
          add_telegram_subscribed_channels,
          remove_telegram_unsubscribed_channels
        } = setup;

        // Create or get the discord channel info record if provided
        let discordChannelInfoId: number | null = null;
        if (discord_channel_info) {
          const channelInfoResult = getOrCreateDiscordChannelInfo(
            discord_channel_info.channel_id,
            discord_channel_info.server_id,
            discord_channel_info.channel_name,
            discord_channel_info.server_name
          );
          if (!channelInfoResult.ok) {
            console.error("Failed to create/get discord channel info:", channelInfoResult.error);
            const response: ConfigPostResponse = {
              ok: false,
              error: {
                code: 500,
                message: `Failed to process discord channel info: ${channelInfoResult.error.message}`
              }
            };
            res.status(500).json(response);
            return;
          }
          discordChannelInfoId = channelInfoResult.value.id;
        }

        // Process removals first
        if (remove_telegram_unsubscribed_channels) {
          for (const telegramUrl of remove_telegram_unsubscribed_channels) {
            // Get the telegram channel
            const channelResult = getTelegramChannelByUrl(telegramUrl);
            if (!channelResult.ok) {
              console.error(`Failed to get channel for ${telegramUrl}:`, channelResult.error);
              continue;
            }

            if (!channelResult.value) {
              // Channel doesn't exist, nothing to deactivate
              console.log(`Channel ${telegramUrl} not found, skipping deactivation`);
              continue;
            }

            // Deactivate the webhook subscription
            const deactivateResult = deactivateDiscordWebhook(
              subscription_group_id,
              channelResult.value.id
            );

            if (!deactivateResult.ok) {
              console.error(`Failed to deactivate ${telegramUrl}:`, deactivateResult.error);
              continue;
            }

            if (deactivateResult.value) {
              console.log(`Deactivated subscription: ${subscription_group_id} <- ${telegramUrl}`);
            }
          }
        }

        // Process additions
        if (add_telegram_subscribed_channels) {
          for (const {
            url: telegramUrl,
            username: telegramUsername
          } of add_telegram_subscribed_channels) {
            // Get or create the telegram channel record
            const channelResult = getOrCreateTelegramChannelRecord(telegramUrl, telegramUsername);
            if (!channelResult.ok) {
              console.error(`Failed to get/create channel for ${telegramUrl}:`, channelResult.error);

              const response: ConfigPostResponse = {
                ok: false,
                error: {
                  code: 500,
                  message: `Failed to process channel ${telegramUrl}: ${channelResult.error.message}`
                }
              };
              res.status(500).json(response);
              return;
            }

            const channel = channelResult.value;

            // Create or activate the webhook subscription with discord channel info
            const webhookResult = createOrActivateDiscordWebhook(
              subscription_group_id,
              discord_webhook_url,
              channel.id,
              description,
              discordChannelInfoId
            );

            if (!webhookResult.ok) {
              console.error(`Failed to create/activate webhook for ${telegramUrl}:`, webhookResult.error);

              const response: ConfigPostResponse = {
                ok: false,
                error: {
                  code: 500,
                  message: `Failed to create subscription for ${telegramUrl}: ${webhookResult.error.message}`
                }
              };
              res.status(500).json(response);
              return;
            }

            console.log(`Activated subscription: ${subscription_group_id} <- ${telegramUrl}`);
          }
        }
      }

      const response: ConfigPostResponse = { ok: true };
      res.json(response);
    } catch (error) {
      console.error("Error in POST /config:", error);
      const response: ConfigPostResponse = {
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

/**
 * Log Route Handler
 * 
 * Handles POST requests to /${PROCESSOR_SERVER_LOG_PATH}
 * 
 * This is the centralized logging endpoint for all services:
 * - Python scraper
 * - Discord bot
 * - Express server (internal errors)
 * 
 * Logs are forwarded to the configured Discord webhook for visibility.
 */

import { Router, type Request, type Response } from "express";
import { LogPostRequestSchema, type LogPostResponse } from "@tg-discord/shared-types";
import { getConfig } from "@tg-discord/config";
import { postLogToDiscord } from "@tg-discord/discord-webhook";

/**
 * Creates the log router.
 */
export function createLogRouter(): Router {
  const router = Router();
  
  // POST /log - Receive and forward log messages
  router.post("/", async (req: Request, res: Response) => {
    try {
      // Validate request body
      const parseResult = LogPostRequestSchema.safeParse(req.body);
      
      if (!parseResult.success) {
        const errors = parseResult.error.issues
          .map(issue => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        
        res.status(400).json({
          ok: false,
          error: {
            code: 400,
            message: `Validation error: ${errors}`
          }
        });
        return;
      }
      
      const { logType, message, timestamp, details } = parseResult.data;
      
      // Log to console
      const prefix = `[${logType.toUpperCase()}]`;
      console.log(`${prefix} ${timestamp} - ${message}`);
      if (details) {
        console.log(`${prefix} Details:`, JSON.stringify(details, null, 2));
      }
      
      // Forward to Discord webhook if configured
      const config = getConfig();
      if (config.LOGGING_DISCORD_WEBHOOK_URL) {
        const webhookResult = await postLogToDiscord(
          config.LOGGING_DISCORD_WEBHOOK_URL,
          logType,
          message,
          details
        );
        
        if (!webhookResult.ok) {
          // Log the failure but don't fail the request
          console.error("Failed to forward log to Discord:", webhookResult.error.message);
        }
      }
      
      const response: LogPostResponse = { received: true };
      res.json(response);
      
    } catch (error) {
      console.error("Error in POST /log:", error);
      
      // Don't use the logging endpoint recursively - just log to console
      res.status(500).json({
        ok: false,
        error: {
          code: 500,
          message: error instanceof Error ? error.message : "Internal server error"
        }
      });
    }
  });
  
  return router;
}

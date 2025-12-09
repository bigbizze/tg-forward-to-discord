/**
 * Express Server Application
 *
 * This server handles:
 * - POST /process - Receives Telegram messages from the Python scraper
 * - GET /config - Returns current configuration and subscriptions
 * - POST /config - Updates configuration and subscription settings
 * - POST /log - Receives and handles log messages from other services
 *
 * All routes validate request bodies using Zod schemas and authenticate
 * requests using Bearer token authentication.
 */

import "dotenv/config";
import express from "express";
import { getConfig } from "@tg-discord/config";
import { closeConnection } from "@tg-discord/db";
import { createConfigRouter } from "./routes/config.js";
import { createProcessRouter } from "./routes/process.js";
import { createLogRouter } from "./routes/log.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { postErrorToDiscord } from "@tg-discord/discord-webhook";
import { createAppError, ErrorCodes } from "@tg-discord/result";

process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);
  // Log the error (best effort)
  const config = getConfig();
  if (!config.LOGGING_DISCORD_WEBHOOK_URL) {
    return;
  }

  // Fire and forget - don't wait for this
  const logPromise = postErrorToDiscord(
    config.LOGGING_DISCORD_WEBHOOK_URL,
    createAppError(ErrorCodes.INTERNAL_ERROR, error.message, { name: error.name, stack: error.stack })
  ).catch(webhookError => {
    console.error("Failed to send error to Discord webhook:", webhookError);
  });

  // Wait up to 3 seconds for the log to send, then exit regardless
  await Promise.race([
    logPromise,
    new Promise(resolve => setTimeout(resolve, 2000))
  ]);

  // Exit - let PM2/systemd restart us in a clean state
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  // Log it, but we can continue
  const config = getConfig();
  if (config.LOGGING_DISCORD_WEBHOOK_URL) {
    // Fire and forget - don't wait for this
    postErrorToDiscord(
      config.LOGGING_DISCORD_WEBHOOK_URL,
      createAppError(ErrorCodes.INTERNAL_ERROR, typeof reason === "string" ? reason : String(reason))
    ).catch(webhookError => {
      console.error("Failed to send error to Discord webhook:", webhookError);
    });
  }
});


async function main() {
  const config = getConfig();
  const app = express();

  // Parse JSON request bodies
  app.use(express.json({ limit: "10mb" }));

  // Health check endpoint (no auth required)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Apply authentication to all other routes
  app.use(authMiddleware);

  // Mount route handlers
  app.use(`/${config.PROCESSOR_SERVER_CONFIG_PATH}`, createConfigRouter());
  app.use(`/${config.PROCESSOR_SERVER_POST_MSG_PATH}`, createProcessRouter());
  app.use(`/${config.PROCESSOR_SERVER_LOG_PATH}`, createLogRouter());

  // Global error handler
  app.use(errorHandler);

  // Extract port from URL
  const url = new URL(config.PROCESSOR_SERVER_LISTEN_URL);
  const port = parseInt(url.port || "6969", 10);

  // Start server
  const server = app.listen(port, () => {
    console.log(`Express server listening on port ${port}`);
    console.log(`Config endpoint: ${config.PROCESSOR_SERVER_LISTEN_URL}/${config.PROCESSOR_SERVER_CONFIG_PATH}`);
    console.log(`Process endpoint: ${config.PROCESSOR_SERVER_LISTEN_URL}/${config.PROCESSOR_SERVER_POST_MSG_PATH}`);
    console.log(`Log endpoint: ${config.PROCESSOR_SERVER_LISTEN_URL}/${config.PROCESSOR_SERVER_LOG_PATH}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully...`);

    server.close(() => {
      console.log("HTTP server closed");

      // Close database connection
      const dbResult = closeConnection();
      if (!dbResult.ok) {
        console.error("Error closing database:", dbResult.error.message);
      }

      console.log("Shutdown complete");
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      console.error("Could not close connections in time, forcing exit");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

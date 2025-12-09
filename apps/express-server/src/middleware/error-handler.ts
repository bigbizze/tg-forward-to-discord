/**
 * Error Handler Middleware
 * 
 * Catches any unhandled errors in route handlers and returns a consistent
 * error response. Also logs errors to the configured logging webhook if available.
 */

import type { Request, Response, NextFunction } from "express";
import { getConfig } from "@tg-discord/config";
import { postErrorToDiscord } from "@tg-discord/discord-webhook";
import { createAppError, type AppError, ErrorCodes } from "@tg-discord/result";

/**
 * Express error handler middleware.
 * Must have 4 parameters to be recognized as error handler.
 */
export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Convert to AppError if not already
  const appError: AppError = "code" in error && typeof (error as any).code === "string"
    ? error as unknown as AppError
    : createAppError(
      ErrorCodes.INTERNAL_ERROR,
      error.message,
      { 
        path: req.path, 
        method: req.method,
        name: error.name
      }
    );
  
  // Log the error
  console.error(`[ERROR] ${appError.code}: ${appError.message}`);
  if (error.stack) {
    console.error(error.stack);
  }
  
  // Send error to logging webhook if configured
  const config = getConfig();
  if (config.LOGGING_DISCORD_WEBHOOK_URL) {
    // Fire and forget - don't wait for this
    postErrorToDiscord(
      config.LOGGING_DISCORD_WEBHOOK_URL,
      appError,
      `${req.method} ${req.path}`
    ).catch(webhookError => {
      console.error("Failed to send error to Discord webhook:", webhookError);
    });
  }
  
  // Send error response
  res.status(500).json({
    ok: false,
    error: {
      code: 500,
      message: appError.message
    }
  });
}

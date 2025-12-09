/**
 * Configuration Package
 *
 * Provides type-safe access to environment variables using Zod schemas.
 * All configuration is validated at startup, preventing runtime errors
 * from missing or invalid environment variables.
 *
 * Usage:
 *   import { getConfig } from "@tg-discord/config";
 *   const config = getConfig();
 *   console.log(config.SQLITE_PATH);
 */

import { z } from "zod";
import {
  type Result,
  ok,
  err,
  createAppError,
  type AppError,
  ErrorCodes
} from "@tg-discord/result";
import dotenv from "dotenv";
import * as fs from "node:fs";
import path from "node:path";
import { default as appRootPath } from "app-root-path";


/**
 * Schema for all environment variables used in the project.
 * Each variable is documented with its purpose.
 */
export const EnvSchema = z.object({
  // Database
  SQLITE_PATH: z
    .string()
    .min(1, "SQLITE_PATH is required")
    .default("bridge.db"),

  // Telegram API credentials
  API_ID: z
    .string()
    .min(1, "API_ID is required")
    .transform(Number)
    .refine((n) => !isNaN(n) && n > 0, "API_ID must be a positive number"),
  API_HASH: z
    .string()
    .min(1, "API_HASH is required"),

  // Express server configuration
  PROCESSOR_SERVER_LISTEN_URL: z
    .string()
    .url("PROCESSOR_SERVER_LISTEN_URL must be a valid URL")
    .default("http://localhost:6969"),
  PROCESSOR_SERVER_POST_MSG_PATH: z
    .string()
    .min(1)
    .default("process"),
  PROCESSOR_SERVER_CONFIG_PATH: z
    .string()
    .min(1)
    .default("config"),
  PROCESSOR_SERVER_LOG_PATH: z
    .string()
    .min(1)
    .default("log"),
  PROCESSOR_SERVER_TOKEN: z
    .string()
    .min(1, "PROCESSOR_SERVER_TOKEN is required for authentication"),

  // Discord bot configuration
  DISCORD_BOT_TOKEN: z
    .string()
    .min(1, "DISCORD_BOT_TOKEN is required"),
  DISCORD_CLIENT_ID: z
    .string()
    .min(1, "DISCORD_CLIENT_ID is required"),

  // Logging configuration (optional)
  LOGGING_DISCORD_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((val) => val || undefined),

  // Scraper configuration
  DEFAULT_CRON: z
    .string()
    .default("*/10 * * * *")
});

/**
 * TypeScript type inferred from the Zod schema.
 * This ensures our types always match the validation rules.
 */
export type Config = z.infer<typeof EnvSchema>;

/**
 * Cached configuration instance.
 * Validated once at startup, then reused throughout the application.
 */
let cachedConfig: Config | null = null;

/**
 * Validates environment variables and returns a typed configuration object.
 * Returns a Result to handle validation failures gracefully.
 *
 * @param env - Environment variables object (defaults to process.env)
 * @returns Result containing validated config or validation error
 */
export function validateConfig(
  env: Record<string, string | undefined> = process.env
): Result<Config, AppError> {
  const result = EnvSchema.safeParse(env);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");

    return err(createAppError(
      ErrorCodes.CONFIG_ERROR,
      `Configuration validation failed: ${issues}`,
      { issues: result.error.issues }
    ));
  }

  return ok(result.data);
}

/**
 * Gets the validated configuration, using cached instance if available.
 * Throws on first call if validation fails - this is intentional as
 * configuration errors should crash the application at startup.
 *
 * @throws Error if configuration validation fails
 */
export function getConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }
  const env = dotenv.parse(fs.readFileSync(path.resolve(appRootPath.path, ".env"), "utf-8"));

  const result = validateConfig(env);

  if (!result.ok) {
    // Configuration errors are fatal - we want the app to crash at startup
    // rather than continue with invalid configuration
    throw new Error(result.error.message);
  }

  result.value.SQLITE_PATH = path.resolve(appRootPath.path, result.value.SQLITE_PATH);
  cachedConfig = result.value;
  return cachedConfig;
}

/**
 * Clears the cached configuration.
 * Primarily useful for testing.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
}

/**
 * Constructs the full URL for the message processing endpoint.
 */
export function getProcessMessageUrl(config: Config): string {
  const base = config.PROCESSOR_SERVER_LISTEN_URL.replace(/\/$/, "");
  return `${base}/${config.PROCESSOR_SERVER_POST_MSG_PATH}`;
}

/**
 * Constructs the full URL for the configuration endpoint.
 */
export function getConfigUrl(config: Config): string {
  const base = config.PROCESSOR_SERVER_LISTEN_URL.replace(/\/$/, "");
  return `${base}/${config.PROCESSOR_SERVER_CONFIG_PATH}`;
}

/**
 * Constructs the full URL for the logging endpoint.
 */
export function getLogUrl(config: Config): string {
  const base = config.PROCESSOR_SERVER_LISTEN_URL.replace(/\/$/, "");
  return `${base}/${config.PROCESSOR_SERVER_LOG_PATH}`;
}

// Re-export types for convenience
export { z } from "zod";

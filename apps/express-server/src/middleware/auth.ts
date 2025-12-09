/**
 * Authentication Middleware
 * 
 * Validates Bearer token authentication for incoming requests.
 * The token is configured via PROCESSOR_SERVER_TOKEN environment variable.
 */

import type { Request, Response, NextFunction } from "express";
import { getConfig } from "@tg-discord/config";

/**
 * Middleware that validates the Authorization header.
 * Expects: Authorization: Bearer <token>
 * 
 * Returns 401 Unauthorized if:
 * - Authorization header is missing
 * - Token format is invalid
 * - Token doesn't match configured token
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const config = getConfig();
  const authHeader = req.headers.authorization;
  
  // Check if Authorization header exists
  if (!authHeader) {
    res.status(401).json({
      ok: false,
      error: {
        code: 401,
        message: "Authorization header is required"
      }
    });
    return;
  }
  
  // Check Bearer token format
  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    res.status(401).json({
      ok: false,
      error: {
        code: 401,
        message: "Invalid authorization format. Expected: Bearer <token>"
      }
    });
    return;
  }
  
  const token = parts[1];
  
  // Validate token
  if (token !== config.PROCESSOR_SERVER_TOKEN) {
    res.status(401).json({
      ok: false,
      error: {
        code: 401,
        message: "Invalid authorization token"
      }
    });
    return;
  }
  
  // Token is valid, proceed to next middleware
  next();
}

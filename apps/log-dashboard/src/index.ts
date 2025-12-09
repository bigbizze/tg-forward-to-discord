import dotenv from "dotenv";
import express from "express";
import { spawn } from "child_process";
import path from "node:path";
import { default as appRootPath } from "app-root-path";

const startServer = () => {
  const srcPath = path.resolve(appRootPath.path, "apps", "log-dashboard", "src");
  const publicPath = path.resolve(srcPath, "public");
  dotenv.config({
    path: path.resolve(appRootPath.path, ".env"),
    override: true
  });
  const app = express();
  const PORT = 6868;
  const HTML_LOG_VIEWER_TOKEN = process.env.HTML_LOG_VIEWER_TOKEN;

  if (!HTML_LOG_VIEWER_TOKEN) {
    console.error("ERROR: HTML_LOG_VIEWER_TOKEN not set in .env file");
    console.error("Please add HTML_LOG_VIEWER_TOKEN to your .env file");
    process.exit(1);
  }

  console.log(`Log dashboard starting on port ${PORT}`);
  console.log("Token authentication enabled");

  // Serve static HTML
  app.use(express.static(publicPath));

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // SSE endpoint for streaming logs
  app.get("/api/stream", (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace("Bearer ", "");

    if (typeof token !== "string") {
      console.warn("Unauthorized access attempt without token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    if (token !== HTML_LOG_VIEWER_TOKEN) {
      console.warn(`Unauthorized access attempt with token: ${token?.substring(0, 10)}...`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    console.log("Client connected to log stream");

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering

    // Send initial connection message
    res.write('data: {"type":"connected","message":"Connected to log stream"}\n\n');

    // Spawn pm2 logs process
    const pm2Logs = spawn("pnpm", [ "-F @tg-discord/log-dashboard get-logs" ], {
      env: { ...process.env, PM2_HOME: process.env.HOME + "/.pm2" },
      shell: true,
      cwd: appRootPath.path
    });

    // Stream stdout
    pm2Logs.stdout.on("data", (data) => {
      const lines = data.toString().split("\n").filter((line: string) => line.trim());
      for (const line of lines) {
        res.write(`data: ${JSON.stringify({ type: "log", data: line })}\n\n`);
      }
    });

    // Stream stderr
    pm2Logs.stderr.on("data", (data) => {
      const lines = data.toString().split("\n").filter((line: string) => line.trim());
      for (const line of lines) {
        res.write(`data: ${JSON.stringify({ type: "error", data: line })}\n\n`);
      }
    });

    // Handle client disconnect
    req.on("close", () => {
      console.log("Client disconnected from log stream");
      pm2Logs.kill();
    });

    // Handle pm2 process exit
    pm2Logs.on("exit", (code) => {
      console.log(`PM2 logs process exited with code ${code}`);
      res.write(`data: ${JSON.stringify({ type: "disconnect", message: "Stream ended", code })}\n\n`);
      res.end();
    });
  });

  app.listen(PORT, () => {
    console.log(`✓ Log dashboard server running on port ${PORT}`);
    console.log(`✓ Access at: http://localhost:${PORT}`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    console.log("SIGTERM received, shutting down gracefully");
    process.exit(0);
  });

  process.on("SIGINT", () => {
    console.log("SIGINT received, shutting down gracefully");
    process.exit(0);
  });
};

if (
  process.env.npm_config_production === "true"
  || process.env.NODE_ENV === "production"
  || process.env.RUN_LOG_DASHBOARD_IN_DEVELOPMENT === "true"
) {
  startServer();
}
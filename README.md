# Telegram-Discord Bridge

A system that forwards messages from Telegram channels to Discord webhooks, with configuration managed via Discord bot slash commands.

## Architecture Overview

The system uses a hybrid approach with three main components:

1. **Express Server** - HTTP API for message processing, configuration management, and centralized logging
2. **Discord Bot** - Slash command interface for managing subscriptions
3. **Python Scraper** - Telegram client that listens for messages and polls for missed ones

### Message Flow

```
Telegram Channel
    ↓ (real-time push via Telethon events + periodic polling)
Python Scraper
    ↓ (HTTP POST with message data)
Express Server
    ↓ (query subscriptions, create forward records)
SQLite Database
    ↓ (get discord_webhook URLs for the channel)
Express Server
    ↓ (format message, rate-limit, retry on failure)
Discord Webhooks
    ↓
Discord Channels
```

## Features

- **Real-time forwarding** via Telethon event handlers
- **Reliable catch-up** via periodic polling (default: every 10 minutes)
- **Exactly-once delivery** through message tracking and status management
- **Automatic retries** with exponential backoff for Discord webhook failures
- **Rate limiting** to respect Discord's API limits
- **Centralized logging** with optional Discord webhook notifications
- **Soft deletes** for subscriptions (can be reactivated)

## Getting Started

### Prerequisites

- Node.js v22+
- Python 3.10+
- pnpm (will be installed by setup script)
- A Telegram account with API credentials
- A Discord bot with application commands scope

### Installation

1. Clone the repository:
   ```bash
   git clone <repo-url> ~/tg-discord
   cd ~/tg-discord
   ```

2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your credentials:
   - `API_ID` and `API_HASH` from https://my.telegram.org
   - `DISCORD_BOT_TOKEN` and `DISCORD_CLIENT_ID` from Discord Developer Portal
   - `PROCESSOR_SERVER_TOKEN` - Generate a secure random string
   - `LOGGING_DISCORD_WEBHOOK_URL` (optional) - For error notifications

4. Run the setup script:
   ```bash
   pnpm setup
   ```

This will:
- Install Node.js dependencies
- Create Python virtual environment and install packages
- Build all TypeScript packages
- Set up the SQLite database
- Start all services via PM2

### Manual Development Setup

If you prefer to run things manually:

```bash
# Install dependencies
pnpm install

# Build packages
pnpm build

# Set up database
pnpm build:db

# Run in development mode (all services with watch)
pnpm dev
```

## Project Structure

```
tg-discord/
├── apps/
│   ├── discord-bot/          # Discord slash command bot
│   ├── express-server/       # HTTP API server
│   └── python-scraper/       # Telegram scraper
├── packages/
│   ├── config/               # Environment configuration (Zod schemas)
│   ├── db/                   # Database queries and connection
│   ├── db-setup/             # Idempotent schema setup
│   ├── discord-webhook/      # Discord webhook utilities with rate limiting
│   ├── result/               # Result<T, E> type utilities
│   └── shared-types/         # Zod schemas for API contracts
├── scripts/
│   └── idempotent-setup.sh   # Deployment setup script
├── .github/
│   └── workflows/
│       └── deploy.yml        # GitHub Actions deployment
├── ecosystem.config.cjs      # PM2 process configuration
└── package.json              # Root workspace configuration
```

## Database Schema

The system uses SQLite with WAL mode for concurrent access. Key tables:

- **telegram_channel** - Canonical Telegram channel information
- **discord_webhook** - Webhook subscriptions (links Discord to Telegram)
- **tg_msgs** - Stored Telegram messages
- **join_tg_msgs_forwarded_to_discord** - Forward status tracking (pending/success/error)
- **msg_cursor** - Tracks last seen message per channel
- **general_config** - Global configuration (cron schedule)

## Discord Bot Commands

| Command | Description |
|---------|-------------|
| `/show [channel]` | Display current subscriptions |
| `/add channel telegram_urls [group_id] [webhook_url]` | Subscribe to Telegram channels |
| `/remove channel telegram_urls [group_id]` | Unsubscribe from channels |
| `/help` | Show command documentation |

### Example Usage

```
/add channel:#alerts telegram_urls:https://t.me/cryptoalerts
/add channel:#news telegram_urls:https://t.me/channel1,https://t.me/channel2
/remove channel:#alerts telegram_urls:https://t.me/cryptoalerts
```

## API Endpoints

All endpoints require `Authorization: Bearer <PROCESSOR_SERVER_TOKEN>`.

### POST /process
Receives Telegram messages from the Python scraper.

### GET /config
Returns current configuration and all active subscriptions.

### POST /config
Updates configuration and manages webhook subscriptions.

### POST /log
Receives log messages for centralized logging.

### GET /health
Health check endpoint (no auth required).

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `SQLITE_PATH` | Path to SQLite database | No (default: bridge.db) |
| `API_ID` | Telegram API ID | Yes |
| `API_HASH` | Telegram API hash | Yes |
| `PROCESSOR_SERVER_LISTEN_URL` | Express server URL | No (default: http://localhost:6969) |
| `PROCESSOR_SERVER_TOKEN` | Authentication token | Yes |
| `DISCORD_BOT_TOKEN` | Discord bot token | Yes |
| `DISCORD_CLIENT_ID` | Discord application client ID | Yes |
| `LOGGING_DISCORD_WEBHOOK_URL` | Webhook for error notifications | No |
| `DEFAULT_CRON` | Polling schedule | No (default: */10 * * * *) |

## Deployment

### Using GitHub Actions

1. Set up the following secrets in your GitHub repository:
   - `SSH_HOST` - Server IP address
   - `SSH_USER` - SSH username
   - `SSH_PRIVATE_KEY` - SSH private key
   - `SSH_PORT` - SSH port (optional, defaults to 22)

2. Push to the `master` or `main` branch to trigger deployment.

### Manual Deployment

```bash
# On the server
cd ~/tg-discord
git pull
pnpm setup
```

### PM2 Commands

```bash
pm2 list                    # Show status
pm2 logs                    # View logs
pm2 restart all             # Restart all services
pm2 stop all                # Stop all services
pm2 start ecosystem.config.cjs  # Start services
```

## Error Handling

The system uses Result types (`Ok<T>` / `Err<E>`) throughout to handle errors explicitly without throwing exceptions. This ensures:

- No uncaught exceptions that crash processes
- Explicit error handling at every level
- Detailed error information for debugging

Errors are:
1. Logged to console
2. Optionally sent to the logging Discord webhook
3. Stored in PM2 log files

## Rate Limiting

Discord webhook rate limits are handled by:
1. Using the `limiter` package (25 requests/minute per webhook)
2. Respecting `429 Too Many Requests` responses
3. Automatic retries with exponential backoff

## Message Tracking

The `join_tg_msgs_forwarded_to_discord` table ensures exactly-once delivery:

1. When a message is received, forward records are created with `status='pending'`
2. After successful Discord POST, status changes to `'success'`
3. After failed retries, status changes to `'error'` with error message
4. Pending records are processed before new messages to clear backlog

## Development

### Scripts

```bash
pnpm build          # Build all packages
pnpm dev            # Run all services in watch mode
pnpm dev:ts         # Run only TypeScript services
pnpm lint           # Lint all packages
pnpm typecheck      # Type check all packages
pnpm build:db       # Set up/migrate database
```

### Adding a New Package

1. Create directory under `packages/` or `apps/`
2. Add `package.json` with workspace dependencies
3. Add `tsconfig.json` extending root config
4. Add to `pnpm-workspace.yaml` if needed

## License

MIT

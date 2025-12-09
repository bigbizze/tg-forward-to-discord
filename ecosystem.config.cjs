/**
 * PM2 Ecosystem Configuration
 * 
 * Manages all three application processes:
 * 1. express-server - HTTP API for message processing
 * 2. discord-bot - Discord slash command interface  
 * 3. python-scraper - Telegram event listener and poller
 * 
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 restart all
 *   pm2 logs
 *   pm2 stop all
 */

module.exports = {
  apps: [
    {
      name: 'express-server',
      script: './apps/express-server/dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/express-server-error.log',
      out_file: './logs/express-server-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'discord-bot',
      script: './apps/discord-bot/dist/index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      },
      error_file: './logs/discord-bot-error.log',
      out_file: './logs/discord-bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    },
    {
      name: 'python-scraper',
      script: './.venv/bin/python',
      args: 'scrape.py',
      cwd: './apps/python-scraper',
      interpreter: 'none',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      error_file: '../../logs/python-scraper-error.log',
      out_file: '../../logs/python-scraper-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
};

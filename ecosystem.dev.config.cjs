const appRootPath = require('app-root-path');

const shared = {
  script: 'pnpm',
  cwd: appRootPath.path,
  autorestart: false,
  watch: false,
  instances: 1,
  exec_mode: 'fork',
  time: true,
}

module.exports = {
  apps: [
    {
      name: 'discord-bot',
      args: '-F @tg-discord/discord-bot dev',
    },
    {
      name: 'express-server',
      args: '-F @tg-discord/express-server dev'
    },
    {
      name: 'python-scraper',
      args: '-F @tg-discord/python-scraper dev',
      watch: false // Do not change
    },
    {
      name: 'log-dashboard',
      args: '-F @tg-discord/log-dashboard dev:logs',
      watch: false
    }
  ].map(x => ({ ...shared, ...x })),
}

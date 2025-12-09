// noinspection ExceptionCaughtLocallyJS,DuplicatedCode,UnnecessaryLocalVariableJS

/**
 * Discord Bot Application
 *
 * A Discord bot that manages Telegram channel subscriptions via slash commands.
 * Users can subscribe Discord channels to Telegram channels using:
 *
 * - /show - Display current subscriptions for a channel
 * - /add - Subscribe to Telegram channels
 * - /remove - Unsubscribe from Telegram channels
 * - /help - Show command documentation
 *
 * The bot communicates with the Express server to manage subscriptions,
 * which are stored in the SQLite database.
 */

import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  ChannelType,
  MessageFlags
} from "discord.js";
import { getConfig, getConfigUrl, getLogUrl } from "@tg-discord/config";
import {
  type ConfigGetResponse,
  ConfigGetResponseSchema,
  type ConfigPostRequest,
  ConfigPostRequestSchema,
  ConfigPostResponseSchema
} from "@tg-discord/shared-types";
import { lineSeparator } from "@tg-discord/discord-webhook";

process.on("uncaughtException", async (error) => {
  console.error("Uncaught exception:", error);

  // Fire and forget - don't wait for this
  // Give the log request a chance to complete, but don't wait forever
  const logPromise = sendErrorLog(
    getConfig(),
    `[Discord Bot] Uncaught exception: ${error.message}`,
    { name: error.name, stack: error.stack }
  ).catch(e => console.error("Failed to send error log:", e));

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
  // Fire and forget - don't wait for this
  sendErrorLog(
    getConfig(),
    typeof reason === "string" ? reason : String(reason)
  ).catch(webhookError => {
    console.error("Failed to send error to Discord webhook:", webhookError);
  });
});

// ============================================================================
// Slash Command Definitions
// ============================================================================

const commands = [
  new SlashCommandBuilder()
    .setName("show")
    .setDescription("Show current Telegram subscriptions for a Discord channel")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("The Discord channel to check (defaults to current channel)")
        .setRequired(false)
        .addChannelTypes(ChannelType.GuildText)
    ),

  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Subscribe a Discord channel to Telegram channels")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("The Discord channel to add subscriptions to")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addStringOption(option =>
      option
        .setName("telegram_urls")
        .setDescription("Comma-separated list of Telegram channel URLs (e.g., https://t.me/channel1,https://t.me/channel2)")
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName("group_id")
        .setDescription("Subscription group identifier (lowercase alphanumeric, defaults to channel name)")
        .setRequired(false)
    )
    .addStringOption(option =>
      option
        .setName("webhook_url")
        .setDescription("Discord webhook URL for this channel (creates one if not provided)")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Unsubscribe a Discord channel from Telegram channels")
    .addChannelOption(option =>
      option
        .setName("channel")
        .setDescription("The Discord channel to remove subscriptions from")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText)
    )
    .addStringOption(option =>
      option
        .setName("telegram_url")
        .setDescription("Telegram channel URL to unsubscribe from")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option
        .setName("group_id")
        .setDescription("Subscription group identifier (required if channel has multiple groups)")
        .setRequired(false)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help information for the Telegram bridge bot")
].map(command => command.toJSON());

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Sends an error log to the Express server's log endpoint.
 */
async function sendErrorLog(
  config: ReturnType<typeof getConfig>,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  const logUrl = getLogUrl(config);

  try {
    await fetch(logUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.PROCESSOR_SERVER_TOKEN}`
      },
      body: JSON.stringify({
        logType: "error",
        message: `[Discord Bot] ${message}`,
        timestamp: new Date().toISOString(),
        details
      })
    });
  } catch (error) {
    console.error("Failed to send error log:", error);
  }
}

/**
 * Fetches current configuration from the Express server.
 */
async function fetchConfig(config: ReturnType<typeof getConfig>): Promise<ConfigGetResponse> {
  const configUrl = getConfigUrl(config);

  const response = await fetch(configUrl, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${config.PROCESSOR_SERVER_TOKEN}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch config: ${response.status} ${response.statusText}`);
  }
  const {
    success, error, data
  } = ConfigGetResponseSchema.safeParse(await response.json());
  if (!success) {
    throw new Error(`Invalid config data received from server: ${JSON.stringify(error.issues)}`);
  }
  return data;
}

/**
 * Updates configuration on the Express server.
 */
async function updateConfig(
  config: ReturnType<typeof getConfig>,
  body: ConfigPostRequest
): Promise<void> {
  const configUrl = getConfigUrl(config);

  const configPostRequestBodyValidated = ConfigPostRequestSchema.safeParse(body);
  if (!configPostRequestBodyValidated.success) {
    throw new Error(`Invalid config update body: ${JSON.stringify(configPostRequestBodyValidated.error.issues)}`);
  }

  const response = await fetch(configUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.PROCESSOR_SERVER_TOKEN}`
    },
    body: JSON.stringify(configPostRequestBodyValidated.data)
  });

  const {
    success, error, data: result
  } = ConfigPostResponseSchema.safeParse(await response.json());

  if (!success) {
    throw new Error(`Invalid response from config update: ${JSON.stringify(error.issues)}`);
  }

  if (!result.ok) {
    throw new Error(result.error?.message || "Failed to update config");
  }
}

type TgUrlValid =
  | { valid: false, url: string, username?: never, invalidReason: string }
  | { valid: true, url: string, username: string, invalidReason?: never };

/**
 * Parses comma-separated URLs into an array.
 */
function parseUrls(urlString: string): Array<TgUrlValid> {
  return urlString
    .split(",")
    .map(url => url.trim())
    .map((url): TgUrlValid => {
      if (url.length === 0) {
        return {
          url,
          valid: false,
          invalidReason: "Empty URL"
        };
      } else if (url.includes("/joinchat/") || url.includes("/+")) {
        return {
          url,
          valid: false,
          invalidReason: "Invite links are not supported"
        };
      }
      const match = url.match(/t\.me\/([a-zA-Z0-9_]+)/);
      if (!match) {
        return {
          url,
          valid: false,
          invalidReason: "Invalid Telegram URL format (check your URL)"
        };
      }
      const identifier = match[1];
      if (identifier === "joinchat" || identifier === "addlist" || identifier === "s" || identifier === "c") {
        return {
          url,
          valid: false,
          invalidReason: "Invalid Telegram URL format (check your URL). Invite links are not supported, you need a channel link."
        };
      }

      return {
        url,
        username: identifier,
        valid: true
      };
    });
}

// ============================================================================
// Config Cache (for autocomplete performance)
// ============================================================================

let configCache: { data: ConfigGetResponse; timestamp: number } | null = null;
const CONFIG_CACHE_TTL = 30000; // 30 seconds

async function getCachedConfig(config: ReturnType<typeof getConfig>): Promise<ConfigGetResponse> {
  const now = Date.now();
  if (configCache && now - configCache.timestamp < CONFIG_CACHE_TTL) {
    return configCache.data;
  }

  const data = await fetchConfig(config);
  configCache = { data, timestamp: now };
  return data;
}

function invalidateConfigCache(): void {
  configCache = null;
}

// ============================================================================
// Autocomplete Handlers
// ============================================================================

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  config: ReturnType<typeof getConfig>
): Promise<void> {
  try {
    const { commandName } = interaction;
    const focusedOption = interaction.options.getFocused(true);

    if (commandName === "remove") {
      if (focusedOption.name === "telegram_url") {
        await handleTelegramUrlAutocomplete(interaction, config);
      } else if (focusedOption.name === "group_id") {
        await handleGroupIdAutocomplete(interaction, config);
      }
    }
  } catch (error) {
    console.error("Autocomplete error:", error);
    // Respond with empty array on error
    await interaction.respond([]);
  }
}

async function handleGroupIdAutocomplete(
  interaction: AutocompleteInteraction,
  config: ReturnType<typeof getConfig>
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const channelOption = interaction.options.get("channel");
  const channelId = channelOption?.value as string | undefined;

  // Fetch current config to get available group IDs
  const serverConfig = await getCachedConfig(config);
  const subscriptions = serverConfig.subscriptions || [];

  // Filter subscriptions by the selected channel if provided
  let relevantGroups: string[];
  if (channelId) {
    relevantGroups = subscriptions
      .filter(sub => sub.discord_channel_id === channelId)
      .map(sub => sub.subscription_group_id);
  } else {
    relevantGroups = subscriptions.map(sub => sub.subscription_group_id);
  }

  // Remove duplicates
  const uniqueGroups = Array.from(new Set(relevantGroups));

  // Filter based on what user has typed
  const filtered = uniqueGroups
    .filter(groupId => groupId.toLowerCase().includes(focusedValue))
    .slice(0, 25); // Discord limit: max 25 choices

  await interaction.respond(
    filtered.map(groupId => ({
      name: groupId,
      value: groupId
    }))
  );
}

async function handleTelegramUrlAutocomplete(
  interaction: AutocompleteInteraction,
  config: ReturnType<typeof getConfig>
): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const channelOption = interaction.options.get("channel");
  const channelId = channelOption?.value as string | undefined;
  const groupId = interaction.options.getString("group_id");

  // Fetch current config
  const serverConfig = await getCachedConfig(config);
  const subscriptions = serverConfig.subscriptions || [];

  // Find subscriptions for the selected channel
  let relevantSubscriptions = subscriptions;
  if (channelId) {
    relevantSubscriptions = subscriptions.filter(sub => sub.discord_channel_id === channelId);
  }

  // Further filter by group_id if provided
  if (groupId) {
    relevantSubscriptions = relevantSubscriptions.filter(sub => sub.subscription_group_id === groupId);
  }

  // Collect all telegram channels from relevant subscriptions
  const allTelegramUrls = relevantSubscriptions.flatMap(sub => sub.telegram_channels);

  // Remove duplicates
  const uniqueUrls = [ ...new Set(allTelegramUrls) ];

  // Filter based on what user has typed
  const filtered = uniqueUrls
    .filter(url => url.toLowerCase().includes(focusedValue))
    .slice(0, 25);

  await interaction.respond(
    filtered.map(url => ({
      name: url,
      value: url
    }))
  );
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleShowCommand(
  interaction: ChatInputCommandInteraction,
  config: ReturnType<typeof getConfig>
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const channelOption = interaction.options.getChannel("channel");

    // Determine target channel ID and name (if filtering by channel)
    const targetChannelId = channelOption?.id;
    const currentChannelName = interaction.channel && "name" in interaction.channel
      ? interaction.channel.name
      : "this channel";
    const targetChannelName = channelOption?.name || currentChannelName;

    // Fetch current subscriptions (now includes discord_channel_id from database)
    const serverConfig = await fetchConfig(config);
    const allSubscriptions = serverConfig.subscriptions || [];

    // Filter subscriptions for the target channel if specified
    // Use discord_channel_id from the stored discord_channel_info
    const subscriptions = targetChannelId
      ? allSubscriptions.filter(sub => sub.discord_channel_id === targetChannelId)
      : allSubscriptions;

    if (subscriptions.length === 0) {
      if (targetChannelId && allSubscriptions.length > 0) {
        await interaction.editReply({
          content: `📭 No Telegram subscriptions for **#${targetChannelName}**.\n\nUse \`/add\` to subscribe this channel to Telegram channels, or run \`/show\` without a channel argument to see all subscriptions.`
        });
      } else {
        await interaction.editReply({
          content: "📭 No Telegram subscriptions are currently configured.\n\nUse `/add` to subscribe to Telegram channels."
        });
      }
      return;
    }

    const serverName = interaction?.guild?.name;
    console.log(serverName);
    // Format the subscriptions for display
    const header = targetChannelId
      ? `📋 **Telegram Subscriptions for <#${targetChannelId}> **\n\n`
      : `📋 **All Telegram Subscriptions for *${ serverName }***\n\n`;
    let response = header;

    for (const sub of subscriptions) {
      if (!targetChannelId) {
        response += `** <#${sub.discord_channel_id}> **\n`;
        response += "Telegram channels:\n";
      }
      for (const channel of sub.telegram_channels) {
        response += `  • ${channel}\n`;
      }
      response += "\n";
    }

    response = response.trimEnd();
    response += "\n_Use `/add` to add more subscriptions or `/remove` to unsubscribe._";

    response += `

${lineSeparator}

`;

    await interaction.editReply({
      content: response
    });

  } catch (error) {
    console.error("Error in /show command:", error);
    await sendErrorLog(config, `Show command failed: ${error}`, {
      channelId: interaction.channelId,
      userId: interaction.user.id
    });

    await interaction.editReply({
      content: `❌ Failed to fetch subscriptions: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
}

async function handleAddCommand(
  interaction: ChatInputCommandInteraction,
  config: ReturnType<typeof getConfig>
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const channel = interaction.options.getChannel("channel", true);
    if (!channel?.name) {
      throw new Error("Channel name is required to determine group ID.");
    }
    const telegramUrlsRaw = interaction.options.getString("telegram_urls", true);
    const groupId = interaction.options.getString("group_id") || channel.name.toLowerCase().replace(/[^a-z0-9\-]/g, "");
    const webhookUrl = interaction.options.getString("webhook_url");

    // Parse the telegram URLs
    const telegramUrlsResult = parseUrls(telegramUrlsRaw);
    const invalidUrls = telegramUrlsResult.filter(url => !url.valid);

    if (invalidUrls.length > 0) {
      await interaction.editReply({
        content: `❌ Invalid Telegram URLs: \n${invalidUrls.map(url => `  • ${url.url} (${url.invalidReason})`).join("\n")}\n\n##########\n\n`
      });
      return;
    }

    const telegramUrls = telegramUrlsResult
      .filter(url => url.valid)
      .map(({ url, username }) => ({
        url,
        username
      }));

    if (telegramUrls.length === 0) {
      await interaction.editReply({
        content: "❌ Please provide at least one valid Telegram URL."
      });
      return;
    }

    // Fetch current subscriptions to filter out already-subscribed URLs
    const serverConfig = await fetchConfig(config);
    const existingSubscription = serverConfig.subscriptions?.find(
      sub => sub.discord_channel_id === channel.id
    );
    const existingUrls = new Set(existingSubscription?.telegram_channels || []);

    // Filter out URLs that are already subscribed
    const alreadySubscribed = telegramUrls.filter(({ url }) => existingUrls.has(url));
    const newUrls = telegramUrls.filter(({ url }) => !existingUrls.has(url));

    if (newUrls.length === 0) {
      const alreadyList = alreadySubscribed.map(({ url }) => `  • ${url}`).join("\n");
      await interaction.editReply({
        content: `❌ **#${channel.name}** is already subscribed to ${alreadySubscribed.length === 1 ? "this Telegram channel" : "all these Telegram channels"}:\n${alreadyList}\n\n##########\n\n`
      });
      return;
    }

    // If no webhook URL provided, we need to find or create one
    let finalWebhookUrl = webhookUrl;
    if (!finalWebhookUrl) {
      const webhookName = `Telegram Bridge - ${groupId}`;
      try {
        const textChannel = await interaction.guild?.channels.fetch(channel.id);
        if (textChannel && textChannel.type === ChannelType.GuildText) {
          // First, check for existing webhooks with the same name
          const existingWebhooks = await textChannel.fetchWebhooks();
          const matchingWebhooks = existingWebhooks.filter(wh => wh.name === webhookName);

          if (matchingWebhooks.size > 0) {
            // Sort by createdAt (oldest first) and keep the oldest one
            const sortedWebhooks = [ ...matchingWebhooks.values() ].sort(
              (a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0)
            );
            const webhookToKeep = sortedWebhooks[0];
            finalWebhookUrl = webhookToKeep.url;

            // Delete duplicate webhooks (keep only the oldest)
            if (sortedWebhooks.length > 1) {
              for (const duplicateWebhook of sortedWebhooks.slice(1)) {
                try {
                  await duplicateWebhook.delete("Removing duplicate Telegram Bridge webhook");
                } catch {
                  // Ignore deletion errors
                }
              }
            }
          } else {
            // No existing webhook found, create a new one
            const webhook = await textChannel.createWebhook({
              name: webhookName,
              reason: "Created by Telegram Bridge Bot"
            });
            finalWebhookUrl = webhook.url;
          }
        }
      } catch (webhookError) {
        await sendErrorLog(config, `Failed to create webhook: ${webhookError}`, {
          channelId: channel.id,
          channelName: channel.name,
          userId: interaction.user.id
        });
        await interaction.editReply({
          content: "❌ Failed to create webhook for channel. Please provide a webhook URL manually using the `webhook_url` option, or grant the bot \"Manage Webhooks\" permission."
        });
        return;
      }
    }

    if (!finalWebhookUrl) {
      await interaction.editReply({
        content: "❌ Could not determine webhook URL. Please provide one using the `webhook_url` option."
      });
      return;
    }

    // Get server/guild info for discord_channel_info
    const guild = interaction.guild;
    const serverName = guild?.name || "Unknown Server";
    const serverId = guild?.id || "";

    // Send the update to the Express server with discord channel info
    await updateConfig(config, {
      discord_setup: {
        subscription_group_id: groupId,
        description: `Subscriptions for #${channel.name}`,
        discord_webhook_url: finalWebhookUrl,
        discord_channel_info: {
          channel_id: channel.id,
          server_id: serverId,
          channel_name: channel.name,
          server_name: serverName
        },
        add_telegram_subscribed_channels: newUrls
      }
    });

    // Build response message
    let responseContent = `✅ Successfully subscribed **<#${channel.id}>** to:\n${newUrls.map(url => `${newUrls.length > 1 ? "  • " : ""}${url.url} - *${url.username}*`).join("\n")}\n\nGroup ID: \`${groupId}\`\\n\\n${lineSeparator}\\n\\n`;

    // Mention skipped URLs if any
    if (alreadySubscribed.length > 0) {
      responseContent += `\n\n⚠️ Skipped (already subscribed):\n${alreadySubscribed.map(({ url }) => `  • ${url}`).join("\n")}

${lineSeparator}

`;
    }

    await interaction.editReply({
      content: responseContent
    });

  } catch (error) {
    console.error("Error in /add command:", error);
    await sendErrorLog(config, `Add command failed: ${error}`, {
      channelId: interaction.channelId,
      userId: interaction.user.id
    });

    await interaction.editReply({
      content: `❌ Failed to add subscriptions: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
}

async function handleRemoveCommand(
  interaction: ChatInputCommandInteraction,
  config: ReturnType<typeof getConfig>
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const channel = interaction.options.getChannel("channel", true);
    if (!channel?.name) {
      throw new Error("Channel name is required to determine group ID.");
    }
    const telegramUrl = interaction.options.getString("telegram_url", true);
    const groupId = interaction.options.getString("group_id") || channel.name.toLowerCase().replace(/[^a-z0-9\-]/g, "");

    // Validate the telegram URL
    const urlResult = parseUrls(telegramUrl);
    if (urlResult.length === 0 || !urlResult[0].valid) {
      const reason = urlResult[0]?.invalidReason || "Invalid URL format";
      await interaction.editReply({
        content: `❌ Invalid Telegram URL: ${telegramUrl} (${reason})

${lineSeparator}

`
      });
      return;
    }

    const validatedUrl = urlResult[0].url;

    // We need a webhook URL for the config update - fetch current config to find it
    const serverConfig = await fetchConfig(config);
    const subscription = serverConfig.subscriptions?.find(
      (sub: { subscription_group_id: string }) => sub.subscription_group_id === groupId
    );

    if (!subscription) {
      await interaction.editReply({
        content: `❌ No subscription group found with ID \`${groupId}\`. Use \`/show\` to see current subscriptions.`
      });
      return;
    }

    // Send the update to the Express server
    await updateConfig(config, {
      discord_setup: {
        subscription_group_id: groupId,
        discord_webhook_url: subscription.discord_webhook_url,
        remove_telegram_unsubscribed_channels: [ validatedUrl ]
      }
    });

    // Invalidate cache so autocomplete reflects the removal immediately
    invalidateConfigCache();

    await interaction.editReply({
      content: `✅ Successfully unsubscribed **<#${channel.id}>** from:\n  • ${validatedUrl}

${lineSeparator}

`
    });

  } catch (error) {
    console.error("Error in /remove command:", error);
    await sendErrorLog(config, `Remove command failed: ${error}`, {
      channelId: interaction.channelId,
      userId: interaction.user.id
    });

    await interaction.editReply({
      content: `❌ Failed to remove subscriptions: ${error instanceof Error ? error.message : "Unknown error"}`
    });
  }
}

async function handleHelpCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const helpText = `
# 🌉 Telegram Bridge Bot

This bot forwards messages from Telegram channels to Discord channels.

## Commands

### \`/show [channel]\`
Shows current Telegram subscriptions. If no channel is specified, shows all subscriptions.

### \`/add channel telegram_urls [group_id] [webhook_url]\`
Subscribe a Discord channel to one or more Telegram channels.

**Parameters:**
- \`channel\` (required): The Discord channel to receive forwarded messages
- \`telegram_urls\` (required): Comma-separated Telegram URLs (e.g., \`https://t.me/channel1,https://t.me/channel2\`)
- \`group_id\` (optional): A unique identifier for this subscription group (defaults to channel name)
- \`webhook_url\` (optional): Discord webhook URL (bot will create one if not provided)

### \`/remove channel telegram_url [group_id]\`
Unsubscribe a Discord channel from a Telegram channel.

**Parameters:**
- \`channel\` (required): The Discord channel to modify
- \`telegram_url\` (required): Telegram URL to unsubscribe from (autocomplete enabled)
- \`group_id\` (optional): The subscription group ID (autocomplete enabled, required if channel has multiple groups)

## Examples

**Subscribe to a single channel:**
\`\`\`
/add channel:#alerts telegram_urls:https://t.me/cryptoalerts
\`\`\`

**Subscribe to multiple channels:**
\`\`\`
/add channel:#news telegram_urls:https://t.me/channel1,https://t.me/channel2
\`\`\`

**Unsubscribe:**
\`\`\`
/remove channel:#alerts telegram_url:https://t.me/cryptoalerts
\`\`\`
`;

  await interaction.reply({ content: helpText, flags: MessageFlags.Ephemeral });
}

// ============================================================================
// Main Bot Setup
// ============================================================================

async function main() {
  const config = getConfig();

  // Create the Discord client
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages
    ]
  });

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);

  try {
    console.log("Registering slash commands...");

    await rest.put(
      Routes.applicationCommands(config.DISCORD_CLIENT_ID),
      { body: commands }
    );

    console.log("Slash commands registered successfully!");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
    await sendErrorLog(config, `Failed to register slash commands: ${error}`, {
      clientId: config.DISCORD_CLIENT_ID
    });
    throw error;
  }

  // Handle interactions
  client.on("interactionCreate", async (interaction) => {
    // Handle autocomplete
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, config);
      return;
    }

    // Handle command execution
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;

    try {
      switch (commandName) {
        case "show":
          await handleShowCommand(interaction, config);
          break;
        case "add":
          await handleAddCommand(interaction, config);
          break;
        case "remove":
          await handleRemoveCommand(interaction, config);
          break;
        case "help":
          await handleHelpCommand(interaction);
          break;
        default:
          await interaction.reply({
            content: "Unknown command",
            ephemeral: true
          });
      }
    } catch (error) {
      console.error(`Error handling command ${commandName}:`, error);
      await sendErrorLog(config, `Unhandled error in command ${commandName}: ${error}`, {
        commandName,
        channelId: interaction.channelId,
        userId: interaction.user.id
      });

      // Try to respond if we haven't already
      try {
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply({
            content: "An error occurred while processing the command."
          });
        } else if (!interaction.replied) {
          await interaction.reply({
            content: "An error occurred while processing the command.",
            ephemeral: true
          });
        }
      } catch {
        // Interaction may have expired or already been handled, ignore
      }
    }
  });

  // Ready event
  client.once("ready", (readyClient) => {
    console.log(`Discord bot logged in as ${readyClient.user.tag}`);
    console.log(`Bot is in ${readyClient.guilds.cache.size} guild(s)`);
  });

  // Error handling
  client.on("error", (error) => {
    console.error("Discord client error:", error);
    sendErrorLog(config, `Discord client error: ${error.message}`, {
      name: error.name
    });
  });

  // Login
  await client.login(config.DISCORD_BOT_TOKEN);

  let isShuttingDown = false;

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Received ${signal}, shutting down Discord bot...`);
    await client.destroy();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(async (error) => {
  console.error("Fatal error:", error);
  try {
    const config = getConfig();
    await sendErrorLog(config, `Fatal error: ${error}`, {
      stack: error instanceof Error ? error.stack : undefined
    });
  } catch {
    // Config may have failed to load, can't send error log
  }
  process.exit(1);
});


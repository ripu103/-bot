import {
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} from 'discord.js';
import { loadEnv } from './env.js';

loadEnv();

const { config, COLORS, jstString } = await import('./config.js');
const { commands, commandMap, handleAutocomplete } = await import('./commands/index.js');
const { routeComponent } = await import('./interactions/index.js');
const { get, run } = await import('./db.js');
const { handleAntiraid } = await import('./services/antiraid.js');
const { restoreAllPanels } = await import('./services/panel.js');
const { startScheduler } = await import('./services/scheduler.js');
const { sendNotification, logAdmin } = await import('./lib/logger.js');
const { ephemeral } = await import('./lib/permissions.js');

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
});

export async function registerCommands() {
  if (!client.application) return [];
  const body = commands.map((command) => command.data.toJSON());
  if (config.guildId) {
    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (guild) {
      await guild.commands.set(body);
      return body.map((command) => command.name);
    }
  }
  await client.application.commands.set(body);
  return body.map((command) => command.name);
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`[bot] ログイン: ${ready.user.tag}`);
  try {
    const names = await registerCommands();
    console.log(`[bot] コマンド登録: ${names.length}件`);
  } catch (error) {
    console.error('[bot] コマンド登録に失敗:', error.message);
  }
  await restoreAllPanels(client).catch((error) => console.error('[bot] パネル復元:', error.message));
  startScheduler(client);
  ready.user.setActivity('りぷSHOP 自販機', { type: ActivityType.Watching });
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      return await handleAutocomplete(interaction);
    }

    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) return;
      if (!interaction.inGuild()) {
        return interaction.reply(ephemeral('このコマンドはサーバー内でのみ使用できます。'));
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
      return await routeComponent(interaction);
    }
  } catch (error) {
    console.error('[interaction]', interaction.commandName ?? interaction.customId, error);
    try {
      const message = `エラーが発生しました: ${error.message}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(message);
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    } catch {
      /* ignore */
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    await handleAntiraid(message);
  } catch (error) {
    console.error('[antiraid]', error.message);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const now = new Date().toISOString();
  run(
    `INSERT INTO member_stats (guild_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL`,
    [member.guild.id, member.id, now],
  );

  await sendNotification(client, member.guild.id, 'join_leave', {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.sub)
        .setTitle('メンバー参加')
        .addFields(
          { name: 'メンバー', value: `${member.user.tag}`, inline: true },
          { name: 'ID', value: member.id, inline: true },
          { name: 'アカウント作成', value: jstString(member.user.createdAt), inline: true },
          { name: '参加日時', value: jstString(now), inline: true },
        ),
    ],
  });
});

client.on(Events.GuildMemberRemove, async (member) => {
  const now = new Date().toISOString();
  run(
    `INSERT INTO member_stats (guild_id, user_id, joined_at, left_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET left_at = excluded.left_at`,
    [member.guild.id, member.id, now],
  );

  await sendNotification(client, member.guild.id, 'join_leave', {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.accent)
        .setTitle('メンバー退出')
        .addFields(
          { name: 'メンバー', value: `${member.user.tag}`, inline: true },
          { name: 'ID', value: member.id, inline: true },
          { name: 'アカウント作成', value: jstString(member.user.createdAt), inline: true },
          { name: '退出日時', value: jstString(now), inline: true },
        ),
    ],
  });
});

client.on(Events.Error, (error) => console.error('[client]', error.message));

export async function startBot() {
  if (!config.token) {
    console.warn('[bot] DISCORD_BOT_TOKEN が未設定のため起動しません');
    return null;
  }
  await client.login(config.token);
  return client;
}

if (process.argv[1]?.endsWith('bot.js')) {
  startBot().catch((error) => {
    console.error('[bot] 起動に失敗:', error.message);
    process.exitCode = 1;
  });
}

export { commands };

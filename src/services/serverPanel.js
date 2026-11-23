import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS, jstString } from '../config.js';
import { all, get } from '../db.js';
import { yen } from '../lib/format.js';

function countSince(guildId, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const joined = get('SELECT COUNT(*) AS c FROM member_stats WHERE guild_id = ? AND joined_at >= ?', [guildId, since])?.c ?? 0;
  const left = get('SELECT COUNT(*) AS c FROM member_stats WHERE guild_id = ? AND left_at >= ?', [guildId, since])?.c ?? 0;
  return joined - left;
}

export function serverEmbed(guild) {
  const members = guild.members.cache;
  const humans = members.filter((member) => !member.user.bot).size;
  const bots = members.filter((member) => member.user.bot).size;
  const online = members.filter((member) => member.presence && member.presence.status !== 'offline').size;
  const offline = members.size - online;

  const roleCounts = guild.roles.cache
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.members.size - a.members.size)
    .first(10)
    .map((role) => `${role.name}: ${role.members.size}人`)
    .join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle('サーバー管理パネル')
    .addFields(
      {
        name: 'メンバー',
        value: [
          `総数: **${members.size}**`,
          `人間: **${humans}** / Bot: **${bots}**`,
          `オンライン: **${online}** / オフライン: **${offline}**`,
        ].join('\n'),
        inline: false,
      },
      {
        name: '純増減',
        value: [
          `24時間: ${countSince(guild.id, 1) >= 0 ? '+' : ''}${countSince(guild.id, 1)}`,
          `3日間: ${countSince(guild.id, 3) >= 0 ? '+' : ''}${countSince(guild.id, 3)}`,
          `7日間: ${countSince(guild.id, 7) >= 0 ? '+' : ''}${countSince(guild.id, 7)}`,
        ].join('\n'),
        inline: true,
      },
      { name: 'ロール別人数', value: roleCounts || 'データなし', inline: true },
    )
    .setFooter({ text: '1時間ごとに自動更新 / バックアップは3日ごと' })
    .setTimestamp();

  const backups = all('SELECT id, created_at FROM backups WHERE guild_id = ? ORDER BY id DESC LIMIT 3', [guild.id]);
  if (backups.length) {
    embed.addFields({
      name: '最新バックアップ',
      value: backups.map((row) => `#${row.id} ${jstString(row.created_at)}`).join('\n'),
    });
  }
  return embed;
}

export function serverComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('server:backup').setLabel('バックアップ作成').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('server:restore').setLabel('バックアップから復元').setStyle(ButtonStyle.Danger),
    ),
  ];
}

export async function refreshServerPanels(client, guildId) {
  const panel = get("SELECT * FROM panels WHERE guild_id = ? AND kind = 'server'", [guildId]);
  if (!panel?.channel_id || !panel?.message_id) return;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(panel.channel_id);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  await message?.edit({ embeds: [serverEmbed(guild)], components: serverComponents() }).catch(() => null);
}

export function revenueLine(guildId) {
  const row = get("SELECT COALESCE(SUM(unit_price * quantity), 0) AS total FROM purchases WHERE guild_id = ? AND state = 'completed'", [guildId]);
  return yen(row?.total ?? 0);
}

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionsBitField } from 'discord.js';
import { COLORS } from '../config.js';
import { get } from '../db.js';

export function verificationPanelPayload() {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle('認証')
        .setDescription('下のボタンを押すと認証が完了し、サーバーをご利用いただけます。'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('verify:click').setLabel('認証する').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

/**
 * 認証前メンバーの閲覧を制限する。
 * 認証チャンネル以外のチャンネルで @everyone の閲覧を拒否する。
 */
export async function applyVerificationLock(guild, verificationChannelId) {
  let changed = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.id === verificationChannelId) continue;
    if (!('permissionOverwrites' in channel) || !channel.manageable) continue;
    try {
      await channel.permissionOverwrites.edit(
        guild.id,
        { ViewChannel: false },
        { reason: '認証設定: 認証前メンバーの閲覧制限' },
      );
      changed += 1;
    } catch {
      /* 権限不足はスキップ */
    }
  }
  return changed;
}

export function verificationSettings(guildId) {
  return get('SELECT * FROM verification WHERE guild_id = ?', [guildId]);
}

export const verificationPermissions = [
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ViewChannel,
];

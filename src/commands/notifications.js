import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { run, get } from '../db.js';
import { guardAdmin } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export function saveNotify(guildId, kind, channelId, extra = null, enabled = null) {
  const existing = get('SELECT * FROM notify_settings WHERE guild_id = ? AND kind = ?', [guildId, kind]);
  const isEnabled = enabled ?? (channelId ? 1 : 0);
  run(
    `INSERT INTO notify_settings (guild_id, kind, channel_id, enabled, extra) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, kind) DO UPDATE SET channel_id = excluded.channel_id, enabled = excluded.enabled, extra = excluded.extra`,
    [guildId, kind, channelId ?? existing?.channel_id ?? null, channelId ? isEnabled : 0, extra ?? existing?.extra ?? null],
  );
}

const base = (name, description) =>
  new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .addChannelOption((o) => o.setName('チャンネル').setDescription('通知先（未指定でOFF）'));

export const purchaseLogCommand = {
  data: base('購入ログ設定', '購入申請ログの通知先を設定します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル');
    saveNotify(interaction.guildId, 'purchase_log', channel?.id ?? null);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '購入ログ設定', channel ? `<#${channel.id}>` : 'OFF');
    await interaction.reply(ephemeral(channel ? `購入申請ログを <#${channel.id}> に送信します。` : '購入申請ログの通知をOFFにしました。'));
  },
};

export const purchaseResultCommand = {
  data: base('購入実績通知', '購入成功時の通知先を設定します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル');
    saveNotify(interaction.guildId, 'purchase_result', channel?.id ?? null);
    await interaction.reply(ephemeral(channel ? `購入実績を <#${channel.id}> に通知します。` : '購入実績通知をOFFにしました。'));
  },
};

export const stockCommand = {
  data: base('在庫追加通知', '在庫追加時の通知先を設定します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル');
    saveNotify(interaction.guildId, 'stock_add', channel?.id ?? null);
    await interaction.reply(ephemeral(channel ? `在庫追加を <#${channel.id}> に通知します。` : '在庫追加通知をOFFにしました。'));
  },
};

export const adminLogCommand = {
  data: base('管理ログ設定', '管理操作ログの通知先を設定します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル');
    saveNotify(interaction.guildId, 'management', channel?.id ?? null);
    await interaction.reply(ephemeral(channel ? `管理ログを <#${channel.id}> に送信します（DBは最新10件を保持）。` : '管理ログ通知をOFFにしました。'));
  },
};

export const joinLeaveCommand = {
  data: base('入退室ログ設定', 'メンバーの参加・退出ログの通知先を設定します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル');
    saveNotify(interaction.guildId, 'join_leave', channel?.id ?? null);
    await interaction.reply(ephemeral(channel ? `入退室ログを <#${channel.id}> に送信します。` : '入退室ログ通知をOFFにしました。'));
  },
};

export const commands = [purchaseLogCommand, purchaseResultCommand, stockCommand, adminLogCommand, joinLeaveCommand];

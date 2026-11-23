import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { COLORS, jstString } from '../config.js';
import { get, run } from '../db.js';
import { ephemeral, guardAdmin } from '../lib/permissions.js';
import { logAdmin, sendNotification } from '../lib/logger.js';
import { getAntiraid } from '../services/antiraid.js';
import { listBackups, restoreBackup } from '../services/backup.js';
import { serverComponents, serverEmbed } from '../services/serverPanel.js';
import { statsComponents, statsEmbed } from '../services/stats.js';

export const antiraidPanelCommand = {
  data: new SlashCommandBuilder().setName('荒らし対策パネル').setDescription('荒らし対策の設定パネルを表示します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    const settings = getAntiraid(interaction.guildId);
    const embed = new EmbedBuilder()
      .setColor(COLORS.main)
      .setTitle('荒らし対策パネル')
      .setDescription('ボタンで各項目を切り替えます。設定変更はサーバーオーナーのみ可能です。')
      .addFields(
        { name: '全体', value: settings.enabled ? 'ON' : 'OFF', inline: true },
        { name: 'URL対策', value: settings.urlBlock ? 'ON' : 'OFF', inline: true },
        { name: '招待リンク対策', value: settings.inviteBlock ? 'ON' : 'OFF', inline: true },
        { name: '連投制限', value: settings.spamBlock ? `ON（${settings.spamWindowSec}秒/${settings.spamCount}件→${settings.spamTimeoutMin}分）` : 'OFF', inline: true },
        { name: 'アカウント作成日時対策', value: settings.newAccountBlock ? `ON（${settings.minAccountAgeDays}日未満→${settings.newAccountTimeoutMin}分）` : 'OFF', inline: true },
        { name: '外部コマンド対策', value: settings.commandBlock ? 'ON' : 'OFF', inline: true },
        { name: 'URL許可チャンネル', value: settings.allowedUrlChannelIds.length ? settings.allowedUrlChannelIds.map((id) => `<#${id}>`).join(' ') : 'なし' },
        { name: '除外ユーザー', value: settings.exemptUserIds.length ? settings.exemptUserIds.map((id) => `<@${id}>`).join(' ') : 'なし' },
      );

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('antiraid:toggle:enabled').setLabel(`全体 ${settings.enabled ? 'OFF' : 'ON'}`).setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId('antiraid:toggle:urlBlock').setLabel('URL対策').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('antiraid:toggle:inviteBlock').setLabel('招待対策').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('antiraid:toggle:spamBlock').setLabel('連投制限').setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('antiraid:toggle:newAccountBlock').setLabel('アカウント作成日時').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('antiraid:toggle:commandBlock').setLabel('外部コマンド').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('antiraid:toggle:detailed').setLabel('詳細設定').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('antiraid:allowed-url').setLabel('URL許可CH追加').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ embeds: [embed], components: [row1, row2], flags: MessageFlags.Ephemeral });
  },
};

export const serverPanelCommand = {
  data: new SlashCommandBuilder()
    .setName('サーバー管理パネル')
    .setDescription('サーバー統計・バックアップパネルを設置します')
    .addChannelOption((o) => o.setName('チャンネル').setDescription('設置先（未指定ならこのチャンネル）').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    const channel = interaction.options.getChannel('チャンネル', true);
    if (!channel?.isTextBased()) return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));

    const message = await channel.send({ embeds: [serverEmbed(interaction.guild)], components: serverComponents() });
    run(
      `INSERT INTO panels (guild_id, kind, channel_id, message_id, updated_at) VALUES (?, 'server', ?, ?, ?)
       ON CONFLICT(guild_id, kind) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, updated_at = excluded.updated_at`,
      [interaction.guildId, channel.id, message.id, new Date().toISOString()],
    );
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'サーバー管理パネル設置', `<#${channel.id}>`);
    await interaction.reply(ephemeral(`<#${channel.id}> にサーバー管理パネルを設置しました（1時間ごとに更新）。`));
  },
};

export const statsPanelCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機統計パネル')
    .setDescription('売上・利益・販売数の統計パネルを設置します')
    .addChannelOption((o) => o.setName('チャンネル').setDescription('設置先（未指定ならこのチャンネル）').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    const channel = interaction.options.getChannel('チャンネル', true);
    if (!channel?.isTextBased()) return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));
    const existing = get("SELECT * FROM panels WHERE guild_id = ? AND kind = 'statistics'", [interaction.guildId]);
    if (existing) return interaction.reply(ephemeral('統計パネルはすでに設置済みです（設置チャンネルの変更はできません）。'));

    const message = await channel.send({ embeds: [statsEmbed(interaction.guildId)], components: statsComponents(interaction.guildId) });
    run(
      `INSERT INTO panels (guild_id, kind, channel_id, message_id, updated_at) VALUES (?, 'statistics', ?, ?, ?)`,
      [interaction.guildId, channel.id, message.id, new Date().toISOString()],
    );
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '統計パネル設置', `<#${channel.id}>`);
    await interaction.reply(ephemeral(`<#${channel.id}> に統計パネルを設置しました。`));
  },
};

export const maintenanceCommand = {
  data: new SlashCommandBuilder()
    .setName('メンテナンス設定')
    .setDescription('購入機能のメンテナンスを設定します')
    .addStringOption((o) =>
      o
        .setName('状態')
        .setDescription('メンテナンス状態')
        .setRequired(true)
        .addChoices({ name: 'メンテナンス開始', value: 'on' }, { name: 'メンテナンス終了', value: 'off' }),
    )
    .addStringOption((o) => o.setName('メッセージ').setDescription('購入パネルに表示する案内')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const state = interaction.options.getString('状態', true);
    const message = interaction.options.getString('メッセージ') || 'ただいまメンテナンス中です。';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    run('UPDATE guild_settings SET maintenance = ?, maintenance_message = ? WHERE guild_id = ?', [
      state === 'on' ? 1 : 0,
      message,
      interaction.guildId,
    ]);

    const verification = get('SELECT role_id FROM verification WHERE guild_id = ?', [interaction.guildId]);
    const role = verification ? interaction.guild.roles.cache.get(verification.role_id) : null;
    const targets = role ? role.members.filter((member) => !member.user.bot) : new Map();
    const failed = [];
    let sent = 0;

    for (const member of targets.values()) {
      try {
        await member.send(state === 'on' ? 'メンテナンスを開始します！' : 'メンテナンスが終了しました！');
        sent += 1;
      } catch {
        failed.push(member.id);
      }
    }

    run('UPDATE guild_settings SET maintenance_dm_failed = ? WHERE guild_id = ?', [
      failed.length ? JSON.stringify(failed) : null,
      interaction.guildId,
    ]);
    await logAdmin(
      interaction.client,
      interaction.guildId,
      interaction.user.id,
      'メンテナンス設定',
      `${state === 'on' ? '開始' : '終了'} / 送信${sent} 失敗${failed.length}`,
    );
    await interaction.editReply(
      `メンテナンスを${state === 'on' ? '開始' : '終了'}しました。\nDM送信: ${sent}件 / 失敗: ${failed.length}件` +
        (failed.length ? `\n失敗したユーザー: ${failed.map((id) => `<@${id}>`).join(' ')}` : ''),
    );
  },
};

export const restoreCommand = {
  data: new SlashCommandBuilder()
    .setName('リストア')
    .setDescription('バックアップからサーバー情報を復元します（オーナーのみ）')
    .addStringOption((o) => o.setName('バックアップ').setDescription('バックアップを選択').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('確認').setDescription('「復元」と入力').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    if (interaction.options.getString('確認') !== '復元') {
      return interaction.reply(ephemeral('確認のため「復元」と入力してください。'));
    }
    const id = Number(interaction.options.getString('バックアップ'));
    const exists = listBackups(interaction.guildId).some((row) => row.id === id);
    if (!exists) return interaction.reply(ephemeral('バックアップが見つかりません。'));

    const row = get('SELECT created_at FROM backups WHERE id = ?', [id]);
    const embed = new EmbedBuilder()
      .setColor(COLORS.danger)
      .setTitle('リストアの確認')
      .setDescription(
        `バックアップ #${id}（${jstString(row.created_at)}）から復元します。\n` +
          'バックアップに存在しないチャンネル・ロールは削除され、メンバーのロールは保存時点に戻ります。\n' +
          'この操作は取り消せません。',
      );
    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`restore:run:${id}`).setLabel('復元する').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('restore:cancel').setLabel('キャンセル').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ embeds: [embed], components: [confirmRow], flags: MessageFlags.Ephemeral });
  },
};

export async function runRestore(interaction, backupId) {
  if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
  await interaction.update({ content: '復元を実行しています…', embeds: [], components: [] });
  const result = await restoreBackup(interaction.client, interaction.guild, backupId, interaction.user.id);
  if (!result.ok) {
    await interaction.editReply(result.reason);
    return;
  }
  await interaction.editReply(
    result.failures.length
      ? `復元が完了しました（失敗 ${result.failures.length}件）。詳細はオーナーのDMをご確認ください。`
      : '復元が完了しました（失敗なし）。',
  );
}

export const commands = [antiraidPanelCommand, serverPanelCommand, statsPanelCommand, maintenanceCommand, restoreCommand];

export async function backupAutocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const rows = listBackups(interaction.guildId).filter((row) => String(row.id).includes(focused));
  await interaction.respond(rows.slice(0, 25).map((row) => ({ name: `#${row.id} ${jstString(row.created_at)}`, value: String(row.id) })));
}

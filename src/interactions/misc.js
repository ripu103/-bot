import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS, jstString } from '../config.js';
import { all, get, run } from '../db.js';
import { yen } from '../lib/format.js';
import { ephemeral, guardAdmin, isOwner } from '../lib/permissions.js';
import { logAdmin, sendNotification } from '../lib/logger.js';
import { getAntiraid, saveAntiraid } from '../services/antiraid.js';
import { createBackup, listBackups } from '../services/backup.js';
import { endCampaign, statsEmbed } from '../services/stats.js';
import { refreshGuildPanels, refreshMachineById } from '../services/panel.js';
import { getProduct, listProducts, stockCount } from '../services/catalog.js';
import { createTicket } from '../services/tickets.js';
import { panelPayload as ticketPanelPayload } from '../services/tickets.js';
import { purchaseListPayload } from '../commands/purchases.js';
import { runRestore } from '../commands/server.js';

export async function handleMiscButton(interaction) {
  const [group, action, arg] = interaction.customId.split(':');

  if (group === 'campaign') {
    if (!(await guardAdmin(interaction))) return true;
    if (action === 'custom') {
      const modal = new ModalBuilder().setCustomId('campaign:apply').setTitle('割引率を入力');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('rate')
            .setLabel('割引率（1〜99%）')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(2),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }
    const rate = Number(action === 'set' ? arg : 0);
    await applyCampaign(interaction, rate);
    return true;
  }

  if (group === 'stats') {
    if (action === 'history') {
      const rows = all('SELECT * FROM purchases WHERE guild_id = ? ORDER BY id DESC LIMIT 10', [interaction.guildId]);
      const embed = new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle('購入履歴（最新10件）')
        .setDescription(
          rows.length
            ? rows
                .map(
                  (row) =>
                    `#${row.id} ${row.product_name} / ${row.quantity}個 / ${yen(row.unit_price * row.quantity)} / ${row.state} / ${jstString(row.created_at)}`,
                )
                .join('\n')
            : '履歴がありません。',
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return true;
    }
    if (action === 'search') {
      const modal = new ModalBuilder().setCustomId('stats:search').setTitle('購入履歴の検索');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('product').setLabel('商品名（任意）').setStyle(TextInputStyle.Short).setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('buyer').setLabel('購入者のユーザーID（任意）').setStyle(TextInputStyle.Short).setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('state')
            .setLabel('状態（任意: pending/completed/cancelled）')
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }
    if (action === 'campaign-end') {
      if (!(await guardAdmin(interaction))) return true;
      const campaign = endCampaign(interaction.guildId);
      await refreshGuildPanels(interaction.client, interaction.guildId);
      await interaction.reply(
        ephemeral(campaign ? `キャンペーン（${campaign.rate}%OFF）を終了し、通常価格に戻しました。` : '実施中のキャンペーンはありません。'),
      );
      return true;
    }
  }

  if (group === 'server') {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return true;
    if (action === 'backup') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await createBackup(interaction.client, interaction.guild, { manual: true, actorId: interaction.user.id });
      await interaction.editReply('バックアップを作成しました。最新3個を保持します。');
      return true;
    }
    if (action === 'restore') {
      const rows = listBackups(interaction.guildId);
      if (!rows.length) {
        await interaction.reply(ephemeral('バックアップがありません。'));
        return true;
      }
      const select = new StringSelectMenuBuilder()
        .setCustomId('restore:pick')
        .setPlaceholder('復元するバックアップを選択')
        .addOptions(
          rows.map((row) => ({ label: `#${row.id} ${jstString(row.created_at)}`, value: String(row.id) })),
        );
      await interaction.reply({
        content: '復元するバックアップを選択してください（この操作は取り消せません）。',
        components: [new ActionRowBuilder().addComponents(select)],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
  }

  if (group === 'restore') {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return true;
    if (action === 'cancel') {
      await interaction.update({ content: '復元をキャンセルしました。', embeds: [], components: [] });
      return true;
    }
    if (action === 'run') {
      await runRestore(interaction, Number(arg));
      return true;
    }
  }

  if (group === 'antiraid') {
    if (!isOwner(interaction.member)) {
      await interaction.reply(ephemeral('荒らし対策の設定はサーバーオーナーのみ変更できます。'));
      return true;
    }
    const settings = getAntiraid(interaction.guildId);
    if (action === 'toggle') {
      const key = arg;
      if (!(key in settings)) return true;
      settings[key] = !settings[key];
      saveAntiraid(interaction.guildId, settings);
      await interaction.reply({
        content: `${key} を ${settings[key] ? 'ON' : 'OFF'} にしました。パネルを再表示するにはコマンドを実行してください。`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (action === 'allowed-url') {
      const modal = new ModalBuilder().setCustomId('antiraid:urls').setTitle('URL許可チャンネル');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ids')
            .setLabel('チャンネルID（カンマ区切り）')
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
      );
      await interaction.showModal(modal);
      return true;
    }
  }

  if (group === 'ticket') {
    if (action === 'create') {
      const panel = get('SELECT * FROM ticket_panels WHERE id = ? AND guild_id = ?', [Number(arg), interaction.guildId]);
      if (!panel) {
        await interaction.reply(ephemeral('チケットパネルが見つかりません。'));
        return true;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const { channel } = await createTicket(interaction.guild, panel, interaction.member);
        await interaction.editReply(`<#${channel.id}> を作成しました。`);
      } catch (error) {
        await interaction.editReply(`チケットを作成できませんでした: ${error.message}`);
      }
      return true;
    }
    if (action === 'close') {
      const ticket = get("SELECT * FROM tickets WHERE channel_id = ? AND state = 'open'", [interaction.channelId]);
      const allowed =
        isOwner(interaction.member) ||
        interaction.member.permissions.has('ManageChannels') ||
        (ticket && ticket.opener_id === interaction.user.id);
      if (!allowed) {
        await interaction.reply(ephemeral('このチケットを閉じる権限がありません。'));
        return true;
      }
      await interaction.reply({ content: 'チケットを閉じます…', flags: MessageFlags.Ephemeral });
      run("UPDATE tickets SET state = 'closed', closed_at = ? WHERE channel_id = ?", [
        new Date().toISOString(),
        interaction.channelId,
      ]);
      await logAdmin(
        interaction.client,
        interaction.guildId,
        interaction.user.id,
        'チケット削除',
        `#${interaction.channel?.name ?? interaction.channelId}`,
      );
      setTimeout(() => {
        interaction.channel?.delete('チケットを閉じました').catch(() => null);
      }, 2000);
      return true;
    }
  }

  if (group === 'verify') {
    const settings = get('SELECT * FROM verification WHERE guild_id = ?', [interaction.guildId]);
    if (!settings) {
      await interaction.reply(ephemeral('認証設定が見つかりません。'));
      return true;
    }
    if (interaction.member.roles.cache.has(settings.role_id)) {
      await interaction.reply(ephemeral('すでに認証済みです。'));
      return true;
    }
    try {
      await interaction.member.roles.add(settings.role_id, '認証');
      await interaction.reply(ephemeral('認証が完了しました。ご利用ありがとうございます！'));
    } catch (error) {
      await interaction.reply(ephemeral(`認証に失敗しました: ${error.message}`));
    }
    return true;
  }

  return false;
}

async function applyCampaign(interaction, rate) {
  if (!Number.isInteger(rate) || rate < 1 || rate > 99) {
    await interaction.reply(ephemeral('割引率は1〜99%で指定してください。'));
    return;
  }
  run("UPDATE campaigns SET active = 0, ended_at = ? WHERE guild_id = ? AND active = 1", [
    new Date().toISOString(),
    interaction.guildId,
  ]);
  run('INSERT INTO campaigns (guild_id, rate, active, started_at) VALUES (?, ?, 1, ?)', [
    interaction.guildId,
    rate,
    new Date().toISOString(),
  ]);

  const machines = all('SELECT * FROM machines WHERE guild_id = ? AND deleted_at IS NULL', [interaction.guildId]);
  for (const machine of machines) await refreshMachineById(interaction.client, machine.id);

  await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '割引キャンペーン', `${rate}%OFF`);
  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.accent)
        .setTitle('割引キャンペーンを開始しました')
        .setDescription(`全自販機の商品を **${rate}%OFF** にしました（1円未満切り捨て）。\n終了は統計パネルの「キャンペーン終了」から行えます。`),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleMiscModal(interaction) {
  const id = interaction.customId;

  if (id === 'campaign:apply') {
    if (!(await guardAdmin(interaction))) return true;
    const rate = Number(interaction.fields.getTextInputValue('rate'));
    await applyCampaign(interaction, rate);
    return true;
  }

  if (id.startsWith('stock:add:')) {
    if (!(await guardAdmin(interaction))) return true;
    const productId = Number(id.split(':')[2]);
    const product = getProduct(productId);
    if (!product) {
      await interaction.reply(ephemeral('商品が見つかりません。'));
      return true;
    }
    const lines = interaction.fields
      .getTextInputValue('lines')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) {
      await interaction.reply(ephemeral('在庫が入力されていません。'));
      return true;
    }
    for (const line of lines) {
      run('INSERT INTO stock_items (product_id, content, state, created_at) VALUES (?, ?, ?, ?)', [
        product.id,
        line,
        'available',
        new Date().toISOString(),
      ]);
    }
    // 在庫追加時は商品・自販機の販売停止を解除
    run("UPDATE products SET sale_state = 'on' WHERE id = ?", [product.id]);
    const machine = get('SELECT * FROM machines WHERE id = ?', [product.machine_id]);
    if (machine?.sale_state === 'off') run("UPDATE machines SET sale_state = 'on' WHERE id = ?", [machine.id]);
    await refreshMachineById(interaction.client, product.machine_id);

    const notify = get("SELECT enabled, channel_id FROM notify_settings WHERE guild_id = ? AND kind = 'stock_add'", [
      interaction.guildId,
    ]);
    if (notify?.enabled && notify.channel_id) {
      await sendNotification(interaction.client, interaction.guildId, 'stock_add', {
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.sub)
            .setTitle('在庫を追加しました')
            .addFields(
              { name: '商品', value: product.name, inline: true },
              { name: '追加数', value: `${lines.length}`, inline: true },
              { name: '現在在庫', value: `${stockCount(product.id)}`, inline: true },
            ),
        ],
      });
    }
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '在庫追加', `${product.name}: ${lines.length}件`);
    await interaction.reply(ephemeral(`${lines.length}件の在庫を追加しました。販売停止を解除し、パネルを更新しました。`));
    return true;
  }

  if (id === 'stats:search') {
    if (!(await guardAdmin(interaction))) return true;
    const product = interaction.fields.getTextInputValue('product')?.trim() || null;
    const buyer = interaction.fields.getTextInputValue('buyer')?.trim() || null;
    const state = interaction.fields.getTextInputValue('state')?.trim() || null;
    await interaction.reply({
      ...purchaseListPayload(interaction.guildId, { offset: 0, product, buyer, state }),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (id === 'antiraid:urls') {
    if (!isOwner(interaction.member)) {
      await interaction.reply(ephemeral('サーバーオーナーのみ変更できます。'));
      return true;
    }
    const ids = interaction.fields
      .getTextInputValue('ids')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const settings = getAntiraid(interaction.guildId);
    settings.allowedUrlChannelIds = ids;
    saveAntiraid(interaction.guildId, settings);
    await interaction.reply(ephemeral(`URL許可チャンネルを ${ids.length} 件に設定しました。`));
    return true;
  }

  return false;
}

export async function handleMiscSelect(interaction) {
  if (interaction.customId === 'restore:pick') {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return true;
    const id = Number(interaction.values[0]);
    const row = get('SELECT * FROM backups WHERE id = ? AND guild_id = ?', [id, interaction.guildId]);
    if (!row) {
      await interaction.reply(ephemeral('バックアップが見つかりません。'));
      return true;
    }
    const confirm = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`restore:run:${id}`).setLabel('復元する').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('restore:cancel').setLabel('キャンセル').setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: `バックアップ #${id}（${jstString(row.created_at)}）から復元します。よろしいですか？`,
      components: [confirm],
    });
    return true;
  }
  return false;
}

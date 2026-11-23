import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from 'discord.js';
import { ephemeral, guardAdmin } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';
import { buildPurchaseTxt } from '../services/purchaseTxt.js';
import { cancelPurchase, processPurchase, purchaseDetailEmbed } from '../services/purchase.js';
import { purchaseListPayload } from '../commands/purchases.js';
import { refreshMachineById } from '../services/panel.js';
import { get } from '../db.js';

export async function handleAplButton(interaction) {
  const [prefix, action, idRaw] = interaction.customId.split(':');
  if (prefix !== 'apl') return false;
  if (!(await guardAdmin(interaction))) return true;

  const id = Number(idRaw);
  if (!Number.isInteger(id)) {
    await interaction.reply(ephemeral('申請IDが正しくありません。'));
    return true;
  }

  if (action === 'detail') {
    const embed = await purchaseDetailEmbed(id);
    if (!embed) {
      await interaction.reply(ephemeral('申請が見つかりません。'));
      return true;
    }
    const purchase = get('SELECT * FROM purchases WHERE id = ?', [id]);
    const buttons = [];
    if (['pending', 'send_failed'].includes(purchase.state)) {
      buttons.push(
        new ButtonBuilder().setCustomId(`apl:send:${id}`).setLabel('商品送信').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`apl:cancel:${id}`).setLabel('キャンセル').setStyle(ButtonStyle.Danger),
      );
    }
    await interaction.reply({
      embeds: [embed],
      components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (action === 'txt') {
    const purchase = get('SELECT * FROM purchases WHERE id = ?', [id]);
    if (!purchase) {
      await interaction.reply(ephemeral('申請が見つかりません。'));
      return true;
    }
    await interaction.reply({
      content: `申請 #${id} のTXTです。`,
      files: [{ attachment: buildPurchaseTxt(id), name: `rip-shop-${id}.txt` }],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (action === 'send' || action === 'resend') {
    const result = await processPurchase(interaction.client, id, interaction.user.id);
    if (result.ok) {
      await interaction.editReply(
        `申請 #${id} の商品送信が完了しました。` +
          (result.roles?.failures?.length ? `\nロール付与の失敗: ${result.roles.failures.length}件` : ''),
      );
      const purchase = get('SELECT * FROM purchases WHERE id = ?', [id]);
      if (purchase?.machine_id) await refreshMachineById(interaction.client, purchase.machine_id);
    } else {
      await interaction.editReply(`送信できませんでした: ${result.reason}`);
    }
    return true;
  }

  if (action === 'cancel') {
    const result = await cancelPurchase(interaction.client, id, interaction.user.id);
    await interaction.editReply(
      result.ok ? `申請 #${id} をキャンセルしました。在庫と購入上限を戻しました。` : result.reason,
    );
    const purchase = get('SELECT * FROM purchases WHERE id = ?', [id]);
    if (purchase?.machine_id) await refreshMachineById(interaction.client, purchase.machine_id);
    return true;
  }

  if (action === 'more') {
    const { flags, ...payload } = purchaseListPayload(interaction.guildId, { offset: id });
    void flags;
    await interaction.editReply(payload);
    return true;
  }

  return true;
}

export async function handleAplSelect(interaction) {
  if (!interaction.customId.startsWith('apl:pick')) return false;
  if (!(await guardAdmin(interaction))) return true;
  const id = Number(interaction.values[0]);
  const embed = await purchaseDetailEmbed(id);
  if (!embed) {
    await interaction.reply(ephemeral('申請が見つかりません。'));
    return true;
  }
  const purchase = get('SELECT * FROM purchases WHERE id = ?', [id]);
  const buttons = [];
  if (['pending', 'send_failed'].includes(purchase.state)) {
    buttons.push(
      new ButtonBuilder().setCustomId(`apl:send:${id}`).setLabel('商品送信').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`apl:cancel:${id}`).setLabel('キャンセル').setStyle(ButtonStyle.Danger),
    );
  }
  await interaction.reply({
    embeds: [embed],
    components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [],
    flags: MessageFlags.Ephemeral,
  });
  await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '購入申請確認', `#${id}`);
  return true;
}

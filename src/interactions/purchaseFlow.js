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
import { COLORS, config } from '../config.js';
import { get } from '../db.js';
import { yen } from '../lib/format.js';
import { ephemeral } from '../lib/permissions.js';
import {
  activeCampaign,
  availability,
  getMachine,
  getProduct,
  listProducts,
  priceOf,
  remainingLimit,
  stockCount,
} from '../services/catalog.js';
import { createPurchase, sendPurchaseLog } from '../services/purchase.js';
import { refreshMachineById } from '../services/panel.js';

const PAY_LABEL = { paypay: 'PayPay', kyash: 'Kyash' };

function maxQuantity(machineGuildId, product, buyerId) {
  const stock = product.stock_mode === 'infinite' ? config.purchaseMaxQuantity : stockCount(product.id);
  const limit = product.daily_limit ? remainingLimit(product, buyerId) : Infinity;
  return Math.max(1, Math.min(config.purchaseMaxQuantity, stock, limit));
}

function buildView({ machine, product, qty, method, buyerId }) {
  const campaign = activeCampaign(machine.guild_id);
  const { original, rate, final } = priceOf(product, campaign);
  const max = maxQuantity(machine.guild_id, product, buyerId);

  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle(product.name)
    .addFields(
      {
        name: '価格',
        value: rate > 0 ? `~~${yen(original)}~~ **${yen(final)}**（${rate}%OFF）` : `**${yen(final)}**`,
        inline: true,
      },
      { name: '在庫', value: product.stock_mode === 'infinite' ? '∞' : `${stockCount(product.id)}`, inline: true },
      { name: '数量', value: `${qty} / 最大${max}`, inline: true },
      { name: '合計', value: `**${yen(final * qty)}**`, inline: true },
      { name: '決済方法', value: method ? PAY_LABEL[method] : '未選択', inline: true },
    )
    .setFooter({ text: '申請後、管理者が入金を確認して商品を送信します' });

  const qtyRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`buy:qty:${machine.id}:${product.id}:${qty}:${-1}:${method ?? 'none'}`)
      .setLabel('−')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(qty <= 1),
    new ButtonBuilder().setCustomId('buy:noop').setLabel(`${qty}個`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`buy:qty:${machine.id}:${product.id}:${qty}:${1}:${method ?? 'none'}`)
      .setLabel('＋')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(qty >= max),
  );

  const payRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`buy:pay:${machine.id}:${product.id}:${qty}`)
      .setPlaceholder('決済方法を選択')
      .addOptions(
        { label: 'PayPay', value: 'paypay' },
        { label: 'Kyash', value: 'kyash' },
      ),
  );

  const submitRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`buy:submit:${machine.id}:${product.id}:${qty}:${method ?? 'none'}`)
      .setLabel('申請する')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!method),
  );

  return { embeds: [embed], components: [qtyRow, payRow, submitRow], flags: MessageFlags.Ephemeral };
}

export async function handlePurchaseButton(interaction) {
  const parts = interaction.customId.split(':');
  const [prefix, action, machineRaw, productRaw, qtyRaw, deltaRaw] = parts;
  if (prefix !== 'buy') return false;

  if (action === 'noop') {
    await interaction.deferUpdate();
    return true;
  }

  const machine = getMachine(Number(machineRaw));
  if (!machine || machine.guild_id !== interaction.guildId) {
    await interaction.reply(ephemeral('自販機が見つかりません。'));
    return true;
  }

  const settings = get('SELECT maintenance, maintenance_message FROM guild_settings WHERE guild_id = ?', [interaction.guildId]);
  if (settings?.maintenance) {
    await interaction.reply(ephemeral(settings.maintenance_message || 'ただいまメンテナンス中です。'));
    return true;
  }

  if (action === 'start') {
    if (machine.sale_state === 'off') {
      await interaction.reply(ephemeral('この自販機は現在販売停止中です。'));
      return true;
    }
    const products = listProducts(machine.id);
    if (!products.length) {
      await interaction.reply(ephemeral('商品が登録されていません。'));
      return true;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(`buy:pick:${machine.id}`)
      .setPlaceholder('商品を選択')
      .addOptions(
        products.slice(0, 25).map((product) => {
          const state = availability(product, { buyerId: interaction.user.id });
          return {
            label: product.name.slice(0, 100),
            description: `${yen(priceOf(product, activeCampaign(machine.guild_id)).final)} / ${
              state.ok ? '購入可能' : state.reason
            }`.slice(0, 100),
            value: String(product.id),
            emoji: state.ok ? undefined : '🚫',
          };
        }),
      );
    await interaction.reply({
      embeds: [new EmbedBuilder().setColor(COLORS.main).setTitle(machine.name).setDescription('購入する商品を選択してください。')],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  if (action === 'limits') {
    const products = listProducts(machine.id).filter((product) => product.daily_limit);
    const embed = new EmbedBuilder()
      .setColor(COLORS.main)
      .setTitle('購入可能個数')
      .setDescription(
        products.length
          ? products
              .map((product) => `${product.name}: 残り **${remainingLimit(product, interaction.user.id)}** 個 / 1日${product.daily_limit}個まで`)
              .join('\n')
          : '購入上限が設定された商品はありません。',
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return true;
  }

  const product = getProduct(Number(productRaw));
  if (!product || product.machine_id !== machine.id) {
    await interaction.reply(ephemeral('商品が見つかりません。'));
    return true;
  }

  if (action === 'qty') {
    const current = Number(qtyRaw);
    const delta = Number(deltaRaw);
    const max = maxQuantity(machine.guild_id, product, interaction.user.id);
    const next = Math.min(Math.max(1, current + delta), max);
    const method = parts[6] && parts[6] !== 'none' ? parts[6] : null;
    await interaction.update(buildView({ machine, product, qty: next, method, buyerId: interaction.user.id }));
    return true;
  }

  if (action === 'submit') {
    const qty = Number(qtyRaw);
    if (!Number.isInteger(qty) || qty < 1) {
      await interaction.reply(ephemeral('購入個数が正しくありません。'));
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(`buy:link:${machine.id}:${product.id}:${qty}:${parts[5]}`)
      .setTitle('支払いリンクを入力');
    const input = new TextInputBuilder()
      .setCustomId('link')
      .setLabel('PayPay / Kyash の支払いリンク')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('https://...')
      .setRequired(true)
      .setMaxLength(500);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return true;
  }

  return false;
}

export async function handlePurchaseSelect(interaction) {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'buy') return false;

  const machine = getMachine(Number(parts[2]));
  if (!machine) {
    await interaction.reply(ephemeral('自販機が見つかりません。'));
    return true;
  }

  if (parts[1] === 'pick') {
    const product = getProduct(Number(interaction.values[0]));
    if (!product) {
      await interaction.reply(ephemeral('商品が見つかりません。'));
      return true;
    }
    const state = availability(product, { buyerId: interaction.user.id });
    if (!state.ok) {
      await interaction.reply(ephemeral(state.reason));
      return true;
    }
    await interaction.update(buildView({ machine, product, qty: 1, method: null, buyerId: interaction.user.id }));
    return true;
  }

  if (parts[1] === 'pay') {
    const product = getProduct(Number(parts[3]));
    const qty = Number(parts[4]);
    if (!product) {
      await interaction.reply(ephemeral('商品が見つかりません。'));
      return true;
    }
    await interaction.update(
      buildView({ machine, product, qty, method: interaction.values[0], buyerId: interaction.user.id }),
    );
    return true;
  }

  return false;
}

export async function handlePurchaseModal(interaction) {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'buy' || parts[1] !== 'link') return false;

  const machine = getMachine(Number(parts[2]));
  const product = getProduct(Number(parts[3]));
  const qty = Number(parts[4]);
  const method = parts[5];
  const link = interaction.fields.getTextInputValue('link').trim();

  if (!machine || !product) {
    await interaction.reply(ephemeral('自販機または商品が見つかりません。'));
    return true;
  }
  if (!/^https?:\/\//i.test(link)) {
    await interaction.reply(ephemeral('支払いリンクは http(s):// から始まるURLを入力してください。'));
    return true;
  }
  if (!['paypay', 'kyash'].includes(method)) {
    await interaction.reply(ephemeral('決済方法を選択してください。'));
    return true;
  }

  const settings = get('SELECT maintenance, maintenance_message FROM guild_settings WHERE guild_id = ?', [interaction.guildId]);
  if (settings?.maintenance) {
    await interaction.reply(ephemeral(settings.maintenance_message || 'ただいまメンテナンス中です。'));
    return true;
  }

  try {
    const purchase = createPurchase({
      guildId: interaction.guildId,
      machineId: machine.id,
      productId: product.id,
      buyerId: interaction.user.id,
      quantity: qty,
      method,
      link,
    });
    await sendPurchaseLog(interaction.client, purchase);
    await refreshMachineById(interaction.client, machine.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.sub)
          .setTitle('購入申請を送信しました')
          .setDescription(
            `申請番号: **#${purchase.id}**\n商品: ${purchase.product_name}\n数量: ${purchase.quantity}\n金額: ${yen(
              purchase.unit_price * purchase.quantity,
            )}\n\n管理者の入金確認後、商品がDMで届きます。`,
          ),
      ],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await interaction.reply(ephemeral(error.message));
  }
  return true;
}

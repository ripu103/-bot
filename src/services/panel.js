import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS } from '../config.js';
import { all } from '../db.js';
import { yen } from '../lib/format.js';
import { activeCampaign, listProducts, priceOf, saleLabel, stockCounts } from './catalog.js';

export function buildPanelEmbed(machine, products, campaign, counts) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle(machine.name)
    .setFooter({ text: '購入するボタンからお進みください' });

  if (machine.description) embed.setDescription(machine.description);
  if (machine.sale_state === 'off') {
    embed.setColor(COLORS.danger);
    embed.setDescription(`${machine.description ? `${machine.description}\n\n` : ''}**現在この自販機は販売停止中です。**`);
  }

  if (campaign?.active) {
    const notice = `🎉 全商品 ${campaign.rate}%OFF キャンペーン実施中`;
    embed.setDescription([machine.description, notice].filter(Boolean).join('\n\n'));
  }

  if (products.length === 0) {
    embed.addFields({ name: '商品', value: '商品が登録されていません。' });
    return embed;
  }

  for (const [index, product] of products.entries()) {
    const stock = product.stock_mode === 'infinite' ? Infinity : (counts.get(product.id) ?? 0);
    const { original, rate, final } = priceOf(product, campaign);
    const priceText =
      rate > 0 ? `~~${yen(original)}~~ **${yen(final)}**（${rate}%OFF）` : `**${yen(final)}**`;
    const stockText = product.stock_mode === 'infinite' ? '在庫: ∞' : `在庫: ${stock}`;
    const limitText = product.daily_limit ? ` / 1人${product.daily_limit}個まで` : '';
    embed.addFields({
      name: `${index + 1}. ${product.name}`,
      value: `${priceText} / ${stockText} / **${saleLabel(product, stock)}**${limitText}`,
    });
  }
  return embed;
}

export function buildPanelComponents(machine, products) {
  const rows = [];
  const buy = new ButtonBuilder()
    .setCustomId(`buy:start:${machine.id}`)
    .setLabel('購入する')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(machine.sale_state === 'off' || products.length === 0);

  const buttons = [buy];
  if (products.some((product) => product.daily_limit)) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`buy:limits:${machine.id}`)
        .setLabel('購入可能個数')
        .setStyle(ButtonStyle.Secondary),
    );
  }
  rows.push(new ActionRowBuilder().addComponents(buttons));
  return rows;
}

export function panelPayload(machine, products, campaign, counts) {
  return {
    embeds: [buildPanelEmbed(machine, products, campaign, counts)],
    components: buildPanelComponents(machine, products),
  };
}

/** 1台のパネルを最新化 */
export async function refreshMachineById(client, machineId, cached = null) {
  const { get } = await import('../db.js');
  const row = cached ?? get('SELECT * FROM machines WHERE id = ? AND deleted_at IS NULL', [machineId]);
  if (!row?.channel_id || !row?.message_id) return false;

  const guild = client.guilds.cache.get(row.guild_id);
  const channel = guild?.channels.cache.get(row.channel_id);
  if (!channel?.isTextBased()) return false;

  let message;
  try {
    message = await channel.messages.fetch(row.message_id);
  } catch {
    return false;
  }

  const products = listProducts(row.id);
  const payload = panelPayload(row, products, activeCampaign(row.guild_id), stockCounts(row.id));
  try {
    await message.edit(payload);
    return true;
  } catch {
    return false;
  }
}

/** サーバー内の全パネルを更新 */
export async function refreshGuildPanels(client, guildId) {
  const machines = all('SELECT * FROM machines WHERE guild_id = ? AND deleted_at IS NULL', [guildId]);
  await Promise.all(machines.map((machine) => refreshMachineById(client, machine.id, machine)));
}

/** Bot起動時に全パネルを復元・最新化 */
export async function restoreAllPanels(client) {
  const machines = all('SELECT * FROM machines WHERE deleted_at IS NULL');
  for (const machine of machines) {
    if (!machine.channel_id || !machine.message_id) continue;
    await refreshMachineById(client, machine.id, machine);
  }
}

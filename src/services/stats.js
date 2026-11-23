import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS, jstString } from '../config.js';
import { all, get, run } from '../db.js';
import { yen } from '../lib/format.js';
import { activeCampaign } from './catalog.js';

const salesFilter = "state = 'completed'";

export function summary(guildId) {
  const totals = get(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(quantity), 0) AS units,
            COALESCE(SUM(unit_price * quantity), 0) AS revenue,
            COALESCE(SUM((unit_price - COALESCE(unit_cost, 0)) * quantity), 0) AS profit
     FROM purchases WHERE guild_id = ? AND ${salesFilter}`,
    [guildId],
  );

  const machines = get(
    `SELECT COUNT(*) AS c FROM machines WHERE guild_id = ? AND deleted_at IS NULL`,
    [guildId],
  );

  const topMachines = all(
    `SELECT m.name AS name, COALESCE(SUM(p.unit_price * p.quantity), 0) AS revenue, COALESCE(SUM(p.quantity), 0) AS units
     FROM purchases p JOIN machines m ON m.id = p.machine_id
     WHERE p.guild_id = ? AND p.${salesFilter}
     GROUP BY p.machine_id ORDER BY revenue DESC LIMIT 5`,
    [guildId],
  );

  const topUnits = all(
    `SELECT m.name AS name, COALESCE(SUM(p.quantity), 0) AS units
     FROM purchases p JOIN machines m ON m.id = p.machine_id
     WHERE p.guild_id = ? AND p.${salesFilter}
     GROUP BY p.machine_id ORDER BY units DESC LIMIT 5`,
    [guildId],
  );

  const topBuyers = all(
    `SELECT buyer_id, COALESCE(SUM(unit_price * quantity), 0) AS total
     FROM purchases WHERE guild_id = ? AND ${salesFilter}
     GROUP BY buyer_id ORDER BY total DESC LIMIT 5`,
    [guildId],
  );

  return { totals, machines: machines?.c ?? 0, topMachines, topUnits, topBuyers };
}

export function statsEmbed(guildId, { historyLimit = 5 } = {}) {
  const data = summary(guildId);
  const campaign = activeCampaign(guildId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle('自販機統計')
    .addFields(
      {
        name: 'サーバー全体',
        value: [
          `累計売上: **${yen(data.totals.revenue)}**`,
          `販売数: **${data.totals.units}**`,
          `純利益: **${yen(data.totals.profit)}**`,
          `稼働自販機: **${data.machines}**`,
        ].join('\n'),
      },
      {
        name: '自販機別 累計売上 TOP5',
        value: data.topMachines.length
          ? data.topMachines.map((row, i) => `${i + 1}. ${row.name} — ${yen(row.revenue)}`).join('\n')
          : 'データなし',
      },
      {
        name: '自販機別 販売個数 TOP5',
        value: data.topUnits.length
          ? data.topUnits.map((row, i) => `${i + 1}. ${row.name} — ${row.units}個`).join('\n')
          : 'データなし',
      },
      {
        name: '購入者別 累計支出 TOP5',
        value: data.topBuyers.length
          ? data.topBuyers.map((row, i) => `${i + 1}. <@${row.buyer_id}> — ${yen(row.total)}`).join('\n')
          : 'データなし',
      },
    )
    .setFooter({ text: campaign ? `キャンペーン中: ${campaign.rate}%OFF` : '購入履歴は削除されません' });

  const history = all(
    `SELECT * FROM purchases WHERE guild_id = ? ORDER BY id DESC LIMIT ${Number(historyLimit)}`,
    [guildId],
  );
  if (history.length) {
    embed.addFields({
      name: '購入履歴（最新）',
      value: history
        .map(
          (row) =>
            `#${row.id} ${row.product_name} / ${row.quantity}個 / ${yen(row.unit_price * row.quantity)} / ${row.state} / ${jstString(row.created_at)}`,
        )
        .join('\n')
        .slice(0, 1000),
    });
  }

  if (campaign) embed.addFields({ name: 'キャンペーン', value: `${campaign.rate}%OFF 実施中（終了は下のボタン）` });
  return embed;
}

export function statsComponents(guildId) {
  const campaign = activeCampaign(guildId);
  const buttons = [
    new ButtonBuilder().setCustomId('stats:history').setLabel('過去の履歴').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('stats:search').setLabel('履歴検索').setStyle(ButtonStyle.Secondary),
  ];
  if (campaign) {
    buttons.push(
      new ButtonBuilder().setCustomId('stats:campaign-end').setLabel('キャンペーン終了').setStyle(ButtonStyle.Danger),
    );
  }
  return [new ActionRowBuilder().addComponents(buttons)];
}

export async function refreshStatsPanels(client, guildId) {
  const panel = get("SELECT * FROM panels WHERE guild_id = ? AND kind = 'statistics'", [guildId]);
  if (!panel?.channel_id || !panel?.message_id) return;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(panel.channel_id);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(panel.message_id).catch(() => null);
  if (!message) return;
  await message
    .edit({ embeds: [statsEmbed(guildId)], components: statsComponents(guildId) })
    .catch(() => null);
}

export function endCampaign(guildId) {
  const campaign = activeCampaign(guildId);
  if (!campaign) return null;
  run("UPDATE campaigns SET active = 0, ended_at = ? WHERE id = ?", [new Date().toISOString(), campaign.id]);
  return campaign;
}

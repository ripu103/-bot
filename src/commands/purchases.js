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
import { yen } from '../lib/format.js';
import { guardAdmin } from '../lib/permissions.js';
import { listPurchases, purchaseDetailEmbed } from '../services/purchase.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export function purchaseListPayload(guildId, { offset = 0, state = null, buyer = null, product = null } = {}) {
  const { rows, total } = listPurchases(guildId, { limit: 10, offset, state, buyer, product });
  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle('購入申請・購入履歴')
    .setDescription(
      rows.length
        ? `${offset + 1}〜${offset + rows.length}件 / 全${total}件\n` +
            rows
              .map(
                (row) =>
                  `#${row.id} ${row.product_name} / ${row.quantity}個 / ${yen(row.unit_price * row.quantity)} / ${row.state} / <@${row.buyer_id}> / ${jstString(row.created_at)}`,
              )
              .join('\n')
        : '該当する履歴がありません。',
    )
    .setFooter({ text: '未対応の申請のみ商品送信・キャンセルが可能です' });

  const components = [];
  if (rows.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`apl:pick:${offset}`)
      .setPlaceholder('申請を選択して詳細を表示')
      .addOptions(
        rows.slice(0, 25).map((row) => ({
          label: `#${row.id} ${row.product_name}`.slice(0, 100),
          description: `${row.state} / ${yen(row.unit_price * row.quantity)} / ${jstString(row.created_at)}`.slice(0, 100),
          value: String(row.id),
        })),
      );
    components.push(new ActionRowBuilder().addComponents(select));
  }
  if (total > offset + rows.length) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`apl:more:${offset + 10}`).setLabel('過去の履歴').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return { embeds: [embed], components, flags: MessageFlags.Ephemeral };
}

export const command = {
  data: new SlashCommandBuilder()
    .setName('購入申請確認')
    .setDescription('購入申請・購入履歴を確認します')
    .addStringOption((o) =>
      o
        .setName('状態')
        .setDescription('状態で絞り込み')
        .addChoices(
          { name: '未対応', value: 'pending' },
          { name: '送信完了', value: 'completed' },
          { name: 'キャンセル済み', value: 'cancelled' },
          { name: '送信失敗', value: 'send_failed' },
        ),
    )
    .addUserOption((o) => o.setName('購入者').setDescription('購入者で絞り込み'))
    .addStringOption((o) => o.setName('商品名').setDescription('商品名で絞り込み')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const state = interaction.options.getString('状態');
    const buyer = interaction.options.getUser('購入者')?.id ?? null;
    const product = interaction.options.getString('商品名');
    await interaction.reply(
      purchaseListPayload(interaction.guildId, { offset: 0, state, buyer, product }),
    );
  },
};

export { purchaseDetailEmbed };
export const commands = [command];

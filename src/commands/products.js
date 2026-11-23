import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS, jstString } from '../config.js';
import { all, get, run } from '../db.js';
import { stockTxt, yen } from '../lib/format.js';
import { guardAdmin } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';
import { activeCampaign, getMachine, getProduct, listMachines, listProducts, stockCount } from '../services/catalog.js';
import { refreshGuildPanels, refreshMachineById } from '../services/panel.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

function resolveProduct(interaction) {
  const product = getProduct(Number(interaction.options.getString('商品')));
  if (!product) return null;
  const machine = getMachine(product.machine_id);
  if (!machine || machine.guild_id !== interaction.guildId) return null;
  return { product, machine };
}

export const addCommand = {
  data: new SlashCommandBuilder()
    .setName('商品追加')
    .setDescription('自販機に商品を追加します')
    .addStringOption((o) => o.setName('自販機').setDescription('自販機').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('商品名').setDescription('商品名').setRequired(true).setMaxLength(80))
    .addIntegerOption((o) => o.setName('価格').setDescription('販売価格（円）').setRequired(true).setMinValue(0))
    .addIntegerOption((o) => o.setName('仕入れ額').setDescription('仕入れ額（円・任意）').setMinValue(0))
    .addStringOption((o) =>
      o
        .setName('在庫種別')
        .setDescription('在庫の種類')
        .addChoices({ name: '有限在庫', value: 'finite' }, { name: '無限在庫', value: 'infinite' }),
    )
    .addStringOption((o) => o.setName('説明').setDescription('説明').setMaxLength(200)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const machine = getMachine(Number(interaction.options.getString('自販機')));
    if (!machine || machine.guild_id !== interaction.guildId) return interaction.reply(ephemeral('自販機が見つかりません。'));

    const max = get('SELECT COALESCE(MAX(position), 0) AS p FROM products WHERE machine_id = ?', [machine.id])?.p ?? 0;
    const result = run(
      `INSERT INTO products (machine_id, name, description, price, cost_price, stock_mode, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        machine.id,
        interaction.options.getString('商品名', true),
        interaction.options.getString('説明') || null,
        interaction.options.getInteger('価格', true),
        interaction.options.getInteger('仕入れ額') ?? null,
        interaction.options.getString('在庫種別') || 'finite',
        max + 1,
        new Date().toISOString(),
      ],
    );
    await refreshMachineById(interaction.client, machine.id);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '商品追加', `${machine.name}: ${interaction.options.getString('商品名')}`);
    await interaction.reply(ephemeral(`商品を追加しました（ID: ${result.lastInsertRowid}）。\`/在庫追加\` で在庫を登録できます。`));
  },
};

export const deleteCommand = {
  data: new SlashCommandBuilder()
    .setName('商品削除')
    .setDescription('商品を削除します（販売履歴は保持）')
    .addStringOption((o) => o.setName('商品').setDescription('商品').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('確認').setDescription('「削除」と入力').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    if (interaction.options.getString('確認') !== '削除') return interaction.reply(ephemeral('確認のため「削除」と入力してください。'));
    const found = resolveProduct(interaction);
    if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));
    run('UPDATE products SET deleted_at = ? WHERE id = ?', [new Date().toISOString(), found.product.id]);
    await refreshMachineById(interaction.client, found.machine.id);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '商品削除', found.product.name);
    await interaction.reply(ephemeral(`商品「${found.product.name}」を削除しました。販売履歴は保持されています。`));
  },
};

export const editCommand = {
  data: new SlashCommandBuilder()
    .setName('商品編集')
    .setDescription('商品の情報を編集します')
    .addStringOption((o) => o.setName('商品').setDescription('商品').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('商品名').setDescription('新しい商品名').setMaxLength(80))
    .addIntegerOption((o) => o.setName('価格').setDescription('新しい販売価格').setMinValue(0))
    .addIntegerOption((o) => o.setName('仕入れ額').setDescription('新しい仕入れ額').setMinValue(0))
    .addStringOption((o) => o.setName('説明').setDescription('新しい説明').setMaxLength(200)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const found = resolveProduct(interaction);
    if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));

    const name = interaction.options.getString('商品名');
    const price = interaction.options.getInteger('価格');
    const cost = interaction.options.getInteger('仕入れ額');
    const description = interaction.options.getString('説明');
    run(
      `UPDATE products SET name = COALESCE(?, name), price = COALESCE(?, price),
       cost_price = COALESCE(?, cost_price), description = COALESCE(?, description) WHERE id = ?`,
      [name ?? null, price ?? null, cost ?? null, description, found.product.id],
    );
    await refreshMachineById(interaction.client, found.machine.id);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '商品編集', found.product.name);
    await interaction.reply(ephemeral('商品情報を更新しました。過去の利益は再計算されません。'));
  },
};

export const positionCommand = {
  data: new SlashCommandBuilder()
    .setName('商品位置変更')
    .setDescription('商品の表示順を変更します')
    .addStringOption((o) => o.setName('商品').setDescription('商品').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('位置').setDescription('表示順（1から）').setRequired(true).setMinValue(1)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const found = resolveProduct(interaction);
    if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));

    const products = listProducts(found.machine.id).filter((p) => p.id !== found.product.id);
    const target = Math.min(Math.max(1, interaction.options.getInteger('位置', true)), products.length + 1);
    products.splice(target - 1, 0, found.product);
    products.forEach((product, index) => run('UPDATE products SET position = ? WHERE id = ?', [index + 1, product.id]));
    await refreshMachineById(interaction.client, found.machine.id);
    await interaction.reply(ephemeral(`「${found.product.name}」を ${target} 番目に移動しました。`));
  },
};

export const limitCommand = {
  data: new SlashCommandBuilder()
    .setName('購入個数指定')
    .setDescription('商品ごとの1日あたり購入上限を設定します')
    .addStringOption((o) => o.setName('商品').setDescription('商品').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('上限').setDescription('1人1日の上限（0で無制限）').setRequired(true).setMinValue(0)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const found = resolveProduct(interaction);
    if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));
    const limit = interaction.options.getInteger('上限', true);
    run('UPDATE products SET daily_limit = ? WHERE id = ?', [limit > 0 ? limit : null, found.product.id]);
    await refreshMachineById(interaction.client, found.machine.id);
    await interaction.reply(
      ephemeral(limit > 0 ? `「${found.product.name}」の1日上限を ${limit} 個に設定しました。` : '購入上限を無制限にしました。'),
    );
  },
};

export const saleCommand = {
  data: new SlashCommandBuilder()
    .setName('商品販売設定')
    .setDescription('商品の販売停止・再開を設定します')
    .addStringOption((o) => o.setName('商品').setDescription('商品').setRequired(true).setAutocomplete(true))
    .addStringOption((o) =>
      o
        .setName('状態')
        .setDescription('販売状態')
        .setRequired(true)
        .addChoices({ name: '販売停止', value: 'off' }, { name: '販売再開', value: 'on' }),
    ),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const found = resolveProduct(interaction);
    if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));
    const state = interaction.options.getString('状態', true);
    run('UPDATE products SET sale_state = ? WHERE id = ?', [state, found.product.id]);
    await refreshMachineById(interaction.client, found.machine.id);
    await interaction.reply(ephemeral(state === 'off' ? '販売停止にしました。' : '販売を再開しました。'));
  },
};

export const stockAddCommand = {
  data: new SlashCommandBuilder()
    .setName('在庫追加')
    .setDescription('商品に在庫を追加します（1行につき1件）')
    .addStringOption((o) => o.setName('商品').setDescription('商品').setRequired(true).setAutocomplete(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const found = resolveProduct(interaction);
    if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));

    const modal = new ModalBuilder().setCustomId(`stock:add:${found.product.id}`).setTitle('在庫追加');
    const input = new TextInputBuilder()
      .setCustomId('lines')
      .setLabel('在庫（1行につき1件・テキストやURL）')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
  },
};

export const stockExportCommand = {
  data: new SlashCommandBuilder()
    .setName('在庫引き出し')
    .setDescription('在庫をTXTファイルで取り出します')
    .addIntegerOption((o) => o.setName('数量').setDescription('取り出す数').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('商品').setDescription('商品（未指定なら自販機全体）').setAutocomplete(true))
    .addStringOption((o) => o.setName('自販機').setDescription('自販機（商品未指定時）').setAutocomplete(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const quantity = interaction.options.getInteger('数量', true);
    const productId = interaction.options.getString('商品');
    const machineId = interaction.options.getString('自販機');

    let items = [];
    if (productId) {
      const found = resolveProduct(interaction);
      if (!found) return interaction.reply(ephemeral('商品が見つかりません。'));
      items = all(
        "SELECT * FROM stock_items WHERE product_id = ? AND state = 'available' ORDER BY id LIMIT ?",
        [found.product.id, quantity],
      );
    } else if (machineId) {
      const machine = getMachine(Number(machineId));
      if (!machine || machine.guild_id !== interaction.guildId) return interaction.reply(ephemeral('自販機が見つかりません。'));
      items = all(
        `SELECT s.* FROM stock_items s JOIN products p ON p.id = s.product_id
         WHERE p.machine_id = ? AND s.state = 'available' ORDER BY s.id LIMIT ?`,
        [machine.id, quantity],
      );
    } else {
      return interaction.reply(ephemeral('商品または自販機を指定してください。'));
    }

    if (items.length === 0) return interaction.reply(ephemeral('取り出せる在庫がありません。'));
    for (const item of items) run("UPDATE stock_items SET state = 'used' WHERE id = ?", [item.id]);

    const lines = items.map((item, index) => `${index + 1}. ${item.content}`);
    const buffer = stockTxt(lines);
    const affected = new Set(items.map((item) => item.product_id));
    for (const id of affected) {
      const product = getProduct(id);
      if (product && product.stock_mode === 'finite' && stockCount(id) === 0) {
        run("UPDATE products SET sale_state = 'off' WHERE id = ?", [id]);
      }
      await refreshMachineById(interaction.client, product.machine_id);
    }
    await interaction.reply({
      content: `${items.length}件の在庫を取り出しました。`,
      files: [{ attachment: buffer, name: `stock-${Date.now()}.txt` }],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const campaignCommand = {
  data: new SlashCommandBuilder().setName('割引キャンペーン').setDescription('全自販機の商品に割引を適用します'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('campaign:set:5').setLabel('5%').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('campaign:set:10').setLabel('10%').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('campaign:set:15').setLabel('15%').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('campaign:custom').setLabel('自由入力').setStyle(ButtonStyle.Secondary),
    );
    const embed = new EmbedBuilder()
      .setColor(COLORS.accent)
      .setTitle('割引キャンペーン')
      .setDescription('サーバー内の全自販機・全商品に適用します。\n割引率を選択してください。');
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  },
};

export const commands = [
  addCommand,
  deleteCommand,
  editCommand,
  positionCommand,
  limitCommand,
  saleCommand,
  stockAddCommand,
  stockExportCommand,
  campaignCommand,
];

export async function productAutocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const rows = all(
    `SELECT p.id, p.name, m.name AS machine_name FROM products p JOIN machines m ON m.id = p.machine_id
     WHERE m.guild_id = ? AND p.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY p.id DESC LIMIT 100`,
    [interaction.guildId],
  );
  await interaction.respond(
    rows
      .filter((row) => row.name.toLowerCase().includes(focused) || row.machine_name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((row) => ({ name: `${row.name}（${row.machine_name}）`, value: String(row.id) })),
  );
}

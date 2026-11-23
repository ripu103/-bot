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
import { yen } from '../lib/format.js';
import { guardAdmin, isOwner } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';
import { getMachine, listMachines, listProducts, activeCampaign, stockCounts } from '../services/catalog.js';
import { panelPayload, refreshMachineById } from '../services/panel.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export const createCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機作成')
    .setDescription('新しい自販機を作成します')
    .addStringOption((o) => o.setName('名前').setDescription('自販機名').setRequired(true).setMaxLength(50))
    .addStringOption((o) => o.setName('説明').setDescription('説明文').setMaxLength(200)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const name = interaction.options.getString('名前', true);
    const description = interaction.options.getString('説明') || null;
    const result = run(
      'INSERT INTO machines (guild_id, name, description, created_at) VALUES (?, ?, ?, ?)',
      [interaction.guildId, name, description, new Date().toISOString()],
    );
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '自販機作成', name);
    await interaction.reply(
      ephemeral(
        `自販機「${name}」を作成しました（ID: ${result.lastInsertRowid}）。\n` +
          '`/商品追加` で商品を登録し、`/自販機設置` でチャンネルに設置してください。',
      ),
    );
  },
};

export const installCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機設置')
    .setDescription('作成した自販機をチャンネルに設置します')
    .addStringOption((o) => o.setName('自販機').setDescription('自販機を選択').setRequired(true).setAutocomplete(true))
    .addChannelOption((o) => o.setName('チャンネル').setDescription('設置先（未指定ならこのチャンネル）')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const machine = getMachine(Number(interaction.options.getString('自販機')));
    if (!machine || machine.guild_id !== interaction.guildId) {
      return interaction.reply(ephemeral('自販機が見つかりません。'));
    }
    const channel = interaction.options.getChannel('チャンネル') ?? interaction.channel;
    if (!channel?.isTextBased()) return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));

    const products = listProducts(machine.id);
    const payload = panelPayload(machine, products, activeCampaign(machine.guild_id), stockCounts(machine.id));
    const message = await channel.send(payload);
    run('UPDATE machines SET channel_id = ?, message_id = ? WHERE id = ?', [channel.id, message.id, machine.id]);
    await interaction.reply(ephemeral(`自販機「${machine.name}」を <#${channel.id}> に設置しました。`));
  },
};

export const editCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機編集')
    .setDescription('自販機の設定を編集します')
    .addStringOption((o) => o.setName('自販機').setDescription('自販機を選択').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('名前').setDescription('新しい名前').setMaxLength(50))
    .addStringOption((o) => o.setName('説明').setDescription('新しい説明').setMaxLength(200)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const machine = getMachine(Number(interaction.options.getString('自販機')));
    if (!machine || machine.guild_id !== interaction.guildId) {
      return interaction.reply(ephemeral('自販機が見つかりません。'));
    }
    const name = interaction.options.getString('名前');
    const description = interaction.options.getString('説明');
    if (!name && description === null) return interaction.reply(ephemeral('変更する項目を指定してください。'));

    run('UPDATE machines SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?', [
      name ?? null,
      description,
      machine.id,
    ]);
    await refreshMachineById(interaction.client, machine.id);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '自販機編集', `#${machine.id}`);
    await interaction.reply(ephemeral('自販機の設定を更新しました。'));
  },
};

export const deleteCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機削除')
    .setDescription('自販機を削除します（販売履歴・統計は保持）')
    .addStringOption((o) => o.setName('自販機').setDescription('自販機を選択').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('確認').setDescription('「削除」と入力してください').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    if (interaction.options.getString('確認') !== '削除') {
      return interaction.reply(ephemeral('確認のため「削除」と入力してください。'));
    }
    const machine = getMachine(Number(interaction.options.getString('自販機')));
    if (!machine || machine.guild_id !== interaction.guildId) {
      return interaction.reply(ephemeral('自販機が見つかりません。'));
    }

    const now = new Date().toISOString();
    run('UPDATE machines SET deleted_at = ? WHERE id = ?', [now, machine.id]);
    run('UPDATE products SET deleted_at = ? WHERE machine_id = ?', [now, machine.id]);

    if (machine.channel_id && machine.message_id) {
      const channel = interaction.guild.channels.cache.get(machine.channel_id);
      const message = await channel?.messages?.fetch(machine.message_id).catch(() => null);
      await message?.delete().catch(() => null);
    }
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '自販機削除', machine.name);
    await interaction.reply(ephemeral(`自販機「${machine.name}」を削除しました。販売履歴と統計は保持されています。`));
  },
};

export const saleCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機販売設定')
    .setDescription('自販機全体の販売停止・再開を設定します')
    .addStringOption((o) => o.setName('自販機').setDescription('自販機を選択').setRequired(true).setAutocomplete(true))
    .addStringOption((o) =>
      o
        .setName('状態')
        .setDescription('販売状態')
        .setRequired(true)
        .addChoices({ name: '販売停止', value: 'off' }, { name: '販売再開', value: 'on' }),
    ),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const machine = getMachine(Number(interaction.options.getString('自販機')));
    if (!machine || machine.guild_id !== interaction.guildId) {
      return interaction.reply(ephemeral('自販機が見つかりません。'));
    }
    const state = interaction.options.getString('状態', true);
    run('UPDATE machines SET sale_state = ? WHERE id = ?', [state, machine.id]);
    await refreshMachineById(interaction.client, machine.id);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '自販機販売設定', `${machine.name}: ${state}`);
    await interaction.reply(ephemeral(state === 'off' ? '自販機を販売停止にしました。' : '自販機の販売を再開しました。'));
  },
};

export const commands = [createCommand, installCommand, editCommand, deleteCommand, saleCommand];

export async function machineAutocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const list = listMachines(interaction.guildId)
    .filter((machine) => machine.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((machine) => ({ name: `${machine.name} (ID:${machine.id})`, value: String(machine.id) }));
  await interaction.respond(list);
}

export function machineSummary(guildId) {
  return listMachines(guildId).map((machine) => ({
    ...machine,
    products: listProducts(machine.id).length,
    campaign: activeCampaign(guildId),
  }));
}

export function machineEmbed(guildId) {
  const rows = machineSummary(guildId);
  const embed = new EmbedBuilder().setColor(COLORS.main).setTitle('自販機一覧');
  if (!rows.length) return embed.setDescription('自販機がありません。`/自販機作成` で作成してください。');
  embed.setDescription(
    rows
      .map(
        (machine) =>
          `**#${machine.id} ${machine.name}**\n商品 ${machine.products}件 / ${machine.sale_state === 'off' ? '販売停止中' : '販売中'} / ${
            machine.channel_id ? `<#${machine.channel_id}>` : '未設置'
          }`,
      )
      .join('\n\n'),
  );
  return embed;
}

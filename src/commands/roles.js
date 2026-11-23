import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS } from '../config.js';
import { all, get, run } from '../db.js';
import { yen } from '../lib/format.js';
import { canManageRole, guardAdmin } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';
import { isSpecialRole, revokeRole } from '../services/roles.js';

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

export const purchaseRoleCommand = {
  data: new SlashCommandBuilder()
    .setName('自販機ロール付与')
    .setDescription('購入成功時に付与するロールを設定します')
    .addStringOption((o) =>
      o
        .setName('対象')
        .setDescription('共通ロールか商品別の特別ロールか')
        .setRequired(true)
        .addChoices({ name: '共通ロール', value: 'common' }, { name: '商品別の特別ロール', value: 'product' }),
    )
    .addRoleOption((o) => o.setName('ロール').setDescription('付与するロール').setRequired(true))
    .addStringOption((o) => o.setName('商品').setDescription('商品別の場合に指定').setAutocomplete(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const kind = interaction.options.getString('対象', true);
    const role = interaction.options.getRole('ロール', true);
    const check = canManageRole(interaction.guild, role);
    if (!check.ok) return interaction.reply(ephemeral(check.reason));

    let productId = null;
    if (kind === 'product') {
      const value = interaction.options.getString('商品');
      if (!value) return interaction.reply(ephemeral('商品別の場合は商品を指定してください。'));
      const product = get('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [Number(value)]);
      if (!product) return interaction.reply(ephemeral('商品が見つかりません。'));
      productId = product.id;
      run('DELETE FROM role_rules WHERE kind = ? AND product_id = ? AND role_id = ?', ['product', productId, role.id]);
    } else {
      run("DELETE FROM role_rules WHERE guild_id = ? AND kind = 'common'", [interaction.guildId]);
    }
    run('INSERT INTO role_rules (guild_id, kind, product_id, role_id, created_at) VALUES (?, ?, ?, ?, ?)', [
      interaction.guildId,
      kind,
      productId,
      role.id,
      new Date().toISOString(),
    ]);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '自販機ロール設定', `${kind}: ${role.name}`);
    await interaction.reply(ephemeral(`ロール「${role.name}」を購入特典として設定しました。`));
  },
};

export const revokeCommand = {
  data: new SlashCommandBuilder()
    .setName('ロール剥奪')
    .setDescription('指定したロールをメンバーから剥奪します')
    .addUserOption((o) => o.setName('メンバー').setDescription('対象メンバー').setRequired(true))
    .addRoleOption((o) => o.setName('ロール').setDescription('剥奪するロール').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const user = interaction.options.getUser('メンバー', true);
    const role = interaction.options.getRole('ロール', true);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply(ephemeral('メンバーが見つかりません。'));

    const special = isSpecialRole(interaction.guildId, role.id);
    const result = await revokeRole(interaction.client, interaction.guild, member, role, { restore: special });
    if (!result.ok) return interaction.reply(ephemeral(result.reason));

    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'ロール剥奪', `<@${member.id}>: ${role.name}`);
    await interaction.reply(
      ephemeral(
        `「${role.name}」を剥奪しました。` +
          (special ? `付与前のロールを${result.restored.length}件復元しました。` : ''),
      ),
    );
  },
};

export const grantCommand = {
  data: new SlashCommandBuilder()
    .setName('ロール付与')
    .setDescription('メンバーにロールを付与します')
    .addUserOption((o) => o.setName('メンバー').setDescription('対象メンバー').setRequired(true))
    .addRoleOption((o) => o.setName('ロール').setDescription('付与するロール').setRequired(true)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const user = interaction.options.getUser('メンバー', true);
    const role = interaction.options.getRole('ロール', true);
    const check = canManageRole(interaction.guild, role);
    if (!check.ok) return interaction.reply(ephemeral(check.reason));
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return interaction.reply(ephemeral('メンバーが見つかりません。'));
    try {
      await member.roles.add(role);
      await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'ロール付与', `<@${member.id}>: ${role.name}`);
      await interaction.reply(ephemeral(`<@${member.id}> に「${role.name}」を付与しました。`));
    } catch (error) {
      await interaction.reply(ephemeral(`付与に失敗しました: ${error.message}`));
    }
  },
};

export const bulkCommand = {
  data: new SlashCommandBuilder()
    .setName('メンバー一括ロール操作')
    .setDescription('複数メンバーのロールを一括で付与・剥奪します')
    .addRoleOption((o) => o.setName('ロール').setDescription('操作するロール').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('操作')
        .setDescription('付与か剥奪か')
        .setRequired(true)
        .addChoices({ name: '一括付与', value: 'add' }, { name: '一括剥奪', value: 'remove' }),
    )
    .addStringOption((o) =>
      o
        .setName('対象')
        .setDescription('対象範囲')
        .setRequired(true)
        .addChoices({ name: 'サーバー全員', value: 'all' }, { name: '指定ロール所持者', value: 'role' }),
    )
    .addRoleOption((o) => o.setName('対象ロール').setDescription('「指定ロール所持者」の場合に指定')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const role = interaction.options.getRole('ロール', true);
    const action = interaction.options.getString('操作', true);
    const scope = interaction.options.getString('対象', true);
    const scopeRole = interaction.options.getRole('対象ロール');

    const check = canManageRole(interaction.guild, role);
    if (!check.ok) return interaction.reply(ephemeral(check.reason));
    if (scope === 'role' && !scopeRole) return interaction.reply(ephemeral('対象ロールを指定してください。'));

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const members = await interaction.guild.members.fetch();
    const targets = members.filter(
      (member) =>
        !member.user.bot &&
        (scope === 'all' || member.roles.cache.has(scopeRole.id)) &&
        (action === 'add' ? !member.roles.cache.has(role.id) : member.roles.cache.has(role.id)),
    );

    let success = 0;
    let failed = 0;
    for (const member of targets.values()) {
      try {
        if (action === 'add') await member.roles.add(role, '一括ロール操作');
        else await member.roles.remove(role, '一括ロール操作');
        success += 1;
      } catch {
        failed += 1;
      }
    }
    await logAdmin(
      interaction.client,
      interaction.guildId,
      interaction.user.id,
      '一括ロール操作',
      `${action}: ${role.name} / 成功${success} 失敗${failed}`,
    );
    await interaction.editReply(`「${role.name}」の${action === 'add' ? '一括付与' : '一括剥奪'}が完了しました。\n成功: ${success} / 失敗: ${failed}`);
  },
};

export const commands = [purchaseRoleCommand, revokeCommand, grantCommand, bulkCommand];

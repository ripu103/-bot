import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS } from '../config.js';
import { get, run } from '../db.js';
import { ephemeral, guardAdmin, setAllowedRole } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';
import { panelPayload as ticketPanelPayload } from '../services/tickets.js';
import { applyVerificationLock, verificationPanelPayload } from '../services/verification.js';

export const verifyCommand = {
  data: new SlashCommandBuilder()
    .setName('認証')
    .setDescription('認証パネルを設置・設定します（オーナーのみ）')
    .addChannelOption((o) => o.setName('チャンネル').setDescription('認証パネルの設置先').setRequired(true))
    .addRoleOption((o) => o.setName('ロール').setDescription('認証済みロール').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('方法')
        .setDescription('認証方法')
        .addChoices({ name: 'ボタン', value: 'button' }, { name: '絵文字', value: 'emoji' }),
    )
    .addBooleanOption((o) => o.setName('閲覧制限').setDescription('認証チャンネル以外を認証前メンバーから隠す')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    const channel = interaction.options.getChannel('チャンネル', true);
    const role = interaction.options.getRole('ロール', true);
    if (!channel?.isTextBased()) return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));

    const message = await channel.send(verificationPanelPayload());
    run(
      `INSERT INTO verification (guild_id, role_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET role_id = excluded.role_id, channel_id = excluded.channel_id,
       message_id = excluded.message_id, created_at = excluded.created_at`,
      [interaction.guildId, role.id, channel.id, message.id, new Date().toISOString()],
    );

    let locked = 0;
    if (interaction.options.getBoolean('閲覧制限')) {
      locked = await applyVerificationLock(interaction.guild, channel.id);
    }
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, '認証パネル設置', `<#${channel.id}> / ${role.name}`);
    await interaction.reply(
      ephemeral(
        `<#${channel.id}> に認証パネルを設置しました。認証後 <@&${role.id}> を付与します。` +
          (locked ? `\n${locked}チャンネルの閲覧を認証前メンバーに制限しました。` : ''),
      ),
    );
  },
};

export const ticketPanelCommand = {
  data: new SlashCommandBuilder()
    .setName('チケットパネル作成')
    .setDescription('問い合わせ用チケットパネルを作成します')
    .addStringOption((o) => o.setName('パネル名').setDescription('例: お問い合わせ').setRequired(true).setMaxLength(80))
    .addChannelOption((o) => o.setName('チャンネル').setDescription('パネルの設置先').setRequired(true))
    .addChannelOption((o) => o.setName('カテゴリー').setDescription('チケットの作成先カテゴリー'))
    .addRoleOption((o) => o.setName('対応ロール').setDescription('チケットを閲覧できるロール'))
    .addStringOption((o) => o.setName('説明').setDescription('パネルの説明').setMaxLength(1000)),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const name = interaction.options.getString('パネル名', true);
    const channel = interaction.options.getChannel('チャンネル', true);
    const category = interaction.options.getChannel('カテゴリー');
    const supportRole = interaction.options.getRole('対応ロール');
    const description = interaction.options.getString('説明') || null;
    if (!channel?.isTextBased()) return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));

    const duplicated = get('SELECT * FROM ticket_panels WHERE guild_id = ? AND name = ?', [interaction.guildId, name]);
    if (duplicated) return interaction.reply(ephemeral('同じ名前のチケットパネルがすでに存在します。'));

    const result = run(
      `INSERT INTO ticket_panels (guild_id, key, name, channel_id, category_id, support_role_id, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        interaction.guildId,
        `panel-${Date.now()}`,
        name,
        channel.id,
        category?.id ?? null,
        supportRole?.id ?? null,
        description,
        new Date().toISOString(),
      ],
    );
    const panel = get('SELECT * FROM ticket_panels WHERE id = ?', [result.lastInsertRowid]);
    const message = await channel.send(ticketPanelPayload(panel));
    run('UPDATE ticket_panels SET message_id = ? WHERE id = ?', [message.id, panel.id]);

    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'チケットパネル作成', name);
    await interaction.reply(ephemeral(`<#${channel.id}> に「${name}」のチケットパネルを作成しました。`));
  },
};

const SHOP_TEMPLATE = [
  {
    name: '管理',
    channels: [{ name: '管理' }, { name: '自販機ログ' }, { name: 'bump' }],
    permissions: 'staff',
  },
  {
    name: 'お知らせ',
    channels: [{ name: 'お知らせ' }, { name: '認証' }, { name: '対応状況' }, { name: '配布キャンペーン' }],
    permissions: 'announce',
  },
  {
    name: 'コミュニティ',
    channels: [
      { name: '雑談' },
      { name: '質問', type: 'forum' },
      { name: '自由販売WTS', type: 'forum' },
      { name: '自由販売WTB', type: 'forum' },
    ],
    permissions: 'public',
  },
  {
    name: '代行依頼',
    channels: [{ name: 'お問い合わせ' }, { name: '代行①' }, { name: '代行②' }, { name: '代行③' }],
    permissions: 'support',
  },
  {
    name: '自販機',
    channels: [{ name: '自販機①' }, { name: '自販機②' }, { name: '自販機③' }, { name: '自販機④' }, { name: '自販機⑤' }],
    permissions: 'shop',
  },
  {
    name: '入退室',
    channels: [{ name: '入退室ログ' }, { name: '処罰室' }],
    permissions: 'hidden',
  },
];

const SHOP_ROLES = [
  { name: '鯖主', color: 0xddf2ff, permissions: [PermissionsBitField.Flags.Administrator] },
  {
    name: 'モデレーター',
    color: 0xe4f3c9,
    permissions: [
      PermissionsBitField.Flags.ManageMessages,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.ViewAuditLog,
    ],
  },
  { name: 'ボット', color: 0x9aa7b3, permissions: [] },
  { name: 'VIP', color: 0xf8dde7, permissions: [] },
  { name: 'メンバー', color: 0xffffff, permissions: [] },
  { name: '処罰', color: 0x5a5a5a, permissions: [] },
];

function categoryOverwrites(kind, guild, roles) {
  const everyone = { id: guild.id };
  const staff = [roles.get('鯖主'), roles.get('モデレーター')].filter(Boolean).map((role) => role.id);
  const botRole = roles.get('ボット')?.id ?? guild.members.me?.roles.botRole?.id;

  const allow = (ids, perms) => ids.map((id) => ({ id, allow: perms }));
  const allowEveryone = (perms) => [{ id: guild.id, allow: perms }];

  switch (kind) {
    case 'staff':
      return [
        { ...everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        ...allow(staff, [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]),
        ...(botRole ? [{ id: botRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : []),
      ];
    case 'announce':
      return [
        ...allowEveryone([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]),
        { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages] },
        ...allow(staff, [PermissionsBitField.Flags.SendMessages]),
      ];
    case 'public':
      return [
        ...allowEveryone([
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.CreatePublicThreads,
          PermissionsBitField.Flags.SendMessagesInThreads,
        ]),
      ];
    case 'support':
      return [
        ...allowEveryone([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]),
        { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages] },
        ...allow(staff, [PermissionsBitField.Flags.SendMessages]),
      ];
    case 'shop':
      return [
        ...allowEveryone([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory]),
        { id: guild.id, deny: [PermissionsBitField.Flags.SendMessages] },
        ...allow(staff, [PermissionsBitField.Flags.SendMessages]),
      ];
    case 'hidden':
    default:
      return [{ ...everyone, deny: [PermissionsBitField.Flags.ViewChannel] }, ...allow(staff, [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])];
  }
}

export const shopTemplateCommand = {
  data: new SlashCommandBuilder()
    .setName('shopチャンネル作成')
    .setDescription('SHOP用のカテゴリー・チャンネル・ロールを一括作成します（オーナーのみ）'),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guild = interaction.guild;
    const failures = [];
    const roles = new Map();
    let createdRoles = 0;
    let createdCategories = 0;
    let createdChannels = 0;

    // ロール（下位から作成し、最後に鯖主を最上位へ）
    for (const data of [...SHOP_ROLES].reverse()) {
      let role = guild.roles.cache.find((r) => r.name === data.name);
      if (!role) {
        try {
          role = await guild.roles.create({
            name: data.name,
            color: data.color,
            permissions: data.permissions,
            reason: 'SHOPテンプレート',
          });
          createdRoles += 1;
        } catch (error) {
          failures.push(`ロール「${data.name}」: ${error.message}`);
          continue;
        }
      }
      roles.set(data.name, role);
    }

    const ownerRole = roles.get('鯖主');
    if (ownerRole) {
      setAllowedRole(guild.id, ownerRole.id);
      await ownerRole.setPosition(guild.roles.cache.size - 1).catch(() => null);
      // 初期設定後もオーナーが操作できるよう、鯖主ロールを付与する
      const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
      await owner?.roles.add(ownerRole, 'SHOPテンプレート初期設定').catch(() => null);
    }

    for (const categoryData of SHOP_TEMPLATE) {
      let category = guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name === categoryData.name,
      );
      try {
        if (!category) {
          category = await guild.channels.create({
            name: categoryData.name,
            type: ChannelType.GuildCategory,
            permissionOverwrites: categoryOverwrites(categoryData.permissions, guild, roles),
            reason: 'SHOPテンプレート',
          });
          createdCategories += 1;
        }
      } catch (error) {
        failures.push(`カテゴリー「${categoryData.name}」: ${error.message}`);
        continue;
      }

      for (const channelData of categoryData.channels) {
        const type = channelData.type === 'forum' ? ChannelType.GuildForum : ChannelType.GuildText;
        const exists = guild.channels.cache.find(
          (c) => c.name === channelData.name && c.parentId === category.id,
        );
        if (exists) continue;
        try {
          await guild.channels.create({
            name: channelData.name,
            type,
            parent: category.id,
            reason: 'SHOPテンプレート',
          });
          createdChannels += 1;
        } catch (error) {
          failures.push(`チャンネル「${channelData.name}」: ${error.message}`);
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor(failures.length ? COLORS.warn : COLORS.sub)
      .setTitle('SHOPチャンネル作成 完了')
      .setDescription(
        [
          `ロール: ${createdRoles}件作成`,
          `カテゴリー: ${createdCategories}件作成`,
          `チャンネル: ${createdChannels}件作成`,
          ownerRole ? `許可ロール（鯖主）: <@&${ownerRole.id}> を登録しました` : '許可ロールを登録できませんでした',
          failures.length ? `\n失敗 ${failures.length}件:\n${failures.slice(0, 15).join('\n')}` : '',
        ].join('\n'),
      );

    await logAdmin(
      interaction.client,
      guild.id,
      interaction.user.id,
      'SHOPチャンネル作成',
      `ロール${createdRoles} / カテゴリー${createdCategories} / チャンネル${createdChannels} / 失敗${failures.length}`,
    );
    await interaction.editReply({ embeds: [embed] });
  },
};

export const commands = [verifyCommand, ticketPanelCommand, shopTemplateCommand];

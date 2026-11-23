import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS } from '../config.js';
import { get, run } from '../db.js';
import { canManageMember, ephemeral, guardAdmin, isOwner } from '../lib/permissions.js';
import { logAdmin } from '../lib/logger.js';
import { lockdownGuild, unlockGuild } from '../services/lockdown.js';

const DURATIONS = {
  '24時間': 24 * 60 * 60 * 1000,
  '3日': 3 * 24 * 60 * 60 * 1000,
  '7日': 7 * 24 * 60 * 60 * 1000,
};

export const memberCommand = {
  data: new SlashCommandBuilder()
    .setName('メンバー管理')
    .setDescription('メンバーのキック・BAN・タイムアウトなどを実行します')
    .addUserOption((o) => o.setName('メンバー').setDescription('対象メンバー').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('操作')
        .setDescription('実行する操作')
        .setRequired(true)
        .addChoices(
          { name: 'キック', value: 'kick' },
          { name: 'BAN', value: 'ban' },
          { name: 'BAN解除', value: 'unban' },
          { name: 'タイムアウト', value: 'timeout' },
          { name: 'タイムアウト解除', value: 'untimeout' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('期間')
        .setDescription('タイムアウト期間')
        .addChoices({ name: '24時間', value: '24時間' }, { name: '3日', value: '3日' }, { name: '7日', value: '7日' }),
    )
    .addStringOption((o) => o.setName('理由').setDescription('理由')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const user = interaction.options.getUser('メンバー', true);
    const action = interaction.options.getString('操作', true);
    const reason = interaction.options.getString('理由') || '管理コマンド';
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (action === 'unban') {
        await interaction.guild.members.unban(user.id, reason);
        await interaction.editReply(`${user.tag} のBANを解除しました。`);
      } else {
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply('メンバーが見つかりません。');
        const check = canManageMember(interaction.guild, member);
        if (!check.ok) return interaction.editReply(check.reason);

        if (action === 'kick') {
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
            return interaction.editReply('Botに「メンバーをキック」権限がありません。');
          }
          await member.kick(reason);
          await interaction.editReply(`${user.tag} をキックしました。`);
        } else if (action === 'ban') {
          if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) {
            return interaction.editReply('Botに「メンバーをBAN」権限がありません。');
          }
          await member.ban({ reason });
          await interaction.editReply(`${user.tag} をBANしました。`);
        } else if (action === 'timeout') {
          const label = interaction.options.getString('期間') || '24時間';
          await member.timeout(DURATIONS[label], reason);
          await interaction.editReply(`${user.tag} を${label}のタイムアウトにしました。`);
        } else if (action === 'untimeout') {
          await member.timeout(null, reason);
          await interaction.editReply(`${user.tag} のタイムアウトを解除しました。`);
        }
      }
      await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'メンバー管理', `${action}: ${user.tag}`);
    } catch (error) {
      await interaction.editReply(`実行できませんでした: ${error.message}`);
      await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'メンバー管理失敗', `${action}: ${user.tag} / ${error.message}`);
    }
  },
};

export const lockCommand = {
  data: new SlashCommandBuilder()
    .setName('チャンネルロック')
    .setDescription('チャンネルをロックし、一般メンバーの投稿を止めます')
    .addChannelOption((o) => o.setName('チャンネル').setDescription('対象（未指定ならこのチャンネル）'))
    .addStringOption((o) => o.setName('理由').setDescription('理由')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル') ?? interaction.channel;
    if (!channel?.isTextBased?.() && channel?.type !== ChannelType.GuildForum) {
      return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));
    }
    if (!channel.manageable) return interaction.reply(ephemeral('Botがこのチャンネルを管理できません。'));

    const everyone = channel.permissionOverwrites?.cache.get(interaction.guildId);
    run(
      `INSERT INTO channel_locks (channel_id, guild_id, allow_json, deny_json, locked_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO NOTHING`,
      [
        channel.id,
        interaction.guildId,
        everyone ? everyone.allow.bitfield.toString() : null,
        everyone ? everyone.deny.bitfield.toString() : null,
        interaction.user.id,
        new Date().toISOString(),
      ],
    );
    await channel.permissionOverwrites.edit(
      interaction.guildId,
      { SendMessages: false, AddReactions: false, CreatePublicThreads: false, CreatePrivateThreads: false },
      { reason: `チャンネルロック by ${interaction.user.tag}` },
    );
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'チャンネルロック', `<#${channel.id}>`);
    await interaction.reply({ content: `<#${channel.id}> をロックしました。`, flags: MessageFlags.Ephemeral });
  },
};

export const unlockCommand = {
  data: new SlashCommandBuilder()
    .setName('チャンネルロック解除')
    .setDescription('チャンネルのロックを解除します')
    .addChannelOption((o) => o.setName('チャンネル').setDescription('対象（未指定ならこのチャンネル）')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル') ?? interaction.channel;
    const lock = get('SELECT * FROM channel_locks WHERE channel_id = ?', [channel.id]);
    if (!channel.manageable) return interaction.reply(ephemeral('Botがこのチャンネルを管理できません。'));

    try {
      if (!lock || (lock.allow_json === null && lock.deny_json === null)) {
        await channel.permissionOverwrites.delete(interaction.guildId, 'チャンネルロック解除');
      } else {
        await channel.permissionOverwrites.edit(
          interaction.guildId,
          {
            allow: BigInt(lock.allow_json ?? '0'),
            deny: BigInt(lock.deny_json ?? '0'),
          },
          { reason: 'チャンネルロック解除' },
        );
      }
      run('DELETE FROM channel_locks WHERE channel_id = ?', [channel.id]);
      await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'チャンネルロック解除', `<#${channel.id}>`);
      await interaction.reply({ content: `<#${channel.id}> のロックを解除しました。`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      await interaction.reply(ephemeral(`解除できませんでした: ${error.message}`));
    }
  },
};

export const createChannelCommand = {
  data: new SlashCommandBuilder()
    .setName('チャンネル作成')
    .setDescription('チャンネルを作成します')
    .addStringOption((o) => o.setName('名前').setDescription('チャンネル名').setRequired(true).setMaxLength(100))
    .addStringOption((o) =>
      o
        .setName('種類')
        .setDescription('種類')
        .addChoices(
          { name: 'テキスト', value: 'text' },
          { name: 'ボイス', value: 'voice' },
          { name: 'フォーラム', value: 'forum' },
          { name: 'カテゴリー', value: 'category' },
        ),
    )
    .addChannelOption((o) => o.setName('カテゴリー').setDescription('親カテゴリー'))
    .addBooleanOption((o) => o.setName('非公開').setDescription('一般メンバーから見えないようにする')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const typeMap = {
      text: ChannelType.GuildText,
      voice: ChannelType.GuildVoice,
      forum: ChannelType.GuildForum,
      category: ChannelType.GuildCategory,
    };
    const type = typeMap[interaction.options.getString('種類') || 'text'];
    const parent = interaction.options.getChannel('カテゴリー');
    const isPrivate = interaction.options.getBoolean('非公開') ?? false;

    try {
      const channel = await interaction.guild.channels.create({
        name: interaction.options.getString('名前', true),
        type,
        parent: parent?.id,
        permissionOverwrites: isPrivate
          ? [{ id: interaction.guildId, deny: [PermissionsBitField.Flags.ViewChannel] }]
          : undefined,
      });
      await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'チャンネル作成', channel.name);
      await interaction.reply({ content: `<#${channel.id}> を作成しました。`, flags: MessageFlags.Ephemeral });
    } catch (error) {
      await interaction.reply(ephemeral(`作成できませんでした: ${error.message}`));
    }
  },
};

export const nukeCommand = {
  data: new SlashCommandBuilder()
    .setName('nuke')
    .setDescription('チャンネルを再生成します（メッセージは消去されます）')
    .addStringOption((o) => o.setName('確認').setDescription('チャンネル名を入力してください').setRequired(true))
    .addChannelOption((o) => o.setName('チャンネル').setDescription('対象（未指定ならこのチャンネル）')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction))) return;
    const channel = interaction.options.getChannel('チャンネル') ?? interaction.channel;
    if (!channel?.isTextBased?.()) return interaction.reply(ephemeral('テキストチャンネルを指定してください。'));
    if (interaction.options.getString('確認', true) !== channel.name) {
      return interaction.reply(ephemeral(`確認のためチャンネル名「${channel.name}」を入力してください。`));
    }
    await interaction.reply({ content: 'チャンネルを再生成しています…', flags: MessageFlags.Ephemeral });
    const position = channel.position;
    const parent = channel.parent;
    const cloned = await channel.clone({ reason: `nuke by ${interaction.user.tag}` });
    await cloned.setPosition(position).catch(() => null);
    if (parent) await cloned.setParent(parent.id, { lockPermissions: false }).catch(() => null);
    await channel.delete(`nuke by ${interaction.user.tag}`);
    await logAdmin(interaction.client, interaction.guildId, interaction.user.id, 'nuke', `#${channel.name}`);
  },
};

export const lockdownCommand = {
  data: new SlashCommandBuilder()
    .setName('ロックダウン')
    .setDescription('サーバー全体を一時ロックします（オーナーのみ）')
    .addIntegerOption((o) => o.setName('分').setDescription('自動解除までの分数').setRequired(true).setMinValue(1).setMaxValue(1440))
    .addStringOption((o) => o.setName('理由').setDescription('理由')),
  async execute(interaction) {
    if (!(await guardAdmin(interaction, { ownerOnly: true }))) return;
    const minutes = interaction.options.getInteger('分', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await lockdownGuild(interaction.client, interaction.guild, minutes, interaction.user.id);
    await interaction.editReply(
      `${result.changed} チャンネルをロックしました。${minutes}分後に自動解除されます。\n` +
        '※Discordの権限仕様上、管理者権限を持つメンバーは投稿できます。',
    );
  },
};

export const commands = [
  memberCommand,
  lockCommand,
  unlockCommand,
  createChannelCommand,
  nukeCommand,
  lockdownCommand,
];

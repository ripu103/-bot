import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';
import { COLORS } from '../config.js';
import { all, get, run } from '../db.js';

export function nextTicketNumber(guildId) {
  const row = get('SELECT MAX(number) AS n FROM tickets WHERE guild_id = ?', [guildId]);
  return (row?.n ?? 0) + 1;
}

export function ticketName(number) {
  return `ticket-${String(number).padStart(3, '0')}`;
}

export async function createTicket(guild, panel, member) {
  const number = nextTicketNumber(guild.id);
  const name = ticketName(number);
  const category = panel.category_id ? guild.channels.cache.get(panel.category_id) : null;
  const supportRole = panel.support_role_id ? guild.roles.cache.get(panel.support_role_id) : null;

  const overwrites = [
    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    {
      id: member.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.AttachFiles,
      ],
    },
  ];
  if (supportRole) {
    overwrites.push({
      id: supportRole.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ReadMessageHistory,
        PermissionsBitField.Flags.ManageChannels,
      ],
    });
  }
  if (guild.members.me) {
    overwrites.push({
      id: guild.members.me.id,
      allow: [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.ReadMessageHistory,
      ],
    });
  }

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category?.id,
    permissionOverwrites: overwrites,
    reason: `チケット作成: ${panel.name}`,
  });

  run(
    'INSERT INTO tickets (guild_id, panel_key, number, channel_id, opener_id, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [guild.id, panel.key, number, channel.id, member.id, 'open', new Date().toISOString()],
  );

  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle(`${panel.name}（${name}）`)
    .setDescription(
      [panel.description, '', `作成者: <@${member.id}>`, '要件を記載してください。閉じる場合は下のボタンを押してください。']
        .filter(Boolean)
        .join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('閉じる').setStyle(ButtonStyle.Danger),
  );

  await channel.send({ content: `<@${member.id}>`, embeds: [embed], components: [row] });
  return { channel, number };
}

export async function closeTicket(channelId) {
  const row = get('SELECT * FROM tickets WHERE channel_id = ? AND state = ?', [channelId, 'open']);
  if (row) run("UPDATE tickets SET state = 'closed', closed_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
}

export function openTicketByChannel(channelId) {
  return get("SELECT * FROM tickets WHERE channel_id = ? AND state = 'open'", [channelId]);
}

export function listTicketPanels(guildId) {
  return all('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY id', [guildId]);
}

export function panelPayload(panel) {
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.main)
        .setTitle(panel.name)
        .setDescription(panel.description || 'お問い合わせは下のボタンからチケットを作成してください。'),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ticket:create:${panel.id}`).setLabel('チケットを作成').setStyle(ButtonStyle.Primary),
      ),
    ],
  };
}

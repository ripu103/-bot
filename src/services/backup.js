import { ChannelType, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import { logAdmin } from '../lib/logger.js';

export function serializeGuild(guild) {
  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
    }));

  const channels = guild.channels.cache.map((channel) => ({
    name: channel.name,
    type: channel.type,
    parentName: channel.parent?.name ?? null,
    position: channel.position ?? 0,
    topic: 'topic' in channel ? channel.topic : null,
    nsfw: 'nsfw' in channel ? channel.nsfw : false,
    rateLimitPerUser: 'rateLimitPerUser' in channel ? channel.rateLimitPerUser : null,
  }));

  const members = guild.members.cache
    .filter((member) => !member.user.bot)
    .map((member) => ({
      id: member.id,
      roles: member.roles.cache.filter((role) => role.id !== guild.id).map((role) => role.name),
    }));

  return { guildId: guild.id, guildName: guild.name, roles, channels, members, createdAt: new Date().toISOString() };
}

export async function createBackup(client, guild, { manual = false, actorId = null } = {}) {
  const payload = serializeGuild(guild);
  run('INSERT INTO backups (guild_id, payload, created_at) VALUES (?, ?, ?)', [
    guild.id,
    JSON.stringify(payload),
    new Date().toISOString(),
  ]);

  const rows = all('SELECT id FROM backups WHERE guild_id = ? ORDER BY id DESC', [guild.id]);
  for (const row of rows.slice(config.keepBackups)) run('DELETE FROM backups WHERE id = ?', [row.id]);

  const owner = await guild.fetchOwner().catch(() => null);
  await owner
    ?.send(
      manual
        ? `バックアップを作成しました（${guild.name}）`
        : `定期バックアップを作成しました（${guild.name}・${config.autoBackupDays}日ごと）`,
    )
    .catch(() => null);

  if (manual) await logAdmin(client, guild.id, actorId, 'バックアップ作成', `${payload.channels.length}チャンネル`);
  return payload;
}

export function lastBackupAt(guildId) {
  return get('SELECT created_at FROM backups WHERE guild_id = ? ORDER BY id DESC LIMIT 1', [guildId])?.created_at ?? null;
}

export function listBackups(guildId) {
  return all('SELECT id, created_at FROM backups WHERE guild_id = ? ORDER BY id DESC', [guildId]);
}

export async function restoreBackup(client, guild, backupId, actorId) {
  const row = get('SELECT * FROM backups WHERE id = ? AND guild_id = ?', [backupId, guild.id]);
  if (!row) return { ok: false, reason: 'バックアップが見つかりません。' };

  const payload = JSON.parse(row.payload);
  const failures = [];
  const botHighest = guild.members.me.roles.highest.position;
  const keepChannelId = guild.systemChannelId ?? null;

  const currentRoles = new Map(guild.roles.cache.map((role) => [role.name, role]));
  for (const roleData of payload.roles) {
    const existing = currentRoles.get(roleData.name);
    const permissions = new PermissionsBitField(BigInt(roleData.permissions));
    try {
      if (existing) {
        if (existing.position < botHighest) {
          await existing.edit({
            color: roleData.color,
            hoist: roleData.hoist,
            mentionable: roleData.mentionable,
            permissions,
          });
        }
      } else {
        await guild.roles.create({ ...roleData, permissions, reason: `リストア by ${actorId}` });
      }
    } catch (error) {
      failures.push(`ロール「${roleData.name}」: ${error.message}`);
    }
  }

  const backupRoleNames = new Set(payload.roles.map((role) => role.name));
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id || role.managed || role.position >= botHighest) continue;
    if (backupRoleNames.has(role.name)) continue;
    try {
      await role.delete(`リストア（バックアップに存在しないロール） by ${actorId}`);
    } catch (error) {
      failures.push(`ロール削除「${role.name}」: ${error.message}`);
    }
  }

  const channelKey = (name, type) => `${name}::${type}`;
  const currentChannels = new Map(guild.channels.cache.map((channel) => [channelKey(channel.name, channel.type), channel]));
  const parentMap = new Map();

  for (const data of payload.channels.filter((c) => c.type === ChannelType.GuildCategory)) {
    try {
      const existing = currentChannels.get(channelKey(data.name, data.type));
      const category =
        existing ??
        (await guild.channels.create({
          name: data.name,
          type: ChannelType.GuildCategory,
          reason: `リストア by ${actorId}`,
        }));
      parentMap.set(data.name, category.id);
    } catch (error) {
      failures.push(`カテゴリー「${data.name}」: ${error.message}`);
    }
  }

  for (const data of payload.channels.filter((c) => c.type !== ChannelType.GuildCategory)) {
    if (currentChannels.get(channelKey(data.name, data.type))) continue;
    try {
      await guild.channels.create({
        name: data.name,
        type: data.type,
        parent: data.parentName ? parentMap.get(data.parentName) : undefined,
        topic: data.topic ?? undefined,
        nsfw: data.nsfw,
        rateLimitPerUser: data.rateLimitPerUser ?? undefined,
        reason: `リストア by ${actorId}`,
      });
    } catch (error) {
      failures.push(`チャンネル「${data.name}」: ${error.message}`);
    }
  }

  const backupKeys = new Set(payload.channels.map((channel) => channelKey(channel.name, channel.type)));
  for (const channel of guild.channels.cache.values()) {
    if (channel.id === keepChannelId) continue;
    if (backupKeys.has(channelKey(channel.name, channel.type))) continue;
    try {
      await channel.delete(`リストア（バックアップに存在しないチャンネル） by ${actorId}`);
    } catch (error) {
      failures.push(`チャンネル削除「${channel.name}」: ${error.message}`);
    }
  }

  for (const memberData of payload.members) {
    const member = await guild.members.fetch(memberData.id).catch(() => null);
    if (!member) continue;
    const desired = memberData.roles
      .map((name) => guild.roles.cache.find((role) => role.name === name))
      .filter((role) => role && !role.managed && role.position < botHighest);
    try {
      await member.roles.set(desired, `リストア by ${actorId}`);
    } catch (error) {
      failures.push(`メンバー「${member.user.tag}」: ${error.message}`);
    }
  }

  const owner = await guild.fetchOwner().catch(() => null);
  await owner
    ?.send(
      failures.length
        ? `リストアが完了しました（失敗 ${failures.length}件）\n\n${failures.slice(0, 20).join('\n')}`
        : 'リストアが完了しました（失敗なし）',
    )
    .catch(() => null);

  await logAdmin(client, guild.id, actorId, 'リストア', failures.length ? `失敗 ${failures.length}件` : '成功');
  return { ok: true, failures };
}

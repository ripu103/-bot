import { PermissionsBitField } from 'discord.js';
import { all, get, run } from '../db.js';
import { logAdmin } from '../lib/logger.js';

/** サーバー全体をロック（@everyone の送信権限を剥奪し、元の状態を保存） */
export async function lockdownGuild(client, guild, minutes, actorId) {
  const snapshot = [];
  for (const channel of guild.channels.cache.values()) {
    if (!channel.isTextBased?.() && channel.type !== 4) continue;
    if (!('permissionOverwrites' in channel)) continue;
    const everyone = channel.permissionOverwrites?.cache.get(guild.id);
    snapshot.push({
      channelId: channel.id,
      allow: everyone ? everyone.allow.bitfield.toString() : null,
      deny: everyone ? everyone.deny.bitfield.toString() : null,
    });
  }

  const lockedUntil = new Date(Date.now() + minutes * 60_000).toISOString();
  run(
    `INSERT INTO lockdown (guild_id, locked_until, snapshot_json, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET locked_until = excluded.locked_until, snapshot_json = excluded.snapshot_json, created_at = excluded.created_at`,
    [guild.id, lockedUntil, JSON.stringify(snapshot), new Date().toISOString()],
  );

  let changed = 0;
  for (const channel of guild.channels.cache.values()) {
    if (!('permissionOverwrites' in channel) || !channel.manageable) continue;
    try {
      await channel.permissionOverwrites.edit(
        guild.id,
        { SendMessages: false, AddReactions: false, CreatePublicThreads: false, CreatePrivateThreads: false },
        { reason: 'ロックダウン' },
      );
      changed += 1;
    } catch {
      /* 権限不足のチャンネルはスキップ */
    }
  }

  await logAdmin(client, guild.id, actorId, 'ロックダウン', `${minutes}分 / ${changed}チャンネル`);
  return { changed, lockedUntil };
}

export async function unlockGuild(client, guildId) {
  const row = get('SELECT * FROM lockdown WHERE guild_id = ?', [guildId]);
  if (!row) return 0;
  const guild = client.guilds.cache.get(guildId);
  const snapshot = JSON.parse(row.snapshot_json || '[]');
  let changed = 0;

  if (guild) {
    for (const entry of snapshot) {
      const channel = guild.channels.cache.get(entry.channelId);
      if (!channel || !('permissionOverwrites' in channel)) continue;
      try {
        if (entry.allow === null && entry.deny === null) {
          await channel.permissionOverwrites.delete(guild.id, 'ロックダウン解除');
        } else {
          await channel.permissionOverwrites.edit(
            guild.id,
            {
              allow: BigInt(entry.allow ?? '0'),
              deny: BigInt(entry.deny ?? '0'),
            },
            { reason: 'ロックダウン解除' },
          );
        }
        changed += 1;
      } catch {
        /* ignore */
      }
    }
  }

  run('DELETE FROM lockdown WHERE guild_id = ?', [guildId]);
  return changed;
}

export function isLockedDown(guildId) {
  return Boolean(get('SELECT * FROM lockdown WHERE guild_id = ?', [guildId]));
}

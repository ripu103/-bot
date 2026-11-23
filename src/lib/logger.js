import { EmbedBuilder } from 'discord.js';
import { COLORS, jstString } from '../config.js';
import { all, get, run } from '../db.js';

const KEEP_LOGS = 10;

/** 管理ログをDBに保存（最新10件のみ保持）し、設定チャンネルへも送信 */
export async function logAdmin(client, guildId, actorId, action, detail = '') {
  const createdAt = new Date().toISOString();
  run('INSERT INTO admin_logs (guild_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)', [
    guildId,
    actorId ?? null,
    action,
    detail,
    createdAt,
  ]);

  const rows = all('SELECT id FROM admin_logs WHERE guild_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [
    guildId,
    KEEP_LOGS,
    KEEP_LOGS,
  ]);
  for (const row of rows) run('DELETE FROM admin_logs WHERE id = ?', [row.id]);

  const setting = get('SELECT channel_id, enabled FROM notify_settings WHERE guild_id = ? AND kind = ?', [
    guildId,
    'management',
  ]);
  if (!setting?.enabled || !setting.channel_id) return;

  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(setting.channel_id);
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(COLORS.text)
    .setTitle('管理ログ')
    .addFields(
      { name: '操作', value: action, inline: true },
      { name: '実行者', value: actorId ? `<@${actorId}>` : '—', inline: true },
      { name: '日時', value: jstString(createdAt), inline: true },
    )
    .setTimestamp(new Date(createdAt));

  if (detail) embed.setDescription(detail.slice(0, 2000));

  try {
    await channel.send({ embeds: [embed] });
  } catch {
    /* 通知失敗はDBのログで担保 */
  }
}

export async function recentAdminLogs(guildId) {
  return all('SELECT * FROM admin_logs WHERE guild_id = ? ORDER BY id DESC LIMIT ?', [guildId, KEEP_LOGS]);
}

/** 通知設定を取得 */
export async function notifyChannel(client, guildId, kind) {
  const setting = get('SELECT channel_id, enabled, extra FROM notify_settings WHERE guild_id = ? AND kind = ?', [
    guildId,
    kind,
  ]);
  if (!setting?.enabled || !setting.channel_id) return null;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(setting.channel_id);
  return channel?.isTextBased() ? channel : null;
}

export async function sendNotification(client, guildId, kind, payload) {
  const channel = await notifyChannel(client, guildId, kind);
  if (!channel) return null;
  try {
    return await channel.send(payload);
  } catch {
    return null;
  }
}

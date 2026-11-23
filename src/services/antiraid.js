import { PermissionsBitField } from 'discord.js';
import { get, run } from '../db.js';

export const DEFAULT_ANTIRAID = {
  enabled: false,
  urlBlock: true,
  inviteBlock: true,
  commandBlock: false,
  spamBlock: true,
  newAccountBlock: true,
  spamCount: 5,
  spamWindowSec: 10,
  spamTimeoutMin: 10,
  minAccountAgeDays: 7,
  newAccountTimeoutMin: 10,
  allowedUrlChannelIds: [],
  exemptUserIds: [],
  detailed: false,
};

export function getAntiraid(guildId) {
  const row = get('SELECT * FROM antiraid WHERE guild_id = ?', [guildId]);
  if (!row) return { ...DEFAULT_ANTIRAID };
  return { ...DEFAULT_ANTIRAID, ...JSON.parse(row.config_json || '{}'), enabled: Boolean(row.enabled) };
}

export function saveAntiraid(guildId, settings) {
  const enabled = settings.enabled ? 1 : 0;
  const json = JSON.stringify(settings);
  run(
    `INSERT INTO antiraid (guild_id, enabled, config_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    [guildId, enabled, json, new Date().toISOString()],
  );
}

const buckets = new Map();

function recentCount(userId, windowSec) {
  const now = Date.now();
  const key = userId;
  const list = (buckets.get(key) ?? []).filter((time) => now - time < windowSec * 1000);
  list.push(now);
  buckets.set(key, list);
  return list.length;
}

const URL_PATTERN = /https?:\/\/\S+/i;
const INVITE_PATTERN = /(discord\.gg|discord\.com\/invite|discordapp\.com\/invite)\/\S+/i;

/** 荒らし対策。処罰した場合は true */
export async function handleAntiraid(message) {
  if (!message.inGuild() || message.author.bot) return false;
  const settings = getAntiraid(message.guildId);
  if (!settings.enabled) return false;
  if (settings.exemptUserIds.includes(message.author.id)) return false;
  if (message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) return false;

  const timeout = async (minutes, reason) => {
    await message.delete().catch(() => null);
    await message.member
      .timeout(minutes * 60 * 1000, reason)
      .catch(() => null);
  };

  if (settings.inviteBlock && INVITE_PATTERN.test(message.content)) {
    await timeout(settings.spamTimeoutMin, '招待リンクの投稿');
    return true;
  }

  if (
    settings.urlBlock &&
    URL_PATTERN.test(message.content) &&
    !settings.allowedUrlChannelIds.includes(message.channelId)
  ) {
    await timeout(settings.spamTimeoutMin, 'URLの投稿');
    return true;
  }

  if (settings.newAccountBlock) {
    const ageDays = (Date.now() - message.author.createdTimestamp) / 86400000;
    if (ageDays < settings.minAccountAgeDays) {
      await timeout(settings.newAccountTimeoutMin, '新規アカウントの投稿');
      return true;
    }
  }

  if (settings.spamBlock) {
    const count = recentCount(message.author.id, settings.spamWindowSec);
    if (count >= settings.spamCount) {
      buckets.delete(message.author.id);
      await timeout(settings.spamTimeoutMin, '連投');
      return true;
    }
  }

  return false;
}

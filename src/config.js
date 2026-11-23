import path from 'node:path';

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const config = {
  token: process.env.DISCORD_BOT_TOKEN || '',
  applicationId: process.env.DISCORD_APPLICATION_ID || '',
  guildId: process.env.DISCORD_GUILD_ID || '',
  publicKey: process.env.DISCORD_PUBLIC_KEY || '',
  allowedRoleId: process.env.DISCORD_ALLOWED_ROLE_ID || '',

  databasePath: path.resolve(process.env.DATABASE_PATH || 'data/rip-shop.db'),
  timezone: 'Asia/Tokyo',

  port: Number(process.env.PORT || 3001),
  devGuildOnly: bool(process.env.DISCORD_DEV_GUILD_ONLY, true),

  autoBackupDays: Number(process.env.BACKUP_INTERVAL_DAYS || 3),
  keepBackups: Number(process.env.BACKUP_KEEP || 3),

  // 購入設定
  purchaseMaxQuantity: Number(process.env.PURCHASE_MAX_QUANTITY || 10),
  purchaseEditWindowMinutes: Number(process.env.PURCHASE_EDIT_WINDOW_MINUTES || 30),
};

export const COLORS = {
  main: 0xddf2ff,
  accent: 0xf8dde7,
  sub: 0xe4f3c9,
  text: 0x344d66,
  danger: 0xe06b7a,
  warn: 0xe8b84b,
};

/** 日本時間の日付キー（YYYY-MM-DD） */
export function jstDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/** 日本時間の現在時刻（時・分） */
export function jstClock(date = new Date()) {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const [hour, minute] = text.split(':').map(Number);
  return { hour, minute };
}

/** 日本時間の日時表示 */
export function jstString(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function jstIso(date = new Date()) {
  return date.toISOString();
}

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id TEXT PRIMARY KEY,
  allowed_role_id TEXT,
  maintenance INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT,
  maintenance_started_at TEXT,
  maintenance_dm_failed TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sale_state TEXT NOT NULL DEFAULT 'on',
  channel_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_machines_guild ON machines(guild_id);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL DEFAULT 0,
  cost_price INTEGER,
  stock_mode TEXT NOT NULL DEFAULT 'finite',
  sale_state TEXT NOT NULL DEFAULT 'on',
  daily_limit INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_machine ON products(machine_id);

CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'available',
  purchase_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_product_state ON stock_items(product_id, state);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  machine_id INTEGER,
  product_id INTEGER,
  product_name TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER,
  payment_method TEXT,
  payment_link TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  channel_id TEXT,
  message_id TEXT,
  fail_reason TEXT,
  cancel_reason TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchases_state ON purchases(state);
CREATE INDEX IF NOT EXISTS idx_purchases_guild ON purchases(guild_id, created_at);

CREATE TABLE IF NOT EXISTS purchase_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  actor_id TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_purchase ON purchase_events(purchase_id);

CREATE TABLE IF NOT EXISTS daily_counts (
  product_id INTEGER NOT NULL,
  buyer_id TEXT NOT NULL,
  day TEXT NOT NULL,
  reserved INTEGER NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, buyer_id, day)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  rate INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS notify_settings (
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  extra TEXT,
  PRIMARY KEY (guild_id, kind)
);

CREATE TABLE IF NOT EXISTS role_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  product_id INTEGER,
  role_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  roles_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  restored_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshot_user ON role_snapshots(guild_id, user_id, restored_at);

CREATE TABLE IF NOT EXISTS panels (
  guild_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  config_json TEXT,
  updated_at TEXT,
  PRIMARY KEY (guild_id, kind)
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  panel_key TEXT NOT NULL,
  number INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  opener_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_guild ON admin_logs(guild_id, id DESC);

CREATE TABLE IF NOT EXISTS member_stats (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT,
  left_at TEXT,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS antiraid (
  guild_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS verification (
  guild_id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lockdown (
  guild_id TEXT PRIMARY KEY,
  locked_until TEXT,
  snapshot_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_locks (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  allow_json TEXT,
  deny_json TEXT,
  locked_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  category_id TEXT,
  support_role_id TEXT,
  description TEXT,
  created_at TEXT NOT NULL
);
`;

db.exec(SCHEMA);

/** 既存DBに安全に列を追加する（存在すれば何もしない） */
export function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('products', 'daily_limit', 'INTEGER');
ensureColumn('purchases', 'fail_reason', 'TEXT');
ensureColumn('purchases', 'cancel_reason', 'TEXT');

export const all = (sql, params = []) => db.prepare(sql).all(...params);
export const get = (sql, params = []) => db.prepare(sql).get(...params);
export const run = (sql, params = []) => db.prepare(sql).run(...params);

/** トランザクション（同期処理のみ） */
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw error;
  }
}

const insertEvent = (purchaseId, event, actorId, detail) =>
  run(
    'INSERT INTO purchase_events (purchase_id, event, actor_id, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    [purchaseId, event, actorId ?? null, detail ?? null, new Date().toISOString()],
  );

export const events = { insert: insertEvent };

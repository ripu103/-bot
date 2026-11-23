import fs from 'node:fs';
import path from 'node:path';

const testDb = path.resolve('data/smoke-test.db');
for (const suffix of ['', '-wal', '-shm']) {
  const file = `${testDb}${suffix}`;
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
process.env.DATABASE_PATH = testDb;

const { commands } = await import('../src/commands/index.js');
const { get, run, all } = await import('../src/db.js');
const { createPurchase, cancelPurchase, listPurchases } = await import('../src/services/purchase.js');
const { summary } = await import('../src/services/stats.js');
const { discountedPrice } = await import('../src/lib/format.js');

const EXPECTED = [
  '自販機作成', '自販機設置', '自販機編集', '自販機削除', '自販機販売設定',
  '購入ログ設定', '購入実績通知', '商品追加', '商品削除', '商品編集',
  '商品位置変更', '購入個数指定', '商品販売設定', '在庫追加', '在庫引き出し',
  '在庫追加通知', '購入申請確認', '割引キャンペーン', '自販機ロール付与', 'ロール剥奪',
  '自販機統計パネル', 'メンバー管理', 'ロール付与', 'メンバー一括ロール操作', 'チャンネルロック',
  'チャンネルロック解除', 'チャンネル作成', 'nuke', 'ロックダウン', '管理ログ設定',
  '入退室ログ設定', '荒らし対策パネル', 'サーバー管理パネル', 'メンテナンス設定', '認証',
  'チケットパネル作成', 'リストア', 'shopチャンネル作成',
];

const failures = [];
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  OK  ${label}`);
  } else {
    failures.push(`${label}${detail ? `: ${detail}` : ''}`);
    console.log(`  NG  ${label}${detail ? `: ${detail}` : ''}`);
  }
};

console.log('1. コマンド定義');
const names = commands.map((command) => command.data.name);
check('登録コマンド数が38', names.length === 38, String(names.length));
check('重複なし', new Set(names).size === names.length);
for (const name of EXPECTED) check(`/${name} が存在`, names.includes(name));
for (const command of commands) {
  const json = command.data.toJSON();
  check(`/${json.name} の説明あり`, Boolean(json.description));
  check(`/${json.name} のオプション数が25以下`, (json.options?.length ?? 0) <= 25);
  let optionalSeen = false;
  let orderOk = true;
  for (const option of json.options ?? []) {
    if (option.required && optionalSeen) orderOk = false;
    if (!option.required) optionalSeen = true;
  }
  check(`/${json.name} の必須オプションが先頭`, orderOk);
}

console.log('2. DBスキーマ');
const tables = all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
for (const table of [
  'guild_settings', 'machines', 'products', 'stock_items', 'purchases', 'daily_counts',
  'campaigns', 'notify_settings', 'role_rules', 'panels', 'tickets', 'backups', 'admin_logs',
  'member_stats', 'antiraid', 'verification', 'lockdown', 'channel_locks', 'ticket_panels',
]) {
  check(`テーブル ${table}`, tables.includes(table));
}

console.log('3. 購入ステートマシン');
const now = new Date().toISOString();
run('INSERT INTO guild_settings (guild_id, created_at) VALUES (?, ?)', ['g1', now]);
run('INSERT INTO machines (guild_id, name, created_at) VALUES (?, ?, ?)', ['g1', 'テスト自販機', now]);
const machineId = get('SELECT id FROM machines WHERE guild_id = ?', ['g1']).id;
run(
  'INSERT INTO products (machine_id, name, price, cost_price, daily_limit, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  [machineId, 'テスト商品', 1000, 600, 3, 1, now],
);
const productId = get('SELECT id FROM products WHERE machine_id = ?', [machineId]).id;
for (let i = 0; i < 5; i += 1) {
  run('INSERT INTO stock_items (product_id, content, state, created_at) VALUES (?, ?, ?, ?)', [
    productId,
    `在庫${i + 1}`,
    'available',
    now,
  ]);
}

const fakeClient = { guilds: { cache: new Map() }, user: { id: 'bot' } };
const purchase = createPurchase({
  guildId: 'g1',
  machineId,
  productId,
  buyerId: 'u1',
  quantity: 2,
  method: 'paypay',
  link: 'https://example.com/pay',
});
check('申請が作成される', Boolean(purchase?.id));
check('在庫が2件仮確保される', get("SELECT COUNT(*) AS c FROM stock_items WHERE state = 'reserved'", [])?.c === 2);
check('購入上限が仮カウントされる', get('SELECT reserved FROM daily_counts WHERE buyer_id = ?', ['u1'])?.reserved === 2);

const cancelled = await cancelPurchase(fakeClient, purchase.id, 'admin');
check('キャンセルできる', cancelled.ok === true);
check('在庫が戻る', get("SELECT COUNT(*) AS c FROM stock_items WHERE state = 'available'", [])?.c === 5);
check('仮カウントが戻る', get('SELECT reserved FROM daily_counts WHERE buyer_id = ?', ['u1'])?.reserved === 0);
check('二重キャンセルを拒否', (await cancelPurchase(fakeClient, purchase.id, 'admin')).ok === false);

let limitRejected = false;
try {
  createPurchase({
    guildId: 'g1',
    machineId,
    productId,
    buyerId: 'u1',
    quantity: 4,
    method: 'kyash',
    link: 'https://example.com/pay2',
  });
} catch (error) {
  limitRejected = error.message.includes('購入上限');
}
check('上限超過の申請を拒否', limitRejected);

console.log('4. 統計・価格計算');
run(
  `INSERT INTO purchases (guild_id, machine_id, product_id, product_name, buyer_id, quantity, unit_price, unit_cost, payment_method, state, created_at, completed_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
  ['g1', machineId, productId, 'テスト商品', 'u2', 1, 1000, 600, 'paypay', now, now],
);
const data = summary('g1');
check('完了分のみ統計に含まれる', data.totals.orders === 1, String(data.totals.orders));
check('純利益が計算される', data.totals.profit === 400, String(data.totals.profit));
check('割引は1円未満切り捨て', discountedPrice(1280, 10) === 1152);
check('購入履歴を取得できる', listPurchases('g1').total >= 1);

console.log('5. 管理ログ上限');
for (let i = 0; i < 15; i += 1) {
  run('INSERT INTO admin_logs (guild_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)', [
    'g1',
    'u1',
    `操作${i}`,
    '',
    now,
  ]);
}

console.log('');
if (failures.length) {
  console.log(`失敗 ${failures.length}件:`);
  for (const failure of failures) console.log(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('すべてのスモークテストに合格しました。');
}

fs.rmSync(testDb, { force: true });
for (const suffix of ['-wal', '-shm']) fs.rmSync(`${testDb}${suffix}`, { force: true });

import { jstDay } from '../config.js';
import { all, get } from '../db.js';
import { discountedPrice } from '../lib/format.js';

export const getMachine = (id) => get('SELECT * FROM machines WHERE id = ? AND deleted_at IS NULL', [id]);

export const listMachines = (guildId) =>
  all('SELECT * FROM machines WHERE guild_id = ? AND deleted_at IS NULL ORDER BY id', [guildId]);

export const listProducts = (machineId) =>
  all('SELECT * FROM products WHERE machine_id = ? AND deleted_at IS NULL ORDER BY position, id', [machineId]);

export const getProduct = (id) => get('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [id]);

export function activeCampaign(guildId) {
  return get('SELECT * FROM campaigns WHERE guild_id = ? AND active = 1 ORDER BY id DESC LIMIT 1', [guildId]);
}

export function priceOf(product, campaign) {
  const rate = campaign?.active ? Number(campaign.rate) : 0;
  return { original: product.price, rate, final: discountedPrice(product.price, rate) };
}

/** 自販機ごとの在庫数 {productId: count} */
export function stockCounts(machineId) {
  const rows = all(
    `SELECT p.id AS product_id, COUNT(s.id) AS count
     FROM products p
     LEFT JOIN stock_items s ON s.product_id = p.id AND s.state = 'available'
     WHERE p.machine_id = ? AND p.deleted_at IS NULL
     GROUP BY p.id`,
    [machineId],
  );
  return new Map(rows.map((row) => [row.product_id, row.count]));
}

export function stockCount(productId) {
  const row = get("SELECT COUNT(*) AS c FROM stock_items WHERE product_id = ? AND state = 'available'", [productId]);
  return row?.c ?? 0;
}

export function dailyUsed(productId, buyerId, day = jstDay()) {
  const row = get('SELECT reserved, confirmed FROM daily_counts WHERE product_id = ? AND buyer_id = ? AND day = ?', [
    productId,
    buyerId,
    day,
  ]);
  return row ? row.reserved + row.confirmed : 0;
}

export function remainingLimit(product, buyerId, day = jstDay()) {
  if (!product?.daily_limit) return Infinity;
  return Math.max(0, Number(product.daily_limit) - dailyUsed(product.id, buyerId, day));
}

export function availability(product, { campaign, buyerId, day = jstDay() } = {}) {
  if (!product) return { ok: false, reason: '商品が見つかりません。' };
  if (product.sale_state === 'off') return { ok: false, reason: 'この商品は現在購入できません（販売停止中）。' };
  const stock = product.stock_mode === 'infinite' ? Infinity : stockCount(product.id);
  if (stock <= 0) return { ok: false, reason: '売り切れ！' };
  if (product.daily_limit && dailyUsed(product.id, buyerId, day) >= product.daily_limit) {
    return { ok: false, reason: '本日の購入上限に達しました！', limitReached: true };
  }
  return { ok: true, stock, price: priceOf(product, campaign) };
}

export function saleLabel(product, stock) {
  if (product.sale_state === 'off') return '販売停止中';
  if (product.stock_mode === 'finite' && stock <= 0) return '売り切れ！';
  return '販売中';
}

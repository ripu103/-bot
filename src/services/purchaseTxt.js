import { all } from '../db.js';
import { stockTxt } from '../lib/format.js';

/** 購入申請で確保した在庫内容からTXTを生成 */
export function buildPurchaseTxt(purchaseId) {
  const rows = all("SELECT content FROM stock_items WHERE purchase_id = ? ORDER BY id", [purchaseId]);
  const lines = rows.map((row, index) => `${index + 1}. ${row.content}`);
  return stockTxt(lines.length ? lines : ['（在庫情報なし）']);
}

/** 商品の在庫をTXT化（在庫引き出し用） */
export function buildStockTxt(items, title) {
  const lines = [`# ${title}`, ''];
  items.forEach((item, index) => lines.push(`${index + 1}. ${item.content}`));
  return stockTxt(lines);
}

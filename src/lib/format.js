export const yen = (value) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '¥0';
  return `¥${Math.round(n).toLocaleString('ja-JP')}`;
};

/** 割引後価格（1円未満切り捨て） */
export const discountedPrice = (price, rate) => {
  const n = Number(price ?? 0);
  const r = Math.max(0, Math.min(99, Number(rate ?? 0)));
  if (!r) return n;
  return Math.floor((n * (100 - r)) / 100);
};

export const truncate = (text, max = 100) => {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export const chunk = (list, size) => {
  const result = [];
  for (let i = 0; i < list.length; i += size) result.push(list.slice(i, i + size));
  return result;
};

/** 在庫状態ラベル */
export const saleLabel = (product, stock) => {
  if (product.sale_state === 'off') return '販売停止中';
  if (product.stock_mode === 'finite' && stock <= 0) return '売り切れ！';
  return '販売中';
};

export const stateLabel = (state) => {
  switch (state) {
    case 'pending':
      return '未対応';
    case 'processing':
      return '送信中';
    case 'completed':
      return '送信完了';
    case 'send_failed':
      return '送信失敗';
    case 'cancelled':
      return 'キャンセル済み';
    default:
      return state;
  }
};

export const paymentLabel = (method) => {
  if (method === 'paypay') return 'PayPay';
  if (method === 'kyash') return 'Kyash';
  return method || '—';
};

/** 在庫TXT（UTF-8 BOM付きで文字化けを防ぐ） */
export const stockTxt = (lines) => Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');

export const maskLink = (link) => {
  if (!link) return '—';
  return link.length > 60 ? `${link.slice(0, 57)}…` : link;
};

export const nowIso = () => new Date().toISOString();

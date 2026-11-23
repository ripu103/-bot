import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './src/env.js';

// 既存の環境変数を優先し、.env はローカル用に読み込みます。
loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3001);
const MAX_BODY = 32 * 1024;

/**
 * 既存システム（Render）との接続設定。
 * RENDER_API_BASE_URL が未設定の場合はデモモードで動作します。
 */
const CONFIG = {
  baseUrl: (process.env.RENDER_API_BASE_URL || '').replace(/\/+$/, ''),
  token: process.env.RENDER_API_TOKEN || '',
  productsPath: process.env.RENDER_PRODUCTS_PATH || '/api/products',
  purchasePath: process.env.RENDER_PURCHASE_PATH || '/api/purchase',
  stockPath: process.env.RENDER_STOCK_PATH || '',
  timeoutMs: Number(process.env.RENDER_TIMEOUT_MS || 15000),
  machineName: process.env.VENDING_MACHINE_NAME || 'りぷSHOP 自販機',
  brandLogoUrl: process.env.BRAND_LOGO_URL || '',
};

const isLive = Boolean(CONFIG.baseUrl);

/* ------------------------------------------------------------------ */
/* デモデータ（Render未接続時にUIを確認するためのもの）               */
/* ------------------------------------------------------------------ */

const demoStore = {
  notice: '本日は11:00〜18:00まで送料無料キャンペーンを実施中です。',
  products: [
    {
      id: 'demo-01',
      name: 'ドリップコーヒー 深煎り 10袋入',
      description: '香り高い深煎りブレンド。1杯ずつ抽出できます。',
      price: 1280,
      originalPrice: 1600,
      stock: 12,
      status: 'on_sale',
    },
    {
      id: 'demo-02',
      name: '国産はちみつ 300g',
      description: '非加熱の純粋はちみつ。',
      price: 1980,
      stock: 5,
      status: 'on_sale',
    },
    {
      id: 'demo-03',
      name: '抹茶ラテ スティック 20本入',
      description: 'お湯でも牛乳でも溶ける抹茶ラテ。',
      price: 980,
      stock: 0,
      status: 'sold_out',
    },
    {
      id: 'demo-04',
      name: 'ほしいも 茨城県産 200g',
      description: 'しっとり甘い干し芋です。',
      price: 1450,
      stock: 2,
      status: 'on_sale',
    },
    {
      id: 'demo-05',
      name: 'オリジナル手ぬぐい',
      description: 'りぷSHOP限定デザイン。',
      price: 1200,
      stock: 8,
      status: 'suspended',
    },
    {
      id: 'demo-06',
      name: '炭酸水 500ml 24本セット',
      description: '強炭酸。ケース単位でのお届けです。',
      price: 2180,
      stock: 30,
      status: 'on_sale',
    },
    {
      id: 'demo-07',
      name: 'ミックスナッツ 500g',
      description: '無塩・素焼き。チャック付き袋。',
      price: 1680,
      stock: 3,
      status: 'on_sale',
    },
    {
      id: 'demo-08',
      name: '新米 コシヒカリ 2kg',
      description: '令和の新米を産地直送で。',
      price: 2480,
      stock: 8,
      status: 'on_sale',
    },
    {
      id: 'demo-09',
      name: '焼きのり 詰め合わせ',
      description: '国産海苔の詰め合わせ。',
      price: 1100,
      stock: 0,
      status: 'sold_out',
    },
    {
      id: 'demo-10',
      name: 'りぷSHOP エコバッグ',
      description: '厚手のキャンバス素材。',
      price: 880,
      stock: 40,
      status: 'on_sale',
    },
  ],
};

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                       */
/* ------------------------------------------------------------------ */

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('リクエストが大きすぎます'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('リクエストの形式が正しくありません'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 既存データの正規化（項目名の揺れを吸収）                             */
/* ------------------------------------------------------------------ */

const SOLD_OUT_WORDS = ['sold_out', 'soldout', 'out_of_stock', 'outofstock', '売り切れ', '完売'];
const SUSPENDED_WORDS = ['suspended', 'paused', 'inactive', 'stopped', 'unavailable', '販売停止', '停止'];

function pick(object, keys, fallback) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') return object[key];
  }
  return fallback;
}

function normalizeProduct(raw, index) {
  const stock = Math.max(0, toNumber(pick(raw, ['stock', 'stockCount', 'inventory', 'quantity'], 0), 0));
  const price = Math.max(0, toNumber(pick(raw, ['price', 'amount', 'unitPrice', 'salePrice'], 0), 0));
  const listPrice = Math.max(0, toNumber(pick(raw, ['originalPrice', 'listPrice', 'regularPrice', 'basePrice'], 0), 0));
  const statusWord = String(pick(raw, ['status', 'saleStatus', 'state'], '')).toLowerCase();
  const active = pick(raw, ['active', 'isActive', 'enabled'], true);

  let status = 'on_sale';
  if (SUSPENDED_WORDS.includes(statusWord) || active === false) status = 'suspended';
  else if (SOLD_OUT_WORDS.includes(statusWord) || raw.soldOut === true || stock <= 0) status = 'sold_out';

  const discountRate = toNumber(pick(raw, ['discountRate', 'discountPercent', 'discount'], 0), 0);

  return {
    id: String(pick(raw, ['id', 'productId', 'code', 'sku'], `item-${index + 1}`)),
    name: String(pick(raw, ['name', 'productName', 'title'], '商品名未設定')),
    description: String(pick(raw, ['description', 'summary', 'note'], '')),
    price,
    originalPrice: listPrice > price ? listPrice : null,
    discountRate: discountRate > 0 ? discountRate : null,
    stock,
    status,
  };
}

function normalizeList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.products)
      ? payload.products
      : Array.isArray(payload?.items)
        ? payload.items
        : Array.isArray(payload?.data)
          ? payload.data
          : [];
  return list.map(normalizeProduct);
}

/* ------------------------------------------------------------------ */
/* Render（既存システム）へのリクエスト                                 */
/* ------------------------------------------------------------------ */

async function callBackend(apiPath, { method = 'GET', body } = {}) {
  if (!isLive) throw new Error('RENDER_API_BASE_URL が未設定です');

  const url = `${CONFIG.baseUrl}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (CONFIG.token) headers.authorization = `Bearer ${CONFIG.token}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
  } catch (error) {
    throw new Error(`既存システムに接続できませんでした（${error.name === 'TimeoutError' ? 'タイムアウト' : error.message}）`);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const message =
      (data && (data.message || data.error || data.detail)) ||
      `既存システムがエラーを返しました（HTTP ${response.status}）`;
    throw new Error(String(message));
  }

  return data ?? {};
}

/* ------------------------------------------------------------------ */
/* API ハンドラ                                                         */
/* ------------------------------------------------------------------ */

async function handleConfig(res) {
  json(res, 200, {
    mode: isLive ? 'live' : 'demo',
    machineName: CONFIG.machineName,
    brandLogoUrl: CONFIG.brandLogoUrl,
  });
}

async function handleProducts(res) {
  try {
    if (!isLive) {
      json(res, 200, {
        products: demoStore.products.map(normalizeProduct),
        notice: demoStore.notice,
        updatedAt: new Date().toISOString(),
        mode: 'demo',
      });
      return;
    }

    const data = await callBackend(CONFIG.productsPath);
    json(res, 200, {
      products: normalizeList(data),
      notice: String(pick(data, ['notice', 'announcement', 'campaign'], '')),
      updatedAt: new Date().toISOString(),
      mode: 'live',
    });
  } catch (error) {
    json(res, 502, { message: error.message, products: [] });
  }
}

async function handlePurchase(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    json(res, 400, { message: error.message });
    return;
  }

  const productId = String(body.productId ?? body.id ?? '');
  if (!productId) {
    json(res, 400, { message: '商品が選択されていません' });
    return;
  }

  try {
    if (!isLive) {
      const product = demoStore.products.find((item) => item.id === productId);
      if (!product) {
        json(res, 404, { message: '商品が見つかりません' });
        return;
      }
      if (product.status !== 'on_sale' || product.stock <= 0) {
        json(res, 409, { message: 'この商品は現在購入できません' });
        return;
      }
      product.stock -= 1;
      if (product.stock <= 0) {
        product.stock = 0;
        product.status = 'sold_out';
      }
      json(res, 200, {
        ok: true,
        message: `${product.name} を購入しました`,
        order: { productId, quantity: 1, unitPrice: product.price, total: product.price },
      });
      return;
    }

    const data = await callBackend(CONFIG.purchasePath, {
      method: 'POST',
      body: { productId, quantity: 1 },
    });
    json(res, 200, { ok: true, message: data.message || '購入が完了しました', order: data.order ?? data });
  } catch (error) {
    json(res, 502, { message: error.message });
  }
}

async function handleStockRefresh(res) {
  try {
    if (isLive && CONFIG.stockPath) {
      await callBackend(CONFIG.stockPath, { method: 'POST', body: {} });
    }
    await handleProducts(res);
  } catch (error) {
    json(res, 502, { message: error.message, products: [] });
  }
}

/* ------------------------------------------------------------------ */
/* 静的ファイル配信                                                     */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) {
    json(res, 403, { message: 'アクセスできません' });
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      json(res, 404, { message: 'ページが見つかりません' });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* ルーティング                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (pathname === '/api/config' && req.method === 'GET') return await handleConfig(res);
    if (pathname === '/api/products' && req.method === 'GET') return await handleProducts(res);
    if (pathname === '/api/purchase' && req.method === 'POST') return await handlePurchase(req, res);
    if (pathname === '/api/stock' && req.method === 'POST') return await handleStockRefresh(res);
    if (pathname.startsWith('/api/')) return json(res, 404, { message: 'APIが見つかりません' });
    if (req.method !== 'GET') return json(res, 405, { message: '許可されていない操作です' });
    return serveStatic(res, pathname);
  } catch (error) {
    json(res, 500, { message: 'サーバーエラーが発生しました' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`りぷSHOP 自販機UI: http://0.0.0.0:${PORT} (${isLive ? 'Render接続' : 'デモモード'})`);

  // 同じRender Web Service内でDiscord Botも起動（同居）
  if (process.env.DISCORD_BOT_TOKEN) {
    import('./bot.js').catch((error) => console.error('[bot] 起動失敗:', error.message));
  }
});

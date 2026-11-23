import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { COLORS, jstDay, jstString } from '../config.js';
import { all, get, run, events, transaction } from '../db.js';
import { logAdmin, notifyChannel, sendNotification } from '../lib/logger.js';
import { paymentLabel, yen } from '../lib/format.js';
import { activeCampaign, getProduct, priceOf, remainingLimit, stockCount } from './catalog.js';
import { grantPurchaseRoles } from './roles.js';
import { buildPurchaseTxt } from './purchaseTxt.js';
import { refreshStatsPanels } from './stats.js';

/* ------------------------------------------------------------------ */
/* 仮確保・解放                                                        */
/* ------------------------------------------------------------------ */

function reserveStock(productId, quantity, purchaseId) {
  const rows = all(
    "SELECT id FROM stock_items WHERE product_id = ? AND state = 'available' ORDER BY id LIMIT ?",
    [productId, quantity],
  );
  if (rows.length < quantity) throw new Error('在庫が不足しています。');
  for (const row of rows) {
    run("UPDATE stock_items SET state = 'reserved', purchase_id = ? WHERE id = ?", [purchaseId, row.id]);
  }
}

function releaseStock(purchaseId) {
  run("UPDATE stock_items SET state = 'available', purchase_id = NULL WHERE purchase_id = ? AND state = 'reserved'", [
    purchaseId,
  ]);
}

function consumeStock(purchaseId) {
  run("UPDATE stock_items SET state = 'used' WHERE purchase_id = ? AND state = 'reserved'", [purchaseId]);
}

function addDaily(productId, buyerId, quantity, column) {
  run(
    `INSERT INTO daily_counts (product_id, buyer_id, day, reserved, confirmed) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(product_id, buyer_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
    [productId, buyerId, jstDay(), column === 'reserved' ? quantity : 0, column === 'confirmed' ? quantity : 0],
  );
}

function moveDaily(productId, buyerId, quantity) {
  run(
    `UPDATE daily_counts SET reserved = MAX(0, reserved - ?), confirmed = confirmed + ?
     WHERE product_id = ? AND buyer_id = ? AND day = ?`,
    [quantity, quantity, productId, buyerId, jstDay()],
  );
}

function dropDailyReserved(productId, buyerId, quantity) {
  run(
    'UPDATE daily_counts SET reserved = MAX(0, reserved - ?) WHERE product_id = ? AND buyer_id = ? AND day = ?',
    [quantity, productId, buyerId, jstDay()],
  );
}

/* ------------------------------------------------------------------ */
/* 申請作成                                                            */
/* ------------------------------------------------------------------ */

export function createPurchase({ guildId, machineId, productId, buyerId, quantity, method, link }) {
  const product = getProduct(productId);
  if (!product) throw new Error('商品が見つかりません。');
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('購入個数が正しくありません。');
  if (product.sale_state === 'off') throw new Error('この商品は現在購入できません（販売停止中）。');
  if (product.daily_limit && remainingLimit(product, buyerId) < quantity) {
    throw new Error('本日の購入上限に達しました！');
  }
  if (product.stock_mode === 'finite' && stockCount(product.id) < quantity) {
    throw new Error('在庫が不足しています。');
  }

  return transaction(() => {
    const campaign = activeCampaign(guildId);
    const { final } = priceOf(product, campaign);
    const result = run(
      `INSERT INTO purchases
        (guild_id, machine_id, product_id, product_name, buyer_id, quantity, unit_price, unit_cost,
         payment_method, payment_link, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        guildId,
        machineId,
        product.id,
        product.name,
        buyerId,
        quantity,
        final,
        product.cost_price ?? null,
        method,
        link,
        new Date().toISOString(),
      ],
    );
    const purchaseId = Number(result.lastInsertRowid);
    if (product.stock_mode === 'finite') reserveStock(product.id, quantity, purchaseId);
    if (product.daily_limit) addDaily(product.id, buyerId, quantity, 'reserved');
    events.insert(purchaseId, '申請', buyerId, `数量 ${quantity} / ${paymentLabel(method)}`);
    return get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
  });
}

/* ------------------------------------------------------------------ */
/* 申請通知                                                            */
/* ------------------------------------------------------------------ */

export function purchaseLogEmbed(purchase) {
  return new EmbedBuilder()
    .setColor(COLORS.accent)
    .setTitle('購入申請')
    .setDescription(`申請 #${purchase.id}`)
    .addFields(
      { name: '購入者', value: `<@${purchase.buyer_id}>`, inline: true },
      { name: '商品', value: purchase.product_name, inline: true },
      { name: '個数', value: `${purchase.quantity}`, inline: true },
      { name: '金額', value: yen(purchase.unit_price * purchase.quantity), inline: true },
      { name: '決済', value: paymentLabel(purchase.payment_method), inline: true },
      { name: '日時', value: jstString(purchase.created_at), inline: true },
      { name: '支払いリンク', value: purchase.payment_link || '—' },
    )
    .setFooter({ text: '入金確認後に「商品送信」を押してください' });
}

export function purchaseLogRow(purchase) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`apl:send:${purchase.id}`).setLabel('商品送信').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`apl:cancel:${purchase.id}`).setLabel('キャンセル').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`apl:detail:${purchase.id}`).setLabel('詳細').setStyle(ButtonStyle.Secondary),
  );
}

export async function sendPurchaseLog(client, purchase) {
  const channel = await notifyChannel(client, purchase.guild_id, 'purchase_log');
  if (!channel) return null;
  try {
    const message = await channel.send({
      embeds: [purchaseLogEmbed(purchase)],
      components: [purchaseLogRow(purchase)],
    });
    run('UPDATE purchases SET channel_id = ?, message_id = ? WHERE id = ?', [channel.id, message.id, purchase.id]);
    return message;
  } catch {
    return null;
  }
}

async function removePurchaseLog(client, purchase) {
  if (!purchase.channel_id || !purchase.message_id) return;
  const guild = client.guilds.cache.get(purchase.guild_id);
  const channel = guild?.channels.cache.get(purchase.channel_id);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(purchase.message_id).catch(() => null);
  await message?.delete().catch(() => null);
}

/* ------------------------------------------------------------------ */
/* 商品送信（DM）                                                      */
/* ------------------------------------------------------------------ */

export async function processPurchase(client, purchaseId, actorId) {
  const claim = run("UPDATE purchases SET state = 'processing' WHERE id = ? AND state IN ('pending', 'send_failed')", [
    purchaseId,
  ]);
  if (claim.changes === 0) {
    return { ok: false, reason: 'この申請はすでに処理中・処理済み・キャンセル済みです。' };
  }

  const purchase = get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
  const guild = client.guilds.cache.get(purchase.guild_id);
  if (!guild) {
    return failPurchase(client, purchase, actorId, 'サーバーが見つかりません');
  }

  const member = await guild.members.fetch(purchase.buyer_id).catch(() => null);
  if (!member) {
    return failPurchase(client, purchase, actorId, '購入者がサーバーにいません');
  }

  let dm;
  try {
    dm = await member.send({
      content: [
        'ご購入ありがとうございます！',
        '',
        `商品: ${purchase.product_name}`,
        `個数: ${purchase.quantity}`,
        `金額: ${yen(purchase.unit_price * purchase.quantity)}`,
        '',
        '商品データをTXTファイルで添付しました。ご確認ください。',
      ].join('\n'),
      files: [{ attachment: buildPurchaseTxt(purchase.id), name: `rip-shop-${purchase.id}.txt` }],
    });
  } catch (error) {
    const reason = error?.code === 50007 ? 'DMを送信できません（DMが閉じられている可能性があります）' : error.message;
    return failPurchase(client, purchase, actorId, reason);
  }

  if (!dm) return failPurchase(client, purchase, actorId, 'DMの送信結果を確認できませんでした');

  const completed = transaction(() => {
    const update = run(
      "UPDATE purchases SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'processing'",
      [new Date().toISOString(), purchaseId],
    );
    if (update.changes === 0) return false;
    consumeStock(purchaseId);
    if (purchase.quantity > 0) moveDaily(purchase.product_id, purchase.buyer_id, purchase.quantity);
    events.insert(purchaseId, '送信完了', actorId, null);
    return true;
  });

  if (!completed) return { ok: false, reason: '二重処理を検出しました。' };

  const fresh = get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
  await removePurchaseLog(client, fresh);
  const roleResult = await grantPurchaseRoles(client, guild, member, fresh);
  await sendNotification(client, fresh.guild_id, 'purchase_result', {
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.sub)
        .setTitle('購入実績')
        .addFields(
          { name: '商品', value: fresh.product_name, inline: true },
          { name: '購入者', value: `<@${fresh.buyer_id}>`, inline: true },
          { name: '個数', value: `${fresh.quantity}`, inline: true },
          { name: '販売金額', value: yen(fresh.unit_price * fresh.quantity), inline: true },
        ),
    ],
  });
  await refreshStatsPanels(client, fresh.guild_id);
  return { ok: true, purchase: fresh, roles: roleResult };
}

async function failPurchase(client, purchase, actorId, reason) {
  run("UPDATE purchases SET state = 'send_failed', fail_reason = ? WHERE id = ?", [reason, purchase.id]);
  events.insert(purchase.id, 'DM送信失敗', actorId, reason);
  await logAdmin(client, purchase.guild_id, actorId, '商品送信失敗', `申請 #${purchase.id}\n${reason}`);
  const channel = await notifyChannel(client, purchase.guild_id, 'purchase_log');
  if (channel) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`apl:resend:${purchase.id}`).setLabel('再送信').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`apl:txt:${purchase.id}`).setLabel('TXT取得').setStyle(ButtonStyle.Secondary),
    );
    await channel
      .send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.danger)
            .setTitle('商品送信に失敗しました')
            .setDescription(`申請 #${purchase.id} / ${reason}\n在庫・購入上限は消費していません。`),
        ],
        components: [row],
      })
      .catch(() => null);
  }
  return { ok: false, reason };
}

/* ------------------------------------------------------------------ */
/* キャンセル                                                          */
/* ------------------------------------------------------------------ */

export async function cancelPurchase(client, purchaseId, actorId, reason = '管理者によるキャンセル') {
  const purchase = get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
  if (!purchase) return { ok: false, reason: '申請が見つかりません。' };

  const done = transaction(() => {
    const update = run(
      "UPDATE purchases SET state = 'cancelled', cancelled_at = ?, cancel_reason = ? WHERE id = ? AND state IN ('pending', 'send_failed')",
      [new Date().toISOString(), reason, purchaseId],
    );
    if (update.changes === 0) return false;
    releaseStock(purchaseId);
    if (purchase.quantity > 0) dropDailyReserved(purchase.product_id, purchase.buyer_id, purchase.quantity);
    events.insert(purchaseId, 'キャンセル', actorId, reason);
    return true;
  });

  if (!done) return { ok: false, reason: 'この申請はすでに処理済み・キャンセル済みです。' };

  await removePurchaseLog(client, purchase);
  await logAdmin(client, purchase.guild_id, actorId, '購入申請キャンセル', `申請 #${purchaseId}`);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 参照                                                                */
/* ------------------------------------------------------------------ */

export async function purchaseDetailEmbed(purchaseId) {
  const purchase = get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
  if (!purchase) return null;
  const history = all('SELECT * FROM purchase_events WHERE purchase_id = ? ORDER BY id', [purchaseId]);
  return new EmbedBuilder()
    .setColor(COLORS.main)
    .setTitle(`購入申請 #${purchase.id}`)
    .addFields(
      { name: '状態', value: purchase.state, inline: true },
      { name: '商品', value: purchase.product_name, inline: true },
      { name: '個数', value: `${purchase.quantity}`, inline: true },
      { name: '金額', value: yen(purchase.unit_price * purchase.quantity), inline: true },
      { name: '決済', value: paymentLabel(purchase.payment_method), inline: true },
      { name: 'リンク', value: purchase.payment_link || '—', inline: true },
      { name: '申請日時', value: jstString(purchase.created_at), inline: true },
      { name: '完了日時', value: jstString(purchase.completed_at), inline: true },
      {
        name: '履歴',
        value: history.map((row) => `${row.event}（${jstString(row.created_at)}）`).join('\n') || '—',
      },
    );
}

export function listPurchases(guildId, { limit = 10, offset = 0, state = null, buyer = null, product = null } = {}) {
  const where = ['guild_id = ?'];
  const params = [guildId];
  if (state) {
    where.push('state = ?');
    params.push(state);
  }
  if (buyer) {
    where.push('buyer_id = ?');
    params.push(buyer);
  }
  if (product) {
    where.push('product_name LIKE ?');
    params.push(`%${product}%`);
  }
  const rows = all(
    `SELECT * FROM purchases WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get(`SELECT COUNT(*) AS c FROM purchases WHERE ${where.join(' AND ')}`, params)?.c ?? 0;
  return { rows, total };
}

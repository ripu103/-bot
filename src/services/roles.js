import { all, get, run } from '../db.js';
import { logAdmin } from '../lib/logger.js';
import { canManageRole } from '../lib/permissions.js';

export const commonRoleId = (guildId) =>
  get("SELECT role_id FROM role_rules WHERE guild_id = ? AND kind = 'common' ORDER BY id DESC LIMIT 1", [guildId])
    ?.role_id ?? null;

export const specialRoleIds = (productId) =>
  all("SELECT role_id FROM role_rules WHERE kind = 'product' AND product_id = ? ORDER BY id", [productId]).map(
    (row) => row.role_id,
  );

/** 付与直前のロール構成を保存（特別ロール解除時の復元用） */
export function snapshotRoles(guildId, member) {
  const roles = member.roles.cache
    .filter((role) => role.id !== guildId && !role.managed)
    .map((role) => role.id);
  run('INSERT INTO role_snapshots (guild_id, user_id, roles_json, created_at) VALUES (?, ?, ?, ?)', [
    guildId,
    member.id,
    JSON.stringify(roles),
    new Date().toISOString(),
  ]);
  return roles;
}

/**
 * 購入成功時のロール付与。
 * 特別ロール（商品別）を付与する場合は、付与前にロール構成を保存し、
 * 設定された特別ロール以外の通常ロールを剥奪する。
 */
export async function grantPurchaseRoles(client, guild, member, purchase) {
  const guildId = guild.id;
  const common = commonRoleId(guildId);
  const specials = specialRoleIds(purchase.product_id);
  const toGrant = [...new Set([common, ...specials].filter(Boolean))];
  const granted = [];
  const failures = [];

  if (toGrant.length === 0) return { granted, failures };

  if (specials.length > 0) {
    snapshotRoles(guildId, member);
    const keep = new Set([...specials, common, guildId].filter(Boolean));
    const verification = get('SELECT role_id FROM verification WHERE guild_id = ?', [guildId])?.role_id;
    if (verification) keep.add(verification);

    for (const role of member.roles.cache.values()) {
      if (role.id === guild.id || role.managed || keep.has(role.id)) continue;
      const check = canManageRole(guild, role);
      if (!check.ok) continue;
      try {
        await member.roles.remove(role, '特別ロール付与に伴う通常ロールの整理');
      } catch (error) {
        failures.push({ role, reason: error.message });
      }
    }
  }

  for (const roleId of toGrant) {
    const role = guild.roles.cache.get(roleId);
    const check = canManageRole(guild, role);
    if (!check.ok) {
      failures.push({ role: role ?? { name: roleId }, reason: check.reason });
      continue;
    }
    if (member.roles.cache.has(roleId)) {
      granted.push(role);
      continue;
    }
    try {
      await member.roles.add(role, `購入特典 (${purchase.id})`);
      granted.push(role);
    } catch (error) {
      failures.push({ role, reason: error.message });
    }
  }

  if (failures.length > 0) {
    const detail = failures.map((f) => `・${f.role?.name ?? '不明'}: ${f.reason}`).join('\n');
    await logAdmin(client, guildId, client.user.id, 'ロール付与失敗', `対象: <@${member.id}>\n${detail}`);
  }

  return { granted, failures };
}

/** 指定ロールを剥奪し、必要なら付与前のロール構成へ復元 */
export async function revokeRole(client, guild, member, role, { restore = false } = {}) {
  const check = canManageRole(guild, role);
  if (!check.ok) return { ok: false, reason: check.reason };

  try {
    await member.roles.remove(role, 'ロール剥奪コマンド');
  } catch (error) {
    return { ok: false, reason: error.message };
  }

  let restored = [];
  if (restore) {
    const snapshot = get(
      'SELECT * FROM role_snapshots WHERE guild_id = ? AND user_id = ? AND restored_at IS NULL ORDER BY id DESC LIMIT 1',
      [guild.id, member.id],
    );
    if (snapshot) {
      const ids = JSON.parse(snapshot.roles_json);
      for (const id of ids) {
        const target = guild.roles.cache.get(id);
        if (!target || member.roles.cache.has(id)) continue;
        const roleCheck = canManageRole(guild, target);
        if (!roleCheck.ok) continue;
        try {
          await member.roles.add(target, 'ロール構成の復元');
          restored.push(target);
        } catch {
          /* 失敗分は無視して続行 */
        }
      }
      run('UPDATE role_snapshots SET restored_at = ? WHERE id = ?', [new Date().toISOString(), snapshot.id]);
    }
  }

  return { ok: true, restored };
}

/** メンバーから現在の特別ロールを判定 */
export function isSpecialRole(guildId, roleId) {
  const row = get("SELECT id FROM role_rules WHERE guild_id = ? AND kind = 'product' AND role_id = ? LIMIT 1", [
    guildId,
    roleId,
  ]);
  return Boolean(row);
}

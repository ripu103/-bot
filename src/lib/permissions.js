import { MessageFlags, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { get, run } from '../db.js';

export function guildSettings(guildId) {
  let row = get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
  if (!row) {
    run('INSERT INTO guild_settings (guild_id, allowed_role_id, created_at) VALUES (?, ?, ?)', [
      guildId,
      config.allowedRoleId || null,
      new Date().toISOString(),
    ]);
    row = get('SELECT * FROM guild_settings WHERE guild_id = ?', [guildId]);
  }
  return row;
}

/** 許可ロール（鯖主ロール）のID。未設定なら null */
export function allowedRoleId(guildId) {
  return guildSettings(guildId).allowed_role_id || null;
}

export function setAllowedRole(guildId, roleId) {
  guildSettings(guildId);
  run('UPDATE guild_settings SET allowed_role_id = ? WHERE guild_id = ?', [roleId, guildId]);
}

/**
 * 実行者が管理コマンドを実行できるか。
 * 許可ロール所持者のみ。未設定時はサーバーオーナーのみ（初期設定のため）。
 */
export function checkAllowed(member, guildId) {
  const roleId = allowedRoleId(guildId);
  if (!roleId) {
    return {
      ok: member.id === member.guild.ownerId,
      setup: true,
      reason: '許可ロール（鯖主）が未設定です。`/SHOPチャンネル作成` で作成するか、設定を完了してください。',
    };
  }
  const roles = member.roles?.cache;
  if (roles?.has(roleId)) return { ok: true };
  return { ok: false, reason: `この操作には <@&${roleId}> ロールが必要です。` };
}

export function isOwner(member) {
  return member?.id === member?.guild?.ownerId;
}

export const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

/** 管理コマンドの共通ガード。失敗時は応答済みで false を返す */
export async function guardAdmin(interaction, { ownerOnly = false } = {}) {
  if (!interaction.inGuild()) {
    await interaction.reply(ephemeral('このコマンドはサーバー内でのみ使用できます。'));
    return false;
  }
  const member = interaction.member;
  if (ownerOnly) {
    if (!isOwner(member)) {
      await interaction.reply(ephemeral('このコマンドはサーバーオーナーのみ実行できます。'));
      return false;
    }
    return true;
  }
  const allowed = checkAllowed(member, interaction.guildId);
  if (!allowed.ok) {
    await interaction.reply(ephemeral(allowed.reason));
    return false;
  }
  return true;
}

/** Bot が必要な権限を持っているか確認 */
export function botHas(guild, permissions) {
  const me = guild.members.me;
  if (!me) return false;
  return me.permissions.has(permissions);
}

export async function guardBotPermissions(interaction, permissions, label) {
  if (!botHas(interaction.guild, permissions)) {
    const names = new PermissionsBitField(permissions).toArray().join(', ');
    await interaction.reply(ephemeral(`Botに「${label}」の権限がありません（必要: ${names}）。`));
    return false;
  }
  return true;
}

/** ロール階層と管理可能性の確認 */
export function canManageRole(guild, role) {
  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'Botのメンバー情報を取得できませんでした。' };
  if (!role) return { ok: false, reason: 'ロールが見つかりません。' };
  if (role.managed) return { ok: false, reason: `「${role.name}」は外部連携の管理ロールのため操作できません。` };
  if (role.id === guild.id) return { ok: false, reason: '@everyone は操作できません。' };
  if (role.position >= me.roles.highest.position) {
    return { ok: false, reason: `「${role.name}」はBotの最上位ロール以上です。Botのロールを上にしてください。` };
  }
  return { ok: true };
}

/** 対象メンバーが操作可能か（階層確認） */
export function canManageMember(guild, member) {
  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'Botのメンバー情報を取得できませんでした。' };
  if (!member) return { ok: false, reason: 'メンバーが見つかりません。' };
  if (member.id === guild.ownerId) return { ok: false, reason: 'サーバーオーナーは対象にできません。' };
  if (member.id === me.id) return { ok: false, reason: 'Bot自身は対象にできません。' };
  if (member.roles.highest.position >= me.roles.highest.position) {
    return { ok: false, reason: '対象メンバーの最上位ロールがBot以上です。' };
  }
  return { ok: true };
}

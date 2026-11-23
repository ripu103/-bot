import { jstClock, jstDay, config } from '../config.js';
import { all, get, run } from '../db.js';
import { refreshStatsPanels } from './stats.js';
import { refreshServerPanels } from './serverPanel.js';
import { createBackup, lastBackupAt } from './backup.js';
import { unlockGuild } from './lockdown.js';

let timer = null;
let lastHourlyKey = '';
let lastBackupKey = '';

export function startScheduler(client) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick(client).catch(() => null), 60_000);
  tick(client).catch(() => null);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(client) {
  const now = new Date();
  const hourKey = `${jstDay(now)}-${jstClock(now).hour}`;
  const backupKey = jstDay(now);

  // ロックダウンの自動解除
  for (const row of all('SELECT * FROM lockdown WHERE locked_until IS NOT NULL')) {
    if (new Date(row.locked_until).getTime() <= now.getTime()) {
      await unlockGuild(client, row.guild_id).catch(() => null);
    }
  }

  if (hourKey !== lastHourlyKey) {
    lastHourlyKey = hourKey;
    for (const guild of client.guilds.cache.values()) {
      await refreshStatsPanels(client, guild.id).catch(() => null);
      await refreshServerPanels(client, guild.id).catch(() => null);
    }
  }

  // 3日に1回・日本時間0:00
  const clock = jstClock(now);
  if (clock.hour === 0 && clock.minute < 2 && backupKey !== lastBackupKey) {
    lastBackupKey = backupKey;
    for (const guild of client.guilds.cache.values()) {
      const last = lastBackupAt(guild.id);
      const due = !last || now.getTime() - new Date(last).getTime() >= config.autoBackupDays * 86400000;
      if (due) await createBackup(client, guild).catch(() => null);
    }
  }
}

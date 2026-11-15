'use strict';
// 日志：控制台 + data/logs/server-YYYY-MM-DD.log（JSON 行，按天轮转，保留 logKeepDays 天）。
// 量级低（每请求一行），用同步追加避免交错。

const fs = require('node:fs');
const path = require('node:path');

let logDir = null;
let keepDays = 14;
let lastCleanDay = '';

function init({ dir, keepDays: kd }) {
  logDir = dir;
  keepDays = kd || 14;
  cleanOld();
}

function cleanOld() {
  const today = new Date().toISOString().slice(0, 10);
  if (today === lastCleanDay) return;
  lastCleanDay = today;
  try {
    const cutoff = Date.now() - keepDays * 86400000;
    for (const f of fs.readdirSync(logDir)) {
      const m = /^server-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (!m) continue;
      const t = new Date(m[1] + 'T00:00:00Z').getTime();
      if (t < cutoff) fs.unlinkSync(path.join(logDir, f));
    }
  } catch { /* 忽略 */ }
}

function line(level, msg, extra) {
  const rec = { t: new Date().toISOString(), level, msg };
  if (extra && Object.keys(extra).length) rec.extra = extra;
  const json = JSON.stringify(rec);
  const consoleMsg = `[${rec.t.slice(11, 19)}] ${level.toUpperCase()} ${msg}` +
    (extra ? ` ${JSON.stringify(extra)}` : '');
  if (level === 'error') console.error(consoleMsg);
  else if (level === 'warn') console.warn(consoleMsg);
  else console.log(consoleMsg);
  if (logDir) {
    try {
      cleanOld();
      fs.appendFileSync(path.join(logDir, `server-${rec.t.slice(0, 10)}.log`), json + '\n');
    } catch { /* 磁盘问题不阻断服务 */ }
  }
}

module.exports = {
  init,
  info: (msg, extra) => line('info', msg, extra),
  warn: (msg, extra) => line('warn', msg, extra),
  error: (msg, extra) => line('error', msg, extra),
};

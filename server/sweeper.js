'use strict';
// 清理：canceled 立即删 .part；receiving 超 TTL → abandoned；abandoned 再超 TTL → 删；
// 孤儿 .part（无 DB 记录）删。默认每 10 分钟跑一次。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const logger = require('./logger');

function createSweeper({ cfg, db, uploads }) {
  const TTL = cfg.incomingTtlHours * 3600000;

  async function sweepNow() {
    let cleaned = 0;
    const now = Date.now();

    // 1) canceled → 立即删 .part + 记录
    const canceled = db.prepare(`SELECT id FROM uploads WHERE state='canceled'`).all();
    for (const r of canceled) {
      try { await fsp.unlink(path.join(cfg.incomingDir, r.id + '.part')); cleaned++; } catch { /* */ }
      db.prepare(`DELETE FROM uploads WHERE id=?`).run(r.id);
    }

    // 2) receiving 超时 → abandoned；abandoned 双倍超时 → 删
    const rows = db.prepare(`SELECT id, state, updated_at FROM uploads WHERE state IN ('receiving','abandoned')`).all();
    for (const r of rows) {
      if (r.state === 'receiving' && now - r.updated_at > TTL) {
        db.prepare(`UPDATE uploads SET state='abandoned', updated_at=? WHERE id=?`).run(now, r.id);
        logger.info('在途上传超时 → abandoned', { uploadId: r.id });
      } else if (r.state === 'abandoned' && now - r.updated_at > TTL) {
        await uploads.releaseFd(r.id);
        try { await fsp.unlink(path.join(cfg.incomingDir, r.id + '.part')); } catch { /* */ }
        db.prepare(`DELETE FROM uploads WHERE id=?`).run(r.id);
        logger.info('abandoned 清理', { uploadId: r.id });
        cleaned++;
      }
    }

    // 3) 孤儿 .part（无 DB 记录）
    try {
      for (const f of await fsp.readdir(cfg.incomingDir)) {
        if (!f.endsWith('.part')) continue;
        const id = f.slice(0, -5);
        const row = db.prepare(`SELECT id FROM uploads WHERE id=?`).get(id);
        if (!row) {
          await fsp.unlink(path.join(cfg.incomingDir, f));
          logger.info('清理孤儿 .part', { file: f });
          cleaned++;
        }
      }
    } catch { /* 目录不存在等 */ }

    return cleaned;
  }

  const timer = setInterval(() => {
    sweepNow().catch((e) => logger.warn('sweeper 异常', { err: String(e) }));
  }, 10 * 60 * 1000);
  timer.unref();

  return { sweepNow, stop: () => clearInterval(timer) };
}

module.exports = { createSweeper };

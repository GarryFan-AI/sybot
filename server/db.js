'use strict';
// 数据层：node:sqlite（Node 24 内置）。WAL + busy_timeout；同步 API，
// 因此所有 SQL 必须走索引、批查重用事务，避免阻塞事件循环。
// uploads 表仅存"在途"上传，complete 后 DELETE 并迁入 assets。

const { DatabaseSync } = require('node:sqlite');
const logger = require('./logger');

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album TEXT NOT NULL DEFAULT '',
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  selected INTEGER DEFAULT 0,
  uploaded INTEGER DEFAULT 0,
  skipped INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  bytes INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  state TEXT NOT NULL,                -- receiving | error | canceled | abandoned
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  mime TEXT,
  album TEXT NOT NULL DEFAULT '',
  quick_key TEXT NOT NULL,
  client_sha256 TEXT,
  chunk_size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  rel_path TEXT,
  token TEXT NOT NULL,
  batch_id INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_uploads_client ON uploads(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_uploads_quick ON uploads(quick_key);
CREATE INDEX IF NOT EXISTS ix_uploads_state ON uploads(state);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album TEXT NOT NULL,
  month TEXT NOT NULL,                -- 'YYYY-MM'
  day TEXT,                           -- 'YYYY-MM-DD' 或 null
  date_source TEXT NOT NULL,          -- exif | mov | mtime | upload
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  rel_path TEXT NOT NULL UNIQUE,      -- 相对 storageRoot，正斜杠
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,        -- 内容权威指纹
  quick_key TEXT NOT NULL,
  asset_mtime INTEGER,
  live_base TEXT,                     -- 疑似 Live Photo 基名（HEIC/MOV 同 basename）
  batch_id INTEGER,
  upload_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assets_album_month ON assets(album, month, name);
CREATE INDEX IF NOT EXISTS ix_assets_quick ON assets(quick_key);
CREATE INDEX IF NOT EXISTS ix_assets_name_size ON assets(name, size);
`;

function open(cfg) {
  const db = new DatabaseSync(cfg.dbFile);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(SCHEMA_SQL);

  const ver = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  if (!ver) {
    db.prepare(`INSERT INTO meta(key,value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION));
  } else if (Number(ver.value) > SCHEMA_VERSION) {
    throw new Error(`数据库版本(${ver.value})高于程序版本(${SCHEMA_VERSION})，请升级程序`);
  }

  // 简易事务封装：fn 内所有语句在同一 IMMEDIATE 事务，异常自动回滚
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
      throw e;
    }
  };

  const backup = (toFile) => {
    // node:sqlite 的 session.backup 在部分版本不可用时退化为 VACUUM INTO
    try {
      db.exec(`VACUUM INTO '${toFile.replace(/'/g, "''")}'`);
      return true;
    } catch (e) {
      logger.error('db.backup 失败', { err: e.message });
      return false;
    }
  };

  logger.info('数据库已打开', { file: cfg.dbFile, version: SCHEMA_VERSION });
  return { db, tx, backup };
}

// 启动对账：崩溃后 DB 的 received 可能超前/落后于磁盘实际，统一收敛为 min(fstat, db)
function reconcileUploads({ db }, incomingDir, fs) {
  const rows = db.prepare(`SELECT id, received, size FROM uploads WHERE state='receiving'`).all();
  let fixed = 0;
  for (const r of rows) {
    const partPath = require('node:path').join(incomingDir, r.id + '.part');
    let actual = 0;
    try {
      actual = fs.statSync(partPath).size;
    } catch {
      actual = 0; // .part 丢失 → 从头
    }
    const safe = Math.min(actual, r.received, r.size);
    if (safe !== r.received) {
      db.prepare(`UPDATE uploads SET received=?, updated_at=? WHERE id=?`)
        .run(safe, Date.now(), r.id);
      fixed++;
      if (actual > r.received) {
        // 磁盘多于 DB 记录：截断到安全值，多余部分下次重写
        try {
          const fd = fs.openSync(partPath, 'r+');
          fs.ftruncateSync(fd, safe);
          fs.closeSync(fd);
        } catch { /* 忽略 */ }
      }
    }
  }
  if (fixed) logger.info(`启动对账：修正 ${fixed} 条在途上传的 offset`);
  return fixed;
}

module.exports = { open, reconcileUploads };

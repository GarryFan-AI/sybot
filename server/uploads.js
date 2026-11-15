'use strict';
// 在途上传生命周期与分块写入（正确性核心）。
// 三条不变量：
//  1) DB uploads.received 是唯一可信 offset：仅"写入 + fsync + fstat 确认"后更新；
//  2) 写块前先 ftruncate(fd, received)：同 offset 重写幂等；
//  3) complete 以 fstat + worker sha256 + 事务迁移为准（见 api.js）。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ApiError } = require('./router');
const { sanitizeName } = require('./storage');
const logger = require('./logger');

// quickKey 分隔符：用 String.fromCharCode(0)（源码保持纯 ASCII，避免转义歧义）。
// 文件名不可能包含 NUL，因此可作为安全分隔符。
const SEP = String.fromCharCode(0);

// mtime 缺失/为 0 时退化为 name+size（第三段用空串占位），查重端标注 ambiguous
function quickKeyOf(name, size, mtime) {
  const m = Number(mtime) > 0 ? String(Number(mtime)) : '';
  return String(name) + SEP + String(size) + SEP + m;
}

function newUploadId() {
  return 'u' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function chunkSizeFor(size) {
  return size < 200 * 1024 * 1024 ? 4 * 1024 * 1024 : 8 * 1024 * 1024;
}

class Uploads {
  constructor({ db, tx, cfg, secret }) {
    this.db = db;
    this.tx = tx;
    this.cfg = cfg;
    this.secret = secret;
    this.fdCache = new Map(); // id -> {fd, lastUsed, timer}
    this.maxFd = 8;
    this.idleMs = 30000;
  }

  partPath(id) {
    // id 由服务端生成（字母数字），这里仍做白名单防御
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ApiError(400, 'INVALID_ARGUMENT', '非法 uploadId');
    return path.join(this.cfg.incomingDir, id + '.part');
  }

  tokenFor(id) {
    return crypto.createHmac('sha256', this.secret).update(id).digest('base64url').slice(0, 32);
  }

  get(id) {
    return this.db.prepare(`SELECT * FROM uploads WHERE id=?`).get(id);
  }

  countReceiving() {
    return this.db.prepare(`SELECT count(*) n FROM uploads WHERE state='receiving'`).get().n;
  }

  // 创建（new）或续传（resume）。命中已有资产由调用方（api.js 的 init）先行处理。
  async createOrResume({ name, size, mtime, mime, album, clientUploadId, clientSha256, quickKey, batchId }) {
    // client_id 幂等：同一文件重试 init 返回同一条
    if (clientUploadId) {
      const exist = this.db.prepare(`SELECT * FROM uploads WHERE client_id=?`).get(clientUploadId);
      if (exist) return { row: exist, status: exist.received > 0 ? 'resume' : 'new' };
    }
    // quickKey 命中在途且 size 一致 → resume（取已收最多的那条）
    const partials = this.db.prepare(
      `SELECT * FROM uploads WHERE quick_key=? AND state IN ('receiving','abandoned') AND size=? ORDER BY received DESC LIMIT 1`
    ).all(quickKey, size);
    if (partials.length) {
      const row = partials[0];
      if (clientUploadId && row.client_id !== clientUploadId) {
        this.db.prepare(`UPDATE uploads SET client_id=?, album=?, batch_id=?, updated_at=? WHERE id=?`)
          .run(clientUploadId, album, batchId, Date.now(), row.id);
        row.client_id = clientUploadId;
        row.album = album;
      }
      return { row, status: 'resume' };
    }

    const id = newUploadId();
    const token = this.tokenFor(id);
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO uploads(id,client_id,state,name,size,mtime,mime,album,quick_key,client_sha256,chunk_size,received,token,batch_id,created_at,updated_at)
       VALUES(?,?,'receiving',?,?,?,?,?,?,?,?,0,?,?,?,?)`
    ).run(id, clientUploadId || null, name, size, mtime, mime || null, album, quickKey, clientSha256 || null,
      chunkSizeFor(size), token, batchId || null, now, now);
    // 预创建空 .part（避免 chunk 端判断文件存在）
    const fh = await fsp.open(this.partPath(id), 'a');
    await fh.close();
    return { row: this.get(id), status: 'new' };
  }

  // 取写句柄（LRU 缓存，空闲 30s 释放）
  async acquireFd(id) {
    const e = this.fdCache.get(id);
    if (e) {
      e.lastUsed = Date.now();
      clearTimeout(e.timer);
      e.timer = setTimeout(() => this.releaseFd(id), this.idleMs).unref();
      return e.fd;
    }
    const p = this.partPath(id);
    if (!fs.existsSync(p)) {
      const fh = await fsp.open(p, 'a');
      await fh.close();
    }
    const fd = await fsp.open(p, 'r+');
    this.evictIfNeeded();
    const timer = setTimeout(() => this.releaseFd(id), this.idleMs).unref();
    this.fdCache.set(id, { fd, lastUsed: Date.now(), timer });
    return fd;
  }

  evictIfNeeded() {
    while (this.fdCache.size >= this.maxFd) {
      const oldest = [...this.fdCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      this.releaseFd(oldest[0]);
    }
  }

  async releaseFd(id) {
    const e = this.fdCache.get(id);
    if (!e) return;
    this.fdCache.delete(id);
    clearTimeout(e.timer);
    try { await e.fd.close(); } catch { /* */ }
  }

  // 写块。offset 必须等于 DB received，否则 409+expected（客户端对账后续传）。
  async writeChunk(id, offset, buf) {
    const row = this.get(id);
    if (!row) throw new ApiError(404, 'UNKNOWN_UPLOAD', '上传不存在或已清理');
    if (row.state !== 'receiving') throw new ApiError(409, 'STATE_CONFLICT', `上传状态为 ${row.state}`);
    const expected = row.received;
    if (offset !== expected) {
      throw new ApiError(409, 'OFFSET_MISMATCH', 'offset 与服务端不符，请对账续传', { expected });
    }
    if (offset + buf.length > row.size) {
      throw new ApiError(422, 'SIZE_OVERFLOW', '写入越界：offset+len 超过声明 size');
    }
    if (buf.length === 0) {
      return { row, received: expected };
    }

    const fd = await this.acquireFd(id);
    let wrote = 0;
    try {
      await fd.truncate(offset);          // 幂等：截到可信 offset
      wrote = await this.writeAll(fd, buf, offset);
      await fd.sync();                    // fsync 后才算落定
      const st = await fd.stat();
      if (st.size !== offset + wrote) {
        throw new ApiError(500, 'INTERNAL', `落盘校验失败: size=${st.size} 期望=${offset + wrote}`);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e.code === 'ENOSPC') throw new ApiError(503, 'INSUFFICIENT_SPACE', '磁盘空间不足');
      throw e;
    }
    const received = offset + wrote;
    this.db.prepare(`UPDATE uploads SET received=?, updated_at=? WHERE id=?`).run(received, Date.now(), id);
    return { row, received };
  }

  async writeAll(fd, buf, position) {
    let written = 0;
    while (written < buf.length) {
      const r = await fd.write(buf, written, buf.length - written, position + written);
      if (r.bytesWritten <= 0) throw new Error('write 返回 0');
      written += r.bytesWritten;
    }
    return written;
  }

  // 取消：删 .part 与记录
  async cancel(id) {
    const row = this.get(id);
    if (!row) return false;
    await this.releaseFd(id);
    this.db.prepare(`UPDATE uploads SET state='canceled', updated_at=? WHERE id=?`).run(Date.now(), id);
    try { await fsp.unlink(this.partPath(id)); } catch { /* */ }
    this.db.prepare(`DELETE FROM uploads WHERE id=?`).run(id);
    return true;
  }

  // complete 成功/内容重复后清理记录与 .part
  async purge(id) {
    await this.releaseFd(id);
    try { await fsp.unlink(this.partPath(id)); } catch { /* */ }
    this.db.prepare(`DELETE FROM uploads WHERE id=?`).run(id);
  }

  async closeAll() {
    for (const id of [...this.fdCache.keys()]) await this.releaseFd(id);
  }
}

module.exports = { Uploads, quickKeyOf, newUploadId, chunkSizeFor, SEP };

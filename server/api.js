'use strict';
// REST API 绑定。所有路由挂在 restPath（/k/<key> 已由 access 层剥掉并校验）。
// 两条上传路径：
//  1) 分块协议（网页客户端）：init → chunk × N → complete，支持断点续传；
//  2) /api/quick 单请求直传（iOS 快捷指令用）：整文件一个请求，服务端内部走同样的
//     查重/哈希/归档流水线；原始体流式落盘（不整读进内存），multipart 则缓冲解析。

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { ApiError, readJson, readRaw, sendJson } = require('./router');
const { quickKeyOf, chunkSizeFor } = require('./uploads');
const { checkItems, findAsset } = require('./dedup');
const { sanitizeAlbum, sanitizeName, sniffExt, archivePart, renameWithRetry, freeBytes } = require('./storage');
const { captureDate, monthDay } = require('./exifdate');

const VERSION = '1.0.0';
const MAX_ITEMS = 2000;
const MULTIPART_CAP = 256 * 1024 * 1024; // multipart 缓冲上限（大视频请走网页分块）

function register(router, deps) {
  const { cfg, db, tx, uploads, hashPool, backup, sweepNow, log, startedAt } = deps;

  // ---------- 基础 ----------
  router.add('GET', '/api/health', async (ctx) => {
    sendJson(ctx.res, 200, {
      ok: true,
      version: VERSION,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      storageRoot: cfg.storageRoot,
      freeBytes: await freeBytes(cfg.storageRoot),
      incomingTtlHours: cfg.incomingTtlHours,
      hashMaxBytes: cfg.hashMaxBytes,
    });
  });

  router.add('GET', '/api/stats', async (ctx) => {
    const total = db.prepare(`SELECT count(*) n, COALESCE(sum(size),0) b FROM assets`).get();
    const byAlbum = db.prepare(
      `SELECT album, count(*) n, COALESCE(sum(size),0) b, min(month) m0, max(month) m1
       FROM assets GROUP BY album ORDER BY n DESC`
    ).all();
    const receiving = db.prepare(
      `SELECT id, name, size, received FROM uploads WHERE state IN ('receiving','abandoned') ORDER BY updated_at DESC LIMIT 50`
    ).all();
    const last = db.prepare(`SELECT max(created_at) t FROM assets`).get();
    sendJson(ctx.res, 200, {
      version: VERSION,
      storageRoot: cfg.storageRoot,
      freeBytes: await freeBytes(cfg.storageRoot),
      total: { count: total.n, bytes: total.b },
      byAlbum,
      receiving: { count: receiving.length, items: receiving },
      lastCompletedAt: last.t || null,
    });
  });

  // ---------- 批次 ----------
  router.add('POST', '/api/batch/start', async (ctx) => {
    const body = await readJson(ctx, 8 * 1024);
    const album = sanitizeAlbum(body.album);
    const r = db.prepare(`INSERT INTO batches(album, started_at) VALUES(?,?)`).run(album, Date.now());
    sendJson(ctx.res, 200, { batchId: Number(r.lastInsertRowid), album });
  });

  router.add('POST', '/api/batch/:id/finish', async (ctx) => {
    const id = Number(ctx.params.id);
    const body = await readJson(ctx, 8 * 1024);
    const row = db.prepare(`SELECT * FROM batches WHERE id=?`).get(id);
    if (!row) throw new ApiError(404, 'UNKNOWN_BATCH', '批次不存在');
    db.prepare(`UPDATE batches SET finished_at=?, selected=?, skipped=?, failed=? WHERE id=?`)
      .run(Date.now(), Number(body.selected) || 0, Number(body.skipped) || 0, Number(body.failed) || 0, id);
    sendJson(ctx.res, 200, { batch: db.prepare(`SELECT * FROM batches WHERE id=?`).get(id) });
  });

  router.add('GET', '/api/batches', async (ctx) => {
    const limit = Math.min(Number(ctx.query.get('limit')) || 20, 100);
    sendJson(ctx.res, 200, { batches: db.prepare(`SELECT * FROM batches ORDER BY id DESC LIMIT ?`).all(limit) });
  });

  // ---------- 批量查重 ----------
  router.add('POST', '/api/sync/check', async (ctx) => {
    const body = await readJson(ctx, 1024 * 1024);
    const t0 = Date.now();
    const items = body.items;
    if (!Array.isArray(items) || items.length > MAX_ITEMS) {
      throw new ApiError(400, 'INVALID_ARGUMENT', `items 须为 ≤${MAX_ITEMS} 的数组`);
    }
    sendJson(ctx.res, 200, { results: checkItems(db, items), tookMs: Date.now() - t0 });
  });

  // ---------- 上传：init / chunk / status / cancel / complete ----------
  router.add('POST', '/api/upload/init', async (ctx) => {
    const body = await readJson(ctx, 64 * 1024);
    const name = sanitizeName(body.name);
    const size = Number(body.size);
    const mtime = Number(body.mtime) || 0;
    const mime = typeof body.type === 'string' ? body.type.slice(0, 100) : null;
    const album = sanitizeAlbum(body.albumTag);
    const clientUploadId = typeof body.clientUploadId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.clientUploadId)
      ? body.clientUploadId : null;
    const sha = typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(body.sha256)
      ? body.sha256.toLowerCase() : null;
    const batchId = Number(body.batchId) > 0 ? Number(body.batchId) : null;
    if (!name || !Number.isFinite(size) || size < 0 || size > 2 * 1024 ** 4) {
      throw new ApiError(400, 'INVALID_ARGUMENT', 'name/size 非法');
    }
    const qk = quickKeyOf(name, size, mtime);

    const hit = findAsset(db, { sha, quickKey: qk, size, name, mtime });
    if (hit && hit.asset) {
      sendJson(ctx.res, 200, {
        status: 'exists',
        assetId: hit.asset.id,
        relPath: hit.asset.rel_path,
        sha256: hit.asset.sha256,
        size: hit.asset.size,
        captureDate: hit.asset.month,
        dateSource: hit.asset.date_source,
        by: hit.by,
      });
      return;
    }

    if (uploads.countReceiving() >= cfg.maxInFlight) {
      throw new ApiError(429, 'RATE_LIMITED', '在途上传数达上限', { retryAfterMs: 5000 });
    }
    if ((await freeBytes(cfg.storageRoot)) < size) {
      throw new ApiError(503, 'INSUFFICIENT_SPACE', '磁盘剩余空间不足');
    }

    const { row, status } = await uploads.createOrResume({
      name, size, mtime, mime, album, clientUploadId, clientSha256: sha, quickKey: qk, batchId,
    });
    sendJson(ctx.res, 200, {
      status,
      uploadId: row.id,
      token: row.token,
      offset: row.received,
      chunkSize: row.chunk_size || chunkSizeFor(size),
      ambiguous: hit && hit.ambiguous ? true : undefined,
    });
  });

  router.add('PUT', '/api/upload/:id/chunk', async (ctx) => {
    const id = ctx.params.id;
    const row = uploads.get(id);
    if (!row) throw new ApiError(404, 'UNKNOWN_UPLOAD', '上传不存在或已清理');
    const token = ctx.req.headers['x-token'];
    if (!token || token !== row.token) throw new ApiError(403, 'BAD_TOKEN', 'token 不符，请重新 init');

    const buf = await readRaw(ctx, cfg.maxChunkBytes + 1024);
    const offset = Number(ctx.req.headers['x-offset']);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new ApiError(400, 'INVALID_ARGUMENT', 'X-Offset 非法');
    }
    const { received } = await uploads.writeChunk(id, offset, buf);
    sendJson(ctx.res, 200, { uploadId: id, offset, received, size: row.size, done: received >= row.size });
  });

  router.add('GET', '/api/upload/:id', async (ctx) => {
    const row = uploads.get(ctx.params.id);
    if (!row) throw new ApiError(404, 'UNKNOWN_UPLOAD', '上传不存在或已清理');
    sendJson(ctx.res, 200, {
      uploadId: row.id, state: row.state, offset: row.received, size: row.size,
      name: row.name, album: row.album, chunkSize: row.chunk_size, token: row.token,
      mtime: row.mtime, createdAt: row.created_at, updatedAt: row.updated_at,
    });
  });

  router.add('DELETE', '/api/upload/:id', async (ctx) => {
    const row = uploads.get(ctx.params.id);
    if (!row) throw new ApiError(404, 'UNKNOWN_UPLOAD', '上传不存在或已清理');
    const token = ctx.req.headers['x-token'];
    if (!token || token !== row.token) throw new ApiError(403, 'BAD_TOKEN', 'token 不符');
    await uploads.cancel(ctx.params.id);
    sendJson(ctx.res, 200, { canceled: true });
  });

  router.add('POST', '/api/upload/:id/complete', async (ctx) => {
    const id = ctx.params.id;
    const row = uploads.get(id);
    if (!row) throw new ApiError(404, 'UNKNOWN_UPLOAD', '上传不存在或已清理');
    if (row.state !== 'receiving' && row.state !== 'abandoned') {
      throw new ApiError(409, 'STATE_CONFLICT', `上传状态为 ${row.state}`);
    }
    const token = ctx.req.headers['x-token'] || (await readJson(ctx, 4096)).token;
    if (!token || token !== row.token) throw new ApiError(403, 'BAD_TOKEN', 'token 不符');

    const partPath = uploads.partPath(id);
    let st;
    try {
      st = await fsp.stat(partPath);
    } catch {
      db.prepare(`UPDATE uploads SET received=0, updated_at=? WHERE id=?`).run(Date.now(), id);
      throw new ApiError(422, 'SIZE_MISMATCH', '.part 丢失，需从头续传', { expected: 0 });
    }
    if (st.size < row.size) {
      throw new ApiError(422, 'SIZE_MISMATCH', '文件不完整，请继续分块', { expected: row.received, have: st.size });
    }
    if (st.size > row.size) {
      await uploads.purge(id);
      throw new ApiError(422, 'SIZE_OVERFLOW', '落盘大于声明 size，已清理，请重新 init');
    }
    if (row.received < row.size) {
      db.prepare(`UPDATE uploads SET received=?, updated_at=? WHERE id=?`).run(row.size, Date.now(), id);
    }

    const out = await finalizeUpload(row, partPath);
    sendJson(ctx.res, 200, out);
  });

  // ---------- 快捷指令直传（整文件单请求） ----------
  // POST /api/quick?name=IMG_0001.HEIC&album=家人[&mtime=1735689600000|2024:01:15 08:30:00]
  // 体：原始文件字节（流式落盘）或 multipart/form-data 的第一个文件字段
  router.add('POST', '/api/quick', async (ctx) => {
    ctx.log.info('quick 请求', { raw: ctx.req.url }); // 排查快捷指令拼参：记录原始查询串
    const name = sanitizeName(ctx.query.get('name') || '');
    const album = sanitizeAlbum(ctx.query.get('album') || '');
    const mtime = parseMtime(ctx.query.get('mtime') || ctx.req.headers['x-mtime']);
    if (!name) throw new ApiError(400, 'INVALID_ARGUMENT', '缺少 name 参数');

    const contentType = ctx.req.headers['content-type'] || '';
    let buf = null;               // multipart 时缓冲的文件字节
    let partName = null;          // multipart 里的 filename
    let contentLength = Number(ctx.req.headers['content-length'] || 0);

    if (/^multipart\/form-data/i.test(contentType)) {
      const raw = await readRaw(ctx, MULTIPART_CAP);
      const part = parseFirstFilePart(raw, contentType);
      if (!part) throw new ApiError(400, 'INVALID_ARGUMENT', 'multipart 中未找到文件字段');
      buf = part.data;
      if (part.filename) partName = part.filename;
      contentLength = buf.length;
    } else if (!contentLength) {
      // 无 Content-Length（chunked 编码）：缓冲（受上限约束）
      buf = await readRaw(ctx, MULTIPART_CAP);
      contentLength = buf.length;
    }

    const size = buf ? buf.length : contentLength;
    if (!size) throw new ApiError(400, 'INVALID_ARGUMENT', '请求体为空');
    if ((await freeBytes(cfg.storageRoot)) < size) {
      throw new ApiError(503, 'INSUFFICIENT_SPACE', '磁盘剩余空间不足');
    }

    const finalName = sanitizeName(partName || name);
    const qk = quickKeyOf(finalName, size, mtime);
    const hit = findAsset(db, { quickKey: qk, size, name: finalName, mtime });
    if (hit && hit.asset) {
      sendJson(ctx.res, 200, {
        status: 'exists', assetId: hit.asset.id, relPath: hit.asset.rel_path,
        sha256: hit.asset.sha256, size: hit.asset.size, by: hit.by,
      });
      return;
    }
    // 半成品旧记录与整文件重传冲突：删掉重来（quick 路径不支持续传）
    if (hit && hit.partial) await uploads.cancel(hit.partial.id);

    if (uploads.countReceiving() >= cfg.maxInFlight) {
      throw new ApiError(429, 'RATE_LIMITED', '在途上传数达上限', { retryAfterMs: 5000 });
    }
    const { row } = await uploads.createOrResume({
      name: finalName, size, mtime, mime: contentType.split(';')[0] || null,
      album, clientUploadId: null, clientSha256: null, quickKey: qk, batchId: null,
    });
    const partPath = uploads.partPath(row.id);

    if (buf) {
      // multipart：已缓冲，走 writeChunk（复用 ftruncate+fsync 语义）
      await uploads.writeChunk(row.id, 0, buf);
    } else {
      // 原始体：流式落盘（任意大小，不占内存）
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(partPath, { flags: 'r+', start: 0 });
        ctx.req.on('error', reject);
        ws.on('error', reject);
        ctx.req.pipe(ws);
        ws.on('finish', resolve);
      });
      const fh = await fsp.open(partPath, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
      const st = await fsp.stat(partPath);
      if (st.size !== size) throw new ApiError(422, 'SIZE_MISMATCH', `落盘长度 ${st.size} 与 Content-Length ${size} 不符`);
      db.prepare(`UPDATE uploads SET received=?, updated_at=? WHERE id=?`).run(size, Date.now(), row.id);
    }

    const out = await finalizeUpload(row, partPath);
    sendJson(ctx.res, 200, out);
  });

  // ---------- 共享：哈希 → 去重 → 日期 → 归档 → 入库 ----------
  async function finalizeUpload(row, partPath) {
    // 内容 sha256（权威；不能边收边算——Node Hash 状态无法跨续传请求持久化）
    const hex = await hashPool.hashFile(partPath);
    if (row.client_sha256 && row.client_sha256.toLowerCase() !== hex) {
      await uploads.purge(row.id);
      throw new ApiError(422, 'HASH_MISMATCH', '内容校验失败，请重新上传');
    }
    const dup = db.prepare(`SELECT id, rel_path FROM assets WHERE sha256=?`).get(hex);
    if (dup) {
      await uploads.purge(row.id);
      return { status: 'exists', assetId: dup.id, relPath: dup.rel_path, sha256: hex, size: row.size };
    }

    // 扩展名以魔数为准（防 iOS 转码误标）
    let name = row.name;
    const magic = await sniffExt(partPath);
    const declaredExt = path.extname(name).slice(1).toLowerCase();
    let ext = declaredExt || 'bin';
    if (magic && magic !== declaredExt && !(declaredExt === 'jpe' && magic === 'jpg')) {
      log.warn('扩展名与魔数不符，以魔数为准', { name, magic, declaredExt });
      ext = magic;
      name = `${name.slice(0, name.length - path.extname(name).length)}.${magic}`;
    }

    // 拍摄日期 → 目录（扩展名判断用原始文件名，实际读取用 .part）
    const cd = await captureDate(partPath, { mtimeMs: row.mtime, mime: row.mime, fileNameHint: row.name });
    const { month, day } = monthDay(cd.epochMs);

    const finalName = sanitizeName(name);
    let inserted = null;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const { relPath, absPath } = await archivePart({
        storageRoot: cfg.storageRoot, incomingDir: cfg.incomingDir,
        uploadId: row.id, album: row.album, month, name: finalName, sha256hex: hex,
      });
      try {
        inserted = tx(() => {
          const r = db.prepare(
            `INSERT INTO assets(album,month,day,date_source,name,ext,rel_path,size,sha256,quick_key,asset_mtime,live_base,batch_id,upload_id,created_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).run(row.album, month, day, cd.source, finalName, ext, relPath, row.size, hex, row.quick_key,
            row.mtime > 0 ? row.mtime : null, liveBaseOf(finalName), row.batch_id, row.id, Date.now());
          db.prepare(`DELETE FROM uploads WHERE id=?`).run(row.id);
          if (row.batch_id) {
            db.prepare(`UPDATE batches SET uploaded=uploaded+1, bytes=bytes+? WHERE id=?`).run(row.size, row.batch_id);
          }
          return { assetId: Number(r.lastInsertRowid), relPath };
        });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) {
          const dupRow = db.prepare(`SELECT id, rel_path FROM assets WHERE sha256=?`).get(hex);
          if (dupRow) {
            try { await fsp.unlink(absPath); } catch { /* */ }
            await uploads.purge(row.id);
            return { status: 'exists', assetId: dupRow.id, relPath: dupRow.rel_path, sha256: hex, size: row.size };
          }
          try { await renameWithRetry(absPath, partPath); } catch (e2) {
            log.error('归档回滚失败', { absPath, err: String(e2) });
            throw e2;
          }
          continue;
        }
        throw e;
      }
    }
    if (!inserted) throw new ApiError(500, 'INTERNAL', '归档重试耗尽');

    return {
      status: 'completed',
      assetId: inserted.assetId,
      relPath: inserted.relPath,
      album: row.album,
      month, day,
      captureDate: month,
      dateSource: cd.source,
      size: row.size,
      sha256: hex,
      renamed: finalName !== row.name,
    };
  }

  // ---------- 浏览 ----------
  router.add('GET', '/api/albums', async (ctx) => {
    const rows = db.prepare(
      `SELECT album, count(*) count, COALESCE(sum(size),0) bytes, min(month) firstMonth, max(month) lastMonth
       FROM assets GROUP BY album ORDER BY album`
    ).all();
    const months = db.prepare(
      `SELECT album, month, count(*) count FROM assets GROUP BY album, month ORDER BY album, month DESC`
    ).all();
    const byAlbum = new Map(rows.map((r) => [r.album, r]));
    for (const m of months) {
      const a = byAlbum.get(m.album);
      if (a) (a.months = a.months || []).push({ month: m.month, count: m.count });
    }
    sendJson(ctx.res, 200, { albums: rows });
  });

  router.add('GET', '/api/assets', async (ctx) => {
    const album = ctx.query.get('album');
    const month = ctx.query.get('month');
    const q = ctx.query.get('q');
    const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 100, 1), 500);
    const offset = Math.max(Number(ctx.query.get('offset')) || 0, 0);
    const where = [];
    const args = [];
    if (album) { where.push('album=?'); args.push(sanitizeAlbum(album)); }
    if (month) { where.push('month=?'); args.push(month); }
    if (q) { where.push(`name LIKE ? ESCAPE '\\'`); args.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) n FROM assets ${whereSql}`).get(...args).n;
    const rows = db.prepare(
      `SELECT id, album, month, day, date_source, name, ext, rel_path, size, sha256, created_at
       FROM assets ${whereSql} ORDER BY month DESC, name LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);
    sendJson(ctx.res, 200, { total, items: rows.map(assetRowToDto) });
  });

  router.add('GET', '/media/:assetId', async (ctx) => {
    const row = db.prepare(`SELECT * FROM assets WHERE id=?`).get(Number(ctx.params.assetId));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '资产不存在');
    const abs = path.join(cfg.storageRoot, ...row.rel_path.split('/'));
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new ApiError(404, 'ASSET_FILE_MISSING', '文件已在磁盘上被移除');
    }
    const MIME_BY_EXT = {
      heic: 'image/heic', heif: 'image/heic', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp', gif: 'image/gif',
      mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4',
    };
    const type = MIME_BY_EXT[row.ext] || 'application/octet-stream';
    const range = ctx.req.headers.range;
    const base = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    };
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) { start = Math.max(st.size - end, 0); end = st.size - 1; }
        if (start === null) start = 0;
        if (end === null || end >= st.size) end = st.size - 1;
        if (start > end || start >= st.size) {
          ctx.res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
          ctx.res.end();
          return;
        }
        ctx.res.writeHead(206, {
          ...base,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(abs, { start, end }).pipe(ctx.res);
        return;
      }
    }
    ctx.res.writeHead(200, { ...base, 'Content-Length': st.size });
    fs.createReadStream(abs).pipe(ctx.res);
  });

  // ---------- 管理 ----------
  router.add('POST', '/api/admin/backup', async (ctx) => {
    const dir = path.join(cfg.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `app-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    const ok = backup(file);
    sendJson(ctx.res, ok ? 200 : 500, ok ? { backup: file } : { error: { code: 'BACKUP_FAILED', message: '备份失败，见日志' } });
  });

  router.add('POST', '/api/admin/cleanup', async (ctx) => {
    sendJson(ctx.res, 200, { cleaned: await sweepNow() });
  });
}

// mtime：epoch 毫秒 或 "yyyy-MM-dd HH:mm[:ss]"/"yyyy:MM:dd HH:mm[:ss]"（按服务器本地时区）
function parseMtime(raw) {
  if (!raw) return 0;
  const s = String(raw).trim();
  if (/^\d{12,14}$/.test(s)) return Number(s); // epoch ms（12~14 位）
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]) || 0).getTime();
  }
  return 0;
}

// 极简 multipart 解析：取第一个带 filename 的字段
function parseFirstFilePart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  let pos = buf.indexOf(boundary);
  while (pos !== -1) {
    const headStart = pos + boundary.length;
    if (buf.slice(headStart, headStart + 2).toString() === '--') return null; // 结束
    const headEnd = buf.indexOf('\r\n\r\n', headStart);
    if (headEnd === -1) return null;
    const headers = buf.slice(headStart + 2, headEnd).toString('utf8');
    const bodyStart = headEnd + 4;
    const next = buf.indexOf(boundary, bodyStart);
    if (next === -1) return null;
    const fn = /filename="([^"]*)"/i.exec(headers);
    if (fn) {
      return { filename: decodeURIComponent(fn[1]), data: buf.slice(bodyStart, next - 2) };
    }
    pos = next;
  }
  return null;
}

function assetRowToDto(r) {
  return {
    id: r.id, album: r.album, month: r.month, day: r.day, dateSource: r.date_source,
    name: r.name, ext: r.ext, relPath: r.rel_path, size: r.size, sha256: r.sha256,
    createdAt: r.created_at,
  };
}

// 疑似 Live Photo 基名：取主文件名（HEIC/MOV 同 basename 即疑似一对）
function liveBaseOf(name) {
  const e = path.extname(name);
  return e ? name.slice(0, -e.length) : name;
}

module.exports = { register, VERSION };

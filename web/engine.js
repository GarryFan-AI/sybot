// 上传引擎：过滤 → 哈希 → init → 分块 → complete。
// 原则：进度只认"服务端已确认的 received"；任何中断先对账（GET upload/:id）再续传；
// 不整读文件（哈希与分块都用 Blob.slice，内存恒定）；切后台立即 abort 在途请求。

import { sha256OfBlob } from './vendor/sha256.js';

export class BatchAbort extends Error { constructor(msg) { super(msg); this.batchAbort = true; } }

const CHECK_CHUNK = 500;        // 批量查重每批条数
const DEFAULT_CONCURRENCY = 2;  // 在途文件数
const HASH_SLICE = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Engine {
  constructor({ baseUrl, onEvent }) {
    this.baseUrl = baseUrl;      // '/k/<key>'
    this.onEvent = onEvent || (() => {});
    this.jobs = [];
    this.paused = false;
    this.stopped = false;
    this.frozen = false;         // 切后台/断网冻结
    this.aborters = new Set();   // 在途请求的 AbortController
    this.stats = { uploaded: 0, skipped: 0, failed: 0, bytes: 0 };
  }

  // —— HTTP ——
  async api(method, path, { body, headers, timeoutMs = 15000, type } = {}) {
    const ctrl = new AbortController();
    this.aborters.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/api/${path}`, {
        method,
        headers: { ...(headers || {}) },
        body,
        signal: ctrl.signal,
        ...(type ? { duplex: 'half' } : {}),
      });
    } catch (e) {
      throw { kind: 'network', message: String(e && e.message || e) };
    } finally {
      clearTimeout(timer);
      this.aborters.delete(ctrl);
    }
    if (!res.ok) {
      let err = {};
      try { err = await res.json(); } catch { /* */ }
      const e = err.error || {};
      throw {
        kind: 'http', status: res.status, code: e.code || 'HTTP_' + res.status,
        message: e.message || '', expected: e.expected, have: e.have, retryAfterMs: e.retryAfterMs,
      };
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  chunkTimeout(chunkSize) { return chunkSize > 4 * 1024 * 1024 ? 90000 : 45000; }

  async backoff(attempt) {
    const base = Math.min(60000, 1000 * 2 ** attempt);
    const jitter = base * (0.7 + 0.6 * Math.random());
    this.onEvent('wait', { ms: Math.round(jitter), attempt });
    await sleep(jitter);
  }

  async waitForLive() {
    // 冻结态（后台/断网）下等待恢复：online 事件由 app.js 监听并解除冻结
    while (this.frozen && !this.stopped) await sleep(500);
  }

  // —— 阶段 1：批量指纹查重（零读取） ——
  async filterFiles(files) {
    const jobs = [];
    for (let i = 0; i < files.length; i++) {
      jobs.push({
        i, file: files[i], name: files[i].name, size: files[i].size, mtime: files[i].lastModified || 0,
        state: 'pending', offset: 0, uploadId: null, token: null, chunkSize: 0, sha: null, error: null,
        clientId: Date.now().toString(36) + i.toString(36) + Math.random().toString(36).slice(2, 8),
      });
    }
    for (let off = 0; off < jobs.length; off += CHECK_CHUNK) {
      const group = jobs.slice(off, off + CHECK_CHUNK);
      await this.waitForLive();
      const r = await this.withRetry(() => this.api('POST', 'sync/check', {
        body: JSON.stringify({ items: group.map((j) => ({ name: j.name, size: j.size, mtime: j.mtime })) }),
        timeoutMs: 30000,
      }));
      r.results.forEach((res, k) => {
        const j = group[k];
        if (res.state === 'done') { j.state = 'exists'; j.relPath = res.relPath; }
        else if (res.state === 'partial') { j.state = 'pending'; j.resumeUploadId = res.uploadId; j.resumeOffset = res.offset; }
      });
      this.onEvent('filter', { scanned: Math.min(off + CHECK_CHUNK, jobs.length), total: jobs.length });
    }
    return jobs;
  }

  // —— 阶段 2：幸存者哈希 + 二次查重（内容级去重） ——
  async hashSurvivors(jobs, hashMaxBytes) {
    const survivors = jobs.filter((j) => j.state === 'pending');
    const small = survivors.filter((j) => j.size <= hashMaxBytes);
    for (const j of small) {
      if (this.stopped) break;
      j.state = 'hashing';
      this.onEvent('file', snap(j));
      try {
        j.sha = await this.withRetry(() => sha256OfBlob(j.file, {
          sliceSize: HASH_SLICE,
          onProgress: (done, total) => this.onEvent('hash', { i: j.i, done, total }),
        }));
      } catch {
        j.sha = null; // 哈希失败不阻断，靠服务端内容判重
      }
      j.state = 'pending';
    }
    if (small.length) {
      for (let off = 0; off < small.length; off += CHECK_CHUNK) {
        const group = small.slice(off, off + CHECK_CHUNK);
        await this.waitForLive();
        const r = await this.withRetry(() => this.api('POST', 'sync/check', {
          body: JSON.stringify({ items: group.map((j) => ({ name: j.name, size: j.size, mtime: j.mtime, sha256: j.sha || undefined })) }),
          timeoutMs: 30000,
        }));
        r.results.forEach((res, k) => {
          const j = group[k];
          if (res.state === 'done' && j.state === 'pending') { j.state = 'exists'; j.relPath = res.relPath; }
        });
      }
    }
    return jobs;
  }

  // —— 阶段 3：并发上传 ——
  async uploadAll(jobs, { batchId, albumTag, concurrency = DEFAULT_CONCURRENCY }) {
    // 预过滤阶段已判 exists 的文件在此计入 skipped（uploadOne 只处理进入队列的）
    for (const j of jobs) if (j.state === 'exists') this.stats.skipped++;
    const queue = jobs.filter((j) => j.state === 'pending');
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (!this.stopped) {
        const j = queue[cursor++];
        if (!j) return;
        try {
          await this.uploadOne(j, { batchId, albumTag });
        } catch (e) {
          if (e && e.batchAbort) { this.stopped = true; this.abortAll(); this.onEvent('batchAbort', { message: e.message }); return; }
          j.state = 'failed';
          j.error = e.message || String(e);
          this.stats.failed++;
          this.onEvent('file', snap(j));
          this.onEvent('stats', { ...this.stats });
        }
      }
    });
    await Promise.all(workers);
    this.onEvent('stats', { ...this.stats });
    return this.stats;
  }

  async uploadOne(j, { batchId, albumTag }, depth = 0) {
    if (depth > 10) {
      j.state = 'failed'; j.error = '重入次数过多';
      throw new Error('uploadOne 重入超限');
    }
    let attempt = 0;
    // —— init（含重试；404/丢上传时重来） ——
    for (;;) {
      if (this.stopped) return;
      await this.waitForLive();
      j.state = 'initing';
      this.onEvent('file', snap(j));
      try {
        const init = await this.withRetry(() => this.api('POST', 'upload/init', {
          body: JSON.stringify({
            name: j.name, size: j.size, mtime: j.mtime, type: j.file.type || '',
            albumTag, batchId, clientUploadId: j.clientId, sha256: j.sha || undefined,
          }),
          timeoutMs: 30000,
        }), { onRetry: (a) => (attempt = a) });
        if (init.status === 'exists') {
          j.state = 'exists'; j.relPath = init.relPath;
          this.stats.skipped++;
          this.onEvent('file', snap(j)); this.onEvent('stats', { ...this.stats });
          return;
        }
        j.uploadId = init.uploadId;
        j.token = init.token;
        j.chunkSize = init.chunkSize || 4 * 1024 * 1024;
        j.offset = init.offset;
        break;
      } catch (e) {
        if (e.kind === 'http' && (e.status === 503 || e.status === 429) && /空间/.test(e.message)) {
          throw new BatchAbort(e.message);
        }
        if (++attempt > 8) { j.state = 'failed'; j.error = 'init 失败: ' + (e.message || e.code); throw e; }
        await this.backoff(attempt);
      }
    }

    // —— 分块 ——
    j.state = 'uploading';
    this.onEvent('file', snap(j));
    let netRetry = 0;
    for (;;) {
      if (this.stopped) return;
      await this.waitForLive();
      while (this.paused && !this.stopped) await sleep(300);
      if (j.offset >= j.size) break;
      const end = Math.min(j.offset + j.chunkSize, j.size);
      let buf;
      try {
        buf = await j.file.slice(j.offset, end).arrayBuffer();
      } catch (e) {
        j.state = 'failed'; j.error = '读取文件失败（可能已被系统回收，请重新选择）';
        throw e;
      }
      try {
        const r = await this.api('PUT', `upload/${j.uploadId}/chunk`, {
          body: buf,
          headers: { 'x-offset': String(j.offset), 'x-token': j.token, 'content-type': 'application/octet-stream' },
          timeoutMs: this.chunkTimeout(j.chunkSize),
        });
        j.offset = r.received;
        netRetry = 0;
        this.onEvent('file', snap(j));
      } catch (e) {
        if (e.kind === 'http' && e.code === 'OFFSET_MISMATCH') {
          j.offset = Number(e.expected) || await this.reconcile(j);
          this.onEvent('file', snap(j));
          continue;
        }
        if (e.kind === 'http' && e.code === 'UNKNOWN_UPLOAD') {
          // 上传记录被清理 → 回到 init 重建
          j.uploadId = null;
          return this.uploadOne(j, { batchId, albumTag }, depth + 1);
        }
        if (e.kind === 'http' && e.code === 'INSUFFICIENT_SPACE') {
          throw new BatchAbort('服务器磁盘空间不足');
        }
        if (e.kind === 'http' && e.status === 503) { await this.backoff(++netRetry); continue; }
        if (e.kind === 'http' && e.status === 403) {
          // token 失效（服务端重启）→ 重新 init
          j.uploadId = null;
          return this.uploadOne(j, { batchId, albumTag }, depth + 1);
        }
        if (e.kind === 'network' || e.kind === 'http' && e.status >= 500) {
          if (++netRetry > 60) { j.state = 'failed'; j.error = '网络重试耗尽'; throw e; }
          await this.backoff(netRetry);
          j.offset = await this.reconcile(j).catch(() => j.offset);
          this.onEvent('file', snap(j));
          continue;
        }
        j.state = 'failed'; j.error = e.message || e.code;
        throw e;
      }
    }

    // —— complete ——
    j.state = 'completing';
    this.onEvent('file', snap(j));
    for (let c = 0; ; c++) {
      if (this.stopped) return;
      await this.waitForLive();
      while (this.paused && !this.stopped) await sleep(300);
      try {
        const comp = await this.api('POST', `upload/${j.uploadId}/complete`, {
          body: JSON.stringify({}),
          headers: { 'x-token': j.token },
          timeoutMs: 600000, // 服务端要重算全文件 sha，大视频可能要几分钟
        });
        if (comp.status === 'completed' || comp.status === 'exists') {
          j.state = 'done'; j.relPath = comp.relPath;
          if (comp.status === 'completed') { this.stats.uploaded++; this.stats.bytes += j.size; }
          else this.stats.skipped++;
          this.onEvent('file', snap(j)); this.onEvent('stats', { ...this.stats });
          return;
        }
      } catch (e) {
        if (e.kind === 'http' && e.code === 'SIZE_MISMATCH') {
          j.offset = Number(e.expected) || 0;
          j.state = 'uploading';
          this.onEvent('file', snap(j));
          return this.uploadOne(j, { batchId, albumTag }, depth + 1); // 回到分块阶段继续
        }
        if (e.kind === 'http' && e.code === 'HASH_MISMATCH') {
          j.state = 'failed'; j.error = '内容校验失败';
          throw e;
        }
        if (e.kind === 'http' && e.code === 'UNKNOWN_UPLOAD') {
          // complete 已在服务端生效（响应丢失）→ 重新 init 应判 exists
          j.uploadId = null;
          return this.uploadOne(j, { batchId, albumTag }, depth + 1);
        }
        if (e.kind === 'http' && (e.code === 'STATE_CONFLICT' || e.status >= 500 || e.kind === 'network')) {
          if (c > 10) { j.state = 'failed'; j.error = 'complete 重试耗尽'; throw e; }
          await this.backoff(c + 1);
          continue;
        }
        j.state = 'failed'; j.error = e.message || e.code;
        throw e;
      }
    }
  }

  async reconcile(j) {
    if (!j.uploadId) return 0;
    try {
      const g = await this.api('GET', `upload/${j.uploadId}`, { timeoutMs: 15000 });
      return g.offset;
    } catch (e) {
      if (e.kind === 'http' && e.code === 'UNKNOWN_UPLOAD') return 0;
      return j.offset;
    }
  }

  async withRetry(fn, { max = 6, onRetry } = {}) {
    for (let a = 0; ; a++) {
      try {
        return await fn();
      } catch (e) {
        if (e.kind === 'http' && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
        if (a >= max) throw e;
        if (onRetry) onRetry(a + 1);
        await this.backoff(a + 1);
      }
    }
  }

  abortAll() {
    for (const c of [...this.aborters]) { try { c.abort(new Error('freeze')); } catch { /* */ } }
    this.aborters.clear();
  }

  stop() { this.stopped = true; this.abortAll(); }
}

function snap(j) {
  return { i: j.i, name: j.name, size: j.size, state: j.state, offset: j.offset, error: j.error, relPath: j.relPath };
}

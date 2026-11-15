'use strict';
// sha256 worker 池：complete 阶段对 .part 流式重算（不能边收边算——
// Node Hash 状态无法跨续传请求持久化）。worker_threads 常驻，队列调度。

const { Worker } = require('node:worker_threads');
const logger = require('./logger');

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const crypto = require('node:crypto');
parentPort.on('message', async ({ path }) => {
  try {
    const h = crypto.createHash('sha256');
    const fd = await fs.promises.open(path, 'r');
    try {
      const buf = Buffer.alloc(4 * 1024 * 1024);
      let pos = 0;
      for (;;) {
        const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
        if (bytesRead <= 0) break;
        h.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
    } finally {
      await fd.close();
    }
    parentPort.postMessage({ ok: true, hex: h.digest('hex') });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String((e && e.message) || e) });
  }
});
`;

class HashPool {
  constructor(size = 2) {
    this.size = size;
    this.queue = [];   // {path, resolve, reject}
    this.workers = []; // {w, busy, job}
  }

  hashFile(absPath) {
    return new Promise((resolve, reject) => {
      this.queue.push({ path: absPath, resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.workers.length < this.size && this.queue.length > this.busyCount()) {
      this.spawn();
    }
    for (const slot of this.workers) {
      if (!slot.busy && this.queue.length) {
        const job = this.queue.shift();
        slot.busy = true;
        slot.job = job;
        slot.w.postMessage({ path: job.path });
      }
    }
  }

  busyCount() {
    return this.workers.filter((s) => s.busy).length;
  }

  spawn() {
    const w = new Worker(WORKER_SRC, { eval: true });
    const slot = { w, busy: false, job: null };
    w.on('message', (m) => {
      const job = slot.job;
      slot.busy = false;
      slot.job = null;
      if (job) {
        if (m && m.ok) job.resolve(m.hex);
        else job.reject(new Error((m && m.error) || 'hash 失败'));
      }
      this.pump();
    });
    w.on('error', (e) => {
      logger.error('hash worker 崩溃', { err: String(e) });
      if (slot.job) { slot.job.reject(e); slot.job = null; }
      slot.busy = false;
      this.workers = this.workers.filter((s) => s !== slot);
      this.pump();
    });
    this.workers.push(slot);
  }

  async close() {
    for (const j of this.queue) j.reject(new Error('hash pool closed'));
    this.queue = [];
    await Promise.allSettled(this.workers.map((s) => s.w.terminate()));
    this.workers = [];
  }
}

module.exports = { HashPool };

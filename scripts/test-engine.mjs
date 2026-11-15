// engine.js 集成测试：在 Node 中以真实 HTTP 驱动真实客户端引擎代码。
// 用 FakeFile 模拟 iOS Safari 给引擎的 File 对象（name/size/lastModified/slice）。
// 场景：20 个文件全量上传 → 全部 done → 重跑同一批 → 全部 exists（零传输）。
// 用法：node scripts/test-engine.mjs [--base http://127.0.0.1:5284]

import { Engine } from '../web/engine.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i === -1 ? d : process.argv[i + 1];
};
const BASE = arg('base', 'http://127.0.0.1:5284');
const KEY = arg('key', JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).accessKey);
const N = Number(arg('count', '20'));

class FakeFile {
  constructor(name, buf, mtime) {
    this.name = name; this.size = buf.length; this.lastModified = mtime;
    this.type = 'application/octet-stream';
    this._buf = buf;
  }
  // 模拟真实 File.slice：返回 Blob（带 arrayBuffer()）
  slice(a, b) { return new Blob([this._buf.subarray(a, b)]); }
}

function makeFiles(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipp-engine-'));
  const files = [];
  for (let i = 0; i < n; i++) {
    const size = 100 * 1024 + Math.floor(Math.random() * 900 * 1024);
    const buf = crypto.randomBytes(size);
    const mtime = 1700000000000 + i * 60000;
    const f = new FakeFile(`eng-${String(i).padStart(4, '0')}.bin`, buf, mtime);
    fs.writeFileSync(path.join(dir, f.name), buf);
    files.push({ file: f, path: path.join(dir, f.name) });
  }
  return files;
}

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m, x !== undefined ? JSON.stringify(x) : ''); } };

const events = [];
function onEvent(type, p) {
  if (type === 'file') events.push(p);
}

async function runBatch(files, tag) {
  const engine = new Engine({ baseUrl: `${BASE}/k/${KEY}`, onEvent });
  const batch = await (await fetch(`${BASE}/k/${KEY}/api/batch/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ album: tag }),
  })).json();
  const jobs = await engine.filterFiles(files);
  engine.jobs = jobs;
  await engine.hashSurvivors(jobs, 64 * 1024 * 1024);
  await engine.uploadAll(jobs, { batchId: batch.batchId, albumTag: tag, concurrency: 2 });
  return { engine, jobs };
}

const files1 = makeFiles(N);
console.log(`场景 1：${N} 个新文件全量上传`);
{
  const { engine, jobs } = await runBatch(files1.map((f) => f.file), '引擎测试');
  ok(engine.stats.uploaded === N, `uploaded=${engine.stats.uploaded} 应为 ${N}`);
  ok(engine.stats.failed === 0, 'failed=0', engine.stats.failed);
  ok(engine.stats.bytes === files1.reduce((a, f) => a + f.file.size, 0), 'bytes 累计正确');
  ok(jobs.every((j) => j.state === 'done'), '全部 done');
  const st = await (await fetch(`${BASE}/k/${KEY}/api/stats`)).json();
  ok(st.receiving.count === 0, '无在途残留', st.receiving.count);
}

console.log('场景 2：同一批重跑（应全部 exists，零传输）');
{
  const { engine } = await runBatch(files1.map((f) => f.file), '引擎测试');
  ok(engine.stats.skipped === N, `skipped=${engine.stats.skipped} 应为 ${N}`, engine.stats);
  ok(engine.stats.uploaded === 0 && engine.stats.bytes === 0, '零传输', engine.stats);
  ok(engine.stats.failed === 0, 'failed=0');
}

console.log('场景 3：同名同尺寸、不同 mtime、不同内容 → 新文件以 -<sha8> 后缀共存');
{
  const orig = files1[0];
  const newBuf = crypto.randomBytes(orig.file.size);
  const twin = new FakeFile(orig.file.name, newBuf, orig.file.lastModified + 86400000);
  const { engine, jobs } = await runBatch([twin], '引擎测试');
  ok(engine.stats.uploaded === 1, '内容/mtime 不同 → 作为新文件上传', engine.stats);
  const a = jobs[0];
  ok(a.state === 'done' && a.relPath.includes('-'), '落盘带 -<sha8> 后缀共存', a.relPath);
}

console.log('场景 4：同名同尺寸同 mtime、不同内容 → 按指纹快速路径跳过（既定取舍）');
{
  const orig = files1[0];
  const twin = new FakeFile(orig.file.name, crypto.randomBytes(orig.file.size), orig.file.lastModified);
  const { engine } = await runBatch([twin], '引擎测试');
  ok(engine.stats.skipped === 1 && engine.stats.uploaded === 0, '同指纹不同内容按指纹跳过（零读取快速路径的既定取舍）', engine.stats);
}

console.log(`\n结果: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

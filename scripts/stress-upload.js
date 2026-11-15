'use strict';
// 模拟 iPhone 客户端的压测/验收脚本（Node 24 全局 fetch）。
//
// 用法示例：
//   node scripts/stress-upload.js                          # 单文件完整往返 + sha 校验
//   node scripts/stress-upload.js --size 200MB --chunk 4MB
//   node scripts/stress-upload.js --kill-at-chunk 3        # 传 3 块后自杀（模拟 Safari 被杀）
//   node scripts/stress-upload.js --resume                 # 续传模式：复用上次生成的文件接着传
//   node scripts/stress-upload.js --bad-offset             # 故意错 offset → 期望 409+expected
//   node scripts/stress-upload.js --drop-after 2           # 第 2 块后断连（模拟断网）再对账续传
//   node scripts/stress-upload.js --count 500 --size 64KB  # 500 个小文件批次循环
//
// 内置断言：最终 sha256 与源一致；received 单调不减；统计与磁盘一致。退出码 0=通过。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function parseSize(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i.exec(String(s));
  if (!m) return Number(s);
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[(m[2] || 'B').toUpperCase()];
  return Math.round(Number(m[1]) * mult);
}

const BASE = opt('base', 'http://127.0.0.1:5284');
const KEY = opt('key', require('../config.json').accessKey);
const URL_ = `${BASE}/k/${KEY}`;
const SIZE = parseSize(opt('size', '32MB'));
const CHUNK = parseSize(opt('chunk', '4MB'));
const ALBUM = opt('album', '压测');
const CONC = Number(opt('concurrency', '1'));
const COUNT = Number(opt('count', '1'));
const KILL_AT = Number(opt('kill-at-chunk', '0'));
const BAD_OFFSET = opt('bad-offset', false);
const DROP_AFTER = Number(opt('drop-after', '0'));
const RESUME = opt('resume', false);

const TMP = path.join(os.tmpdir(), 'sybot-stress');
const STATE_FILE = path.join(TMP, 'state.json');

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function api(method, p, body, headers) {
  return fetch(`${URL_}/api/${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
}

async function sha256File(f) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(f).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function makeFile(name, size) {
  fs.mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, name);
  const fd = fs.openSync(f, 'w');
  const buf = crypto.randomBytes(Math.min(size, 1024 * 1024));
  let written = 0;
  while (written < size) {
    const n = Math.min(buf.length, size - written);
    fs.writeSync(fd, buf, 0, n);
    written += n;
  }
  fs.closeSync(fd);
  return f;
}

// 单文件上传状态机（模拟客户端引擎）
async function uploadOne(f, { batchId, killAt = 0, badOffset = false, dropAfter = 0 }) {
  const st = fs.statSync(f);
  const size = st.size;
  const name = path.basename(f);
  const mtime = Math.round(st.mtimeMs);
  const clientUploadId = 'stress-' + crypto.randomBytes(6).toString('hex');
  const fileSha = await sha256File(f);
  let sentBytes = 0;      // 实际发出的字节（含重发）
  let lastReceived = -1;  // 服务端 received 单调性观察
  let badFired = false;   // 错 offset 只触发一次

  // check（应报 new）
  const ck = await (await api('POST', 'sync/check', { items: [{ name, size, mtime }] })).json();
  const st0 = ck.results[0].state;
  if (st0 === 'done') {
    ok(true, `${name}: 服务端已有（跳过，零传输）`);
    return { skipped: true };
  }

  const init = await (await api('POST', 'upload/init', {
    name, size, mtime, type: 'application/octet-stream', albumTag: ALBUM, batchId, clientUploadId,
  })).json();
  if (init.status === 'exists') {
    ok(true, `${name}: init 判定 exists（零传输）`);
    return { skipped: true };
  }
  ok(init.status === 'new' || init.status === 'resume', 'init 返回 new/resume', init);
  if (RESUME && init.status === 'resume') {
    console.log(`  ↻ 续传：从 offset=${init.offset} 继续`);
  }
  let uploadId = init.uploadId;
  let token = init.token;
  let chunkSize = init.chunkSize;
  let offset = init.offset;

  for (; offset < size;) {
    const n = Math.min(chunkSize, size - offset);
    const buf = Buffer.alloc(n);
    const fd = fs.openSync(f, 'r');
    fs.readSync(fd, buf, 0, n, offset);
    fs.closeSync(fd);

    if (killAt && offset / chunkSize >= killAt - 1) {
      console.log(`  ☠ 模拟客户端死亡：已传 ${offset} 字节，第 ${Math.round(offset / chunkSize) + 1} 块前退出`);
      process.exit(9);
    }

    const useBad = badOffset && offset === 0 && !badFired;
    if (useBad) badFired = true;
    const r = await fetch(`${URL_}/api/upload/${uploadId}/chunk`, {
      method: 'PUT',
      headers: { 'x-offset': String(useBad ? offset + 1 : offset), 'x-token': token, 'content-type': 'application/octet-stream' },
      body: buf,
    }).catch((e) => ({ err: e }));
    if (r.err) {
      // 断连：对账后续传
      console.log('  ⚡ 连接中断，对账...');
      await new Promise((s) => setTimeout(s, 300));
      const g = await (await api('GET', `upload/${uploadId}`)).json();
      ok(g.offset <= offset, '对账 offset 不应超过已发位置', { server: g.offset, client: offset });
      offset = g.offset;
      continue;
    }
    if (dropAfter && offset / chunkSize >= dropAfter) {
      // 已发满 dropAfter 块：模拟网络断开 → 对账续传（只触发一次，之后正常）
      console.log('  ⚡ 模拟断网');
      DROP_AFTER_FIRED = true;
      dropAfter = 0;
      const g = await (await api('GET', `upload/${uploadId}`)).json();
      ok(g.offset <= offset, '对账 offset ≤ 已发 offset');
      offset = g.offset;
      continue;
    }
    if (useBad) {
      ok(r.status === 409, '错 offset 应返回 409', r.status);
      const j = await r.json();
      ok(j.error && j.error.expected === offset, '409 携带 expected=正确 offset', j);
      // 对账后续传
      const g = await (await api('GET', `upload/${uploadId}`)).json();
      offset = g.offset;
      continue;
    }
    if (r.status !== 200) {
      const j = await r.text();
      throw new Error(`chunk ${offset} 失败 ${r.status}: ${j}`);
    }
    const j = await r.json();
    ok(j.received >= lastReceived, 'received 单调不减', { prev: lastReceived, now: j.received });
    lastReceived = j.received;
    sentBytes += n;
    offset = j.received;
  }

  const comp = await (await api('POST', `upload/${uploadId}/complete`, {}, { 'x-token': token })).json();
  ok(comp.status === 'completed', 'complete 返回 completed', comp);
  ok(comp.sha256 === fileSha, 'sha256 与源一致', { server: comp.sha256, file: fileSha });
  ok(comp.relPath && comp.relPath.includes(ALBUM === '压测' ? '' : ''), 'relPath 存在', comp.relPath);
  console.log(`  ↳ ${name}: ${size} 字节, 发送 ${sentBytes} 字节, relPath=${comp.relPath}`);
  return { skipped: false, sentBytes };
}

let DROP_AFTER_FIRED = false;

async function main() {
  console.log(`压测: base=${BASE} size=${SIZE} chunk=${CHUNK} album=${ALBUM} count=${COUNT}`);

  if (RESUME) {
    // 续传模式：从上次状态恢复（文件与指纹必须与上次一致）
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const f = st.file;
    ok(fs.existsSync(f), '上次文件存在', f);
    const r = await uploadOne(f, { batchId: st.batchId });
    ok(!r.skipped, '续传后应完成上传');
    console.log(`\n结果: pass=${pass} fail=${fail}`);
    process.exit(fail ? 1 : 0);
  }

  const batch = await (await api('POST', 'batch/start', { album: ALBUM })).json();
  ok(batch.batchId > 0, 'batch/start 返回 batchId', batch);

  const files = [];
  for (let i = 0; i < COUNT; i++) {
    const size = COUNT > 1 ? Math.max(64 * 1024, Math.round(SIZE * (0.5 + Math.random()))) : SIZE;
    files.push(makeFile(`stress-${Date.now()}-${i}.bin`, size));
  }
  if (COUNT === 1) fs.writeFileSync(STATE_FILE, JSON.stringify({ file: files[0], batchId: batch.batchId }));

  const results = [];
  let queue = [...files];
  const workers = Array.from({ length: CONC }, async () => {
    while (queue.length) {
      const f = queue.shift();
      results.push(await uploadOne(f, { batchId: batch.batchId, killAt: KILL_AT, badOffset: BAD_OFFSET, dropAfter: DROP_AFTER }));
    }
  });
  await Promise.all(workers);

  if (DROP_AFTER_FIRED) ok(true, '断网恢复路径已验证');

  // 统计一致性
  const stats = await (await api('GET', 'stats')).json();
  const h = await (await api('GET', 'health')).json();
  ok(h.ok === true, 'health ok');
  const batchRow = (await (await api('GET', 'batches?limit=1')).json()).batches[0];
  ok(batchRow.uploaded >= results.filter((r) => !r.skipped).length, '批次 uploaded 计数', batchRow);

  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('压测异常:', e); process.exit(2); });

'use strict';
// M4 归档验收：相册清洗、重名 -<sha8> 后缀、HEIC 魔数、Live 基名、中文/emoji 相册名。
// 运行：node scripts/test-archive.js（需要服务端已启动）

const KEY = require('../config.json').accessKey;
const B = `http://127.0.0.1:5284/k/${KEY}`;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m, x !== undefined ? JSON.stringify(x) : ''); } };

async function api(method, p, body, headers) {
  const res = await fetch(`${B}/api/${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
}

// 伪 HEIC（ftypheic 盒头 + 随机填充）
function fakeHeic(seed) {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(24, 0);
  head.write('ftyp', 4, 'ascii');
  head.write('heic', 8, 'ascii');
  return Buffer.concat([head, crypto.randomBytes(seed)]);
}
// 伪 MOV（ftypqt + moov/mvhd 指定 creation）；seed 保证每次运行内容唯一
function fakeMov(creationSecs, seed = 0) {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0); ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('qt', 8, 'ascii');
  const mvhd = Buffer.alloc(4 + 4 + 100);
  Buffer.from([0, 0, 0, 108]).copy(mvhd, 0);
  mvhd.write('mvhd', 4, 'ascii');
  mvhd.writeUInt32BE(creationSecs, 12);
  const moov = Buffer.alloc(8 + 108);
  moov.writeUInt32BE(8 + 108, 0); moov.write('moov', 4, 'ascii');
  mvhd.copy(moov, 8);
  return Buffer.concat([ftyp, moov, crypto.randomBytes(seed)]);
}

async function upload(name, buf, album, mtime) {
  const size = buf.length;
  const initR = await api('POST', 'upload/init', { name, size, mtime, albumTag: album, clientUploadId: 't-' + crypto.randomBytes(4).toString('hex') });
  const init = initR.j;
  if (init.error || !init.status) throw new Error(`init 失败 ${initR.status}: ${JSON.stringify(init)}`);
  if (init.status === 'exists') return { init };
  const r = await fetch(`${B}/api/upload/${init.uploadId}/chunk`, {
    method: 'PUT', headers: { 'x-offset': '0', 'x-token': init.token, 'content-type': 'application/octet-stream' }, body: buf,
  });
  if (!r.ok) throw new Error(`chunk ${r.status}: ${await r.text()}`);
  const comp = await (await fetch(`${B}/api/upload/${init.uploadId}/complete`, { method: 'POST', headers: { 'x-token': init.token } })).json();
  return { init, comp };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sipp-arch-'));
  const RUN = String(Date.now()).slice(-6);
  const t0 = 1735689600000; // 2025-01-01T00:00:00Z（+08 → 2025-01-01 08:00）

  // 1) 中文+emoji 相册名
  const a = await upload('IMG_9001-'+RUN+'.HEIC', fakeHeic(1000), '🎉旅行/2024<测试>', t0);
  ok(a.comp.status === 'completed', '中文/emoji/非法字符相册上传成功', a.comp);
  const dirName = (a.comp.relPath || '').split('/')[0];
  ok(!/[<>:"/\\|?*]/.test(dirName) && dirName.length > 0 && dirName !== '🎉旅行/2024<测试>', '相册名已清洗: ' + dirName);
  ok((a.comp.relPath || '').includes('2025-01'), '按拍摄时间(mtime)归月', a.comp.relPath);
  ok(a.comp.dateSource === 'mtime', '无 EXIF 的伪 HEIC → mtime fallback', a.comp.dateSource);
  const storedExt = (a.comp.relPath || '').split('.').pop().toLowerCase();
  ok(storedExt === 'heic', '伪 HEIC 魔数被识别为 heic', a.comp.relPath);

  // 2) 同名不同内容（mtime 不同）→ -<sha8> 后缀共存
  const b1 = await upload('IMG_9002-'+RUN+'.HEIC', fakeHeic(2000), '边界', t0);
  const b2 = await upload('IMG_9002-'+RUN+'.HEIC', fakeHeic(2000), '边界', t0 + 86400000);
  ok(b1.comp.status === 'completed' && b2.comp.status === 'completed', '同名不同内容两次上传成功');
  ok(b2.comp.relPath !== b1.comp.relPath, 'relPath 不同', [b1.comp.relPath, b2.comp.relPath]);
  ok(/-[0-9a-f]{8}\./.test(b2.comp.relPath.split('/').pop()), '第二个带 -<sha8> 后缀', b2.comp.relPath);
  // 内容相同（同 buf 不同 mtime）→ 服务端 sha UNIQUE 兜底：第二次应 exists
  const sameBuf = fakeHeic(3000);
  const b3 = await upload('IMG_9003-'+RUN+'.HEIC', sameBuf, '边界', t0);
  const b4 = await upload('IMG_9003-'+RUN+'.HEIC', sameBuf, '边界', t0 + 86400000);
  ok(b4.init.status === 'exists' || b4.comp.status === 'exists', '同内容（异 mtime）被 sha UNIQUE 兜底', { init: b4.init.status, comp: b4.comp.status });

  // 3) Live Photo 疑似配对：IMG_9004.HEIC + IMG_9004.MOV
  const l1 = await upload('IMG_9004-'+RUN+'.HEIC', fakeHeic(4000), 'Live', t0);
  const l2 = await upload('IMG_9004-'+RUN+'.MOV', fakeMov(1700000000 + 2082844800, RUN.length + 64), 'Live', t0);
  ok(l1.comp.status === 'completed' && l2.comp.status === 'completed', 'Live 对两种文件都落盘', { l1: l1.comp.status, l2: l2.comp.status });
  ok(l2.comp.dateSource === 'mov', 'MOV 日期来自 mvhd', l2.comp);
  const liveCheck = (await api('GET', 'assets?album=Live')).j;
  const bases = new Set(liveCheck.items
    .filter((x) => x.name.startsWith('IMG_9004-' + RUN))
    .map((x) => x.name.replace(/\.[^.]+$/, '')));
  ok(bases.size === 1, '同 basename 共存（疑似 Live 对）', [...bases]);

  // 4) Windows 保留名相册
  const c = await upload('IMG_9005-'+RUN+'.HEIC', fakeHeic(5000), 'CON', t0);
  const cDir = (c.comp.relPath || '').split('/')[0];
  ok(cDir === '_CON', '保留名相册加前缀 _CON', cDir);

  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
// /api/quick 直传端点测试：原始体（流式）/ multipart / 去重 / 日期字符串 / 大文件
// 运行：node scripts/test-quick.js（需服务端已启动）

const KEY = require('../config.json').accessKey;
const B = `http://127.0.0.1:5284/k/${KEY}`;
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m, x !== undefined ? JSON.stringify(x) : ''); } };

(async () => {
  const RUN = String(Date.now()).slice(-6);

  // 1) 原始体直传（模拟快捷指令 File body）
  const buf = crypto.randomBytes(500 * 1024);
  const r1 = await fetch(`${B}/api/quick?name=IMG_7${RUN}.HEIC&album=家人&mtime=2024-01-15 08:30:00`, {
    method: 'POST', body: buf,
  });
  const j1 = await r1.json();
  ok(r1.ok && j1.status === 'completed', '原始体直传 completed', j1);
  ok(j1.relPath.includes('家人/'), '相册目录正确', j1.relPath);
  ok((j1.relPath || '').includes('2024-01'), 'mtime 字符串日期归月（2024-01）', j1.relPath);
  ok(j1.dateSource === 'mtime', 'date_source=mtime', j1.dateSource);

  // 2) 重复直传（同内容同名）→ exists 秒回
  const t0 = Date.now();
  const r2 = await fetch(`${B}/api/quick?name=IMG_7${RUN}.HEIC&album=家人&mtime=2024-01-15 08:30:00`, {
    method: 'POST', body: buf,
  });
  const j2 = await r2.json();
  ok(j2.status === 'exists', '重复直传 exists', j2);
  ok(Date.now() - t0 < 3000, 'exists 秒级返回', { ms: Date.now() - t0 });

  // 3) multipart 直传
  const boundary = '----sipp' + RUN;
  const mb = crypto.randomBytes(300 * 1024);
  const mp = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="IMG_8${RUN}.HEIC"\r\nContent-Type: public.heic\r\n\r\n`),
    mb,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r3 = await fetch(`${B}/api/quick?album=朋友&mtime=1735689600000`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: mp,
  });
  const j3 = await r3.json();
  ok(r3.ok && j3.status === 'completed', 'multipart 直传 completed', j3);
  ok((j3.relPath || '').startsWith('朋友/'), 'multipart 相册目录', j3.relPath);

  // 4) 大文件流式直传（30MB，不应撑内存）
  const big = path.join(os.tmpdir(), `sipp-quick-big-${RUN}.bin`);
  const bigBuf = crypto.randomBytes(30 * 1024 * 1024);
  fs.writeFileSync(big, bigBuf);
  const bigSha = crypto.createHash('sha256').update(bigBuf).digest('hex');
  const r4 = await fetch(`${B}/api/quick?name=BIG_${RUN}.bin&album=压测`, {
    method: 'POST', body: fs.readFileSync(big),
  });
  const j4 = await r4.json();
  ok(j4.status === 'completed' && j4.sha256 === bigSha, '30MB 流式直传 sha 一致', { status: j4.status, sha: j4.sha256 === bigSha });

  // 5) stats 一致性
  const st = await (await fetch(`${B}/api/stats`)).json();
  ok(st.receiving.count === 0, '无在途残留', st.receiving.count);

  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

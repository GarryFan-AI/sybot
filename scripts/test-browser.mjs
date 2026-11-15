// 真实浏览器 E2E：puppeteer-core 驱动 Chrome/Edge headless，
// 在页面里用 DataTransfer 注入合成 File（固定 mtime/name/size）走完整 UI 流程。
// 场景 1：N 个新文件 → 全部上传成功；场景 2：同一批重选 → 全部跳过（零传输）。
// 用法：node scripts/test-browser.mjs [--count 12] [--size 300000] [--engine chrome|edge]

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i === -1 ? d : process.argv[i + 1];
};
const ENGINE = arg('engine', 'chrome');
const COUNT = Number(arg('count', '12'));
const SIZE = Number(arg('size', '300000'));
const BASE = arg('base', 'http://127.0.0.1:5284');
const KEY = arg('key', JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).accessKey);
const TAG = arg('tag', String(Date.now()).slice(-8)); // 每次运行唯一，保证场景1是全新文件
const ALBUM = arg('album', '浏览器E2E');
const MTIME_BASE = 1735689600000; // 固定基准，保证两轮指纹一致

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m, x !== undefined ? JSON.stringify(x) : ''); } };

const browser = await puppeteer.launch({
  executablePath: CANDIDATES.find((p) => fs.existsSync(p)),
  headless: 'new',
  args: ['--disable-gpu', '--no-first-run'],
});
const page = await browser.newPage();
await page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true });

const consoleErrors = [];
const notFound = [];
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()); });
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

const url = `${BASE}/k/${KEY}/`;
console.log(`浏览器 E2E: ${url}（${ENGINE}） count=${COUNT} size=${SIZE} album=${ALBUM}`);
await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

ok((await page.title()).includes('照片同步'), '页面标题正确');
ok(await page.$('#pickBtn') !== null, '选择按钮存在');

// 注入合成 File（固定 mtime/name/size，两轮指纹一致）
async function injectFiles(n, sizeBase, mtimeBase) {
  await page.evaluate((n, sizeBase, mtimeBase, tag) => {
    const dt = new DataTransfer();
    for (let i = 0; i < n; i++) {
      const size = sizeBase + i * 1024;
      const buf = new Uint8Array(size);
      for (let p = 0; p < size; p += 65536) crypto.getRandomValues(buf.subarray(p, Math.min(p + 65536, size)));
      dt.items.add(new File([buf], `e2e-${tag}-${String(i).padStart(3, '0')}.bin`, { lastModified: mtimeBase + i * 60000 }));
    }
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, n, sizeBase, mtimeBase, TAG);
}

// —— 场景 1：新文件全量上传 ——
await page.evaluate((a) => { document.getElementById('albumInput').value = a; }, ALBUM);
await injectFiles(COUNT, SIZE, MTIME_BASE);
await page.waitForFunction(() => window.__sybot && window.__sybot.state && !window.__sybot.state.running, { timeout: 180000, polling: 400 });

const s1 = await page.evaluate(() => ({ ...window.__sybot.state.session }));
ok(s1.uploaded === COUNT, `场景1: uploaded=${s1.uploaded} 应为 ${COUNT}`, s1);
ok(s1.failed === 0, '场景1: failed=0', s1.failed);

// —— 场景 2：同一批重选（全部已存在，零传输） ——
const before = s1.uploaded;
await injectFiles(COUNT, SIZE, MTIME_BASE);
await page.waitForFunction(() => window.__sybot && window.__sybot.state && !window.__sybot.state.running, { timeout: 180000, polling: 400 });
const s2 = await page.evaluate(() => ({ ...window.__sybot.state.session }));
ok(s2.uploaded === before, `场景2: 第二轮 uploaded 不变（${s2.uploaded}）`, s2);
ok(s2.skipped >= COUNT, `场景2: 第二轮 skipped ≥ ${COUNT}（同内容指纹命中）`, s2.skipped);

// —— 场景 3：上传中途刷新页面 → 重选同批 → 秒跳已完成 + 半成品续传 ——
const before3 = { uploaded: s2.uploaded, skipped: s2.skipped };
const TAG3 = 'r' + Date.now().toString(36).slice(-6);
const SIZE3 = 5 * 1024 * 1024;
// 种子按运行唯一（TAG3 派生），两次注入内容一致；避免与历史运行内容撞 sha
const SEED = (parseInt(TAG3.slice(1), 36) % 1000000) + 7;

function scene3Source() {
  return (tag, sizeBase, mtimeBase, seed) => {
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const dt = new DataTransfer();
    for (let i = 0; i < 6; i++) {
      const size = sizeBase + i * 1024;
      const buf = new Uint8Array(size);
      const rnd = mulberry32(seed + i);
      for (let p = 0; p < size; p++) buf[p] = (rnd() * 256) | 0;
      dt.items.add(new File([buf], `e2e-${tag}-${String(i).padStart(3, '0')}.bin`, { lastModified: mtimeBase + i * 60000 }));
    }
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
}

await page.evaluate(scene3Source(), TAG3, SIZE3, MTIME_BASE, SEED);
await sleep(2500); // 传一部分
await page.reload({ waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate((tag) => { document.getElementById('albumInput').value = '浏览器E2E'; }, TAG3);
await page.evaluate(scene3Source(), TAG3, SIZE3, MTIME_BASE, SEED);
await page.waitForFunction(() => window.__sybot && window.__sybot.state && !window.__sybot.state.running, { timeout: 240000, polling: 500 });
const s3 = await page.evaluate(() => ({ ...window.__sybot.state.session }));
const dUp = s3.uploaded - before3.uploaded, dSkip = s3.skipped - before3.skipped;
ok(dUp + dSkip === 6, `场景3: 刷新重选后 6 个全部到位（补传 ${dUp} + 秒跳 ${dSkip}）`, s3);

// —— 浏览页冒烟 ——
await page.evaluate(() => { location.hash = '#/browse'; });
await sleep(800);
const cells = await page.$$eval('#browseGrid .cell', (els) => els.length);
ok(cells > 0, `浏览页有 ${cells} 个缩略格`);
ok(notFound.length === 0, '无 404 资源', notFound.slice(0, 5));
ok(consoleErrors.length === 0, '无页面 JS 错误', consoleErrors.slice(0, 3));

console.log(`\n结果: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

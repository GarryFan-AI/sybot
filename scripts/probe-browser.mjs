// 诊断探针：加载页面 → 注入 1 个文件 → 转储控制台/页面错误/状态。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const KEY = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).accessKey;
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const browser = await puppeteer.launch({ executablePath: CANDIDATES.find((p) => fs.existsSync(p)), headless: 'new' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => console.log('[console.' + m.type() + ']', m.text().slice(0, 300)));
page.on('requestfailed', (r) => console.log('[reqfail]', r.url().slice(-60), r.failure() && r.failure().errorText));

await page.goto(`http://127.0.0.1:5284/k/${KEY}/`, { waitUntil: 'networkidle2', timeout: 30000 });
console.log('title:', await page.title());
console.log('typeof __sipp:', await page.evaluate(() => typeof window.__sipp));

await page.evaluate(() => {
  const dt = new DataTransfer();
  for (let i = 0; i < 3; i++) {
    const size = 300000 + i * 1024;
    const buf = new Uint8Array(size);
    for (let p = 0; p < size; p += 65536) crypto.getRandomValues(buf.subarray(p, Math.min(p + 65536, size)));
    dt.items.add(new File([buf], 'e2e-' + String(i).padStart(3,'0') + '.bin', { lastModified: 1735689600000 + i * 60000 }));
  }
  const input = document.getElementById('fileInput');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

await new Promise((r) => setTimeout(r, 12000));
const t = await page.evaluate(async () => {
  const mod = await import('./store.js');
  const t0 = performance.now();
  await mod.store.set('probe', { x: 1 });
  const t1 = performance.now();
  const v = await mod.store.get('probe');
  return { setMs: t1 - t0, getMs: performance.now() - t1, v };
});
console.log('IDB 探测:', JSON.stringify(t));
const st = await page.evaluate(() => (window.__sipp ? {
  running: window.__sipp.state.running,
  engineNull: window.__sipp.state.engine === null,
  engineStopped: window.__sipp.state.engine ? window.__sipp.state.engine.stopped : null,
  engineFrozen: window.__sipp.state.engine ? window.__sipp.state.engine.frozen : null,
  enginePaused: window.__sipp.state.engine ? window.__sipp.state.engine.paused : null,
  engineStats: window.__sipp.state.engine ? window.__sipp.state.engine.stats : null,
  engineJobs: window.__sipp.state.engine ? window.__sipp.state.engine.jobs.map(j=>j.state).join(',') : null,
  session: window.__sipp.state.session,
} : { none: true }));
console.log('state:', JSON.stringify(st));
const partDir = 'data/storage/.incoming';
console.log('.incoming:', fs.existsSync(partDir) ? fs.readdirSync(partDir) : '无');
const albums = 'data/storage';
console.log('storage:', fs.readdirSync(albums));
await browser.close();
process.exit(0);

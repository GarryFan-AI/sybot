// 截图：同步页与浏览页（视觉验收）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const KEY = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8')).accessKey;
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const browser = await puppeteer.launch({ executablePath: CANDIDATES.find((p) => fs.existsSync(p)), headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:5284/k/${KEY}/`, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 1200));
const out = path.join('data', 'logs');
fs.mkdirSync(out, { recursive: true });
await page.screenshot({ path: path.join(out, 'ui-sync.png') });
await page.evaluate(() => { location.hash = '#/browse'; });
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: path.join(out, 'ui-browse.png') });
await browser.close();
console.log('截图完成: data/logs/ui-sync.png, ui-browse.png');

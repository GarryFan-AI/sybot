'use strict';
// 单独打印访问二维码与候选地址（服务启动时也会打印一次）。
// 用法：node scripts/print-qr.js

const os = require('node:os');
const { isPrivateIp } = require('../server/access');
const { load } = require('../server/config');

const cfg = load();
const seen = new Set();
const urls = [];
for (const name of Object.keys(os.networkInterfaces())) {
  for (const it of os.networkInterfaces()[name] || []) {
    if (it.family !== 'IPv4' || it.internal || !isPrivateIp(it.address)) continue;
    const u = `http://${it.address}:${cfg.port}/k/${cfg.accessKey}/`;
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }
}
console.log('用 iPhone（同一 Wi-Fi）扫码或打开：');
(async () => {
  try {
    const QRCode = (await import('qrcode')).default;
    const primary = urls.find((u) => u.includes('172.22.')) || urls[0];
    console.log(await QRCode.toString(primary, { type: 'terminal', small: true }));
  } catch {
    console.log('(npm install 缺 qrcode，仅打印地址)');
  }
  urls.forEach((u) => console.log('  ' + u));
})();

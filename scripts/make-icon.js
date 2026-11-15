'use strict';
// 生成 PWA 图标（192/512/180）——纯 Node 实现（zlib + 手写 PNG），无外部依赖。
// 图形：蓝色圆角底 + 白色向上箭头（上传寓意）。

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function png(size, pixelFn) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      raw[p++] = r; raw[p++] = g; raw[p++] = b; raw[p++] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function iconPixel(x, y, s) {
  // 背景：纵向渐变（iOS 图标满幅）
  const t = y / s;
  const r = Math.round(10 + (0 - 10) * t);
  const g = Math.round(132 + (96 - 132) * t);
  const b = 255;
  // 圆角遮罩（用于非 maskable 场景观感；maskable 会裁圆形，满幅底色正好）
  const rad = s * 0.18;
  const cx = Math.min(Math.max(x, rad), s - rad), cy = Math.min(Math.max(y, rad), s - rad);
  if ((x - cx) ** 2 + (y - cy) ** 2 > rad ** 2) return [0, 0, 0, 0];
  // 箭头：三角 + 竖杆
  const apexY = s * 0.16, baseY = s * 0.48, half = s * 0.27;
  const inTri = y >= apexY && y <= baseY && Math.abs(x - s / 2) <= ((y - apexY) / (baseY - apexY)) * half;
  const inStem = x >= s * 0.40 && x <= s * 0.60 && y >= s * 0.42 && y <= s * 0.80;
  if (inTri || inStem) return [255, 255, 255, 255];
  return [r, g, b, 255];
}

const dir = path.join(__dirname, '..', 'web', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [180, 192, 512]) {
  fs.writeFileSync(path.join(dir, `icon-${size}.png`), png(size, iconPixel));
  console.log(`icon-${size}.png 已生成`);
}

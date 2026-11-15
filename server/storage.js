'use strict';
// 落盘决策：相册名清洗、目标路径、重名后缀（确定性 -<sha8>）、
// .part → 最终路径 rename、statfs 空间预检、魔数嗅探。
// 所有路径由服务端从 album+month+name 重构，绝不信任客户端路径。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

// Windows 文件名非法字符 + 控制字符（空格与连字符合法，保留）
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;

// 相册名清洗：截 64 字符、空 → "未整理"、保留字加前缀
function sanitizeAlbum(raw) {
  let s = String(raw || '').replace(ILLEGAL, '');
  s = s.replace(/[.\s]+$/g, '').trim(); // 结尾的点与空白
  const cps = [...s];
  if (cps.length > 64) s = cps.slice(0, 64).join('');
  s = s.trim();
  if (!s) s = '未整理';
  if (RESERVED.has(s.toUpperCase())) s = '_' + s;
  return s;
}

// 文件名清洗（保留扩展名，主体部分清洗；总长上限 100）
function sanitizeName(raw) {
  const base = path.basename(String(raw || 'file'));
  const fileExt = path.extname(base);
  let stemPart = (fileExt ? base.slice(0, -fileExt.length) : base).replace(ILLEGAL, '').trim();
  if (!stemPart) stemPart = 'file';
  if (RESERVED.has(stemPart.toUpperCase())) stemPart = '_' + stemPart;
  const cps = [...stemPart];
  if (cps.length + fileExt.length > 100) {
    stemPart = cps.slice(0, Math.max(1, 100 - fileExt.length)).join('');
  }
  return stemPart + fileExt;
}

function stemOf(n) { const e = path.extname(n); return e ? n.slice(0, -e.length) : n; }
function extOf(n) { return path.extname(n); }

// 从 (album, month, name) 决定最终相对路径；重名追加确定性 -<sha8>，仍占则递增
async function decidePath(storageRoot, album, month, name, sha256hex) {
  const dir = path.join(storageRoot, album, month);
  await fsp.mkdir(dir, { recursive: true });
  const sha8 = String(sha256hex || '').slice(0, 8);
  let candidate = name;
  for (let i = 0; ; i++) {
    const abs = path.join(storageRoot, album, month, candidate);
    let exists = false;
    try { fs.accessSync(abs); exists = true; } catch { /* 不存在 */ }
    if (!exists) {
      return { relPath: `${album}/${month}/${candidate}`.replace(/\\/g, '/'), absPath: abs };
    }
    candidate = i === 0
      ? `${stemOf(name)}-${sha8}${extOf(name)}`
      : `${stemOf(name)}-${sha8}-${i + 1}${extOf(name)}`;
  }
}

// 同卷 rename，EPERM/EBUSY/EACCES 退避重试（Windows 文件被占用时常见）
async function renameWithRetry(from, to) {
  for (const delay of [0, 50, 200, 1000, 3000]) {
    try {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await fsp.rename(from, to);
      return;
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') continue;
      throw e;
    }
  }
  throw new Error(`rename 重试耗尽: ${from} -> ${to}`);
}

// 磁盘剩余空间（字节）；查不到返回 null（不拦截）
async function freeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

// 魔数嗅探：返回推断的扩展名（无把握返回 null）
async function sniffExt(absPath) {
  let fd;
  try {
    fd = await fsp.open(absPath, 'r');
    const { buffer: b } = await fd.read(Buffer.alloc(12), 0, 12, 0);
    if (b.length >= 12 && b.slice(4, 8).toString('ascii') === 'ftyp') {
      const brand = b.slice(8, 12).toString('ascii');
      if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'heic';
      if (brand.startsWith('isom') || brand.startsWith('mp4') || brand.startsWith('MSNV')) return 'mp4';
      if (brand.startsWith('qt')) return 'mov';
      return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b.length >= 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
  } catch {
    return null;
  } finally {
    if (fd) await fd.close();
  }
}

// 归档：.part → 最终路径；返回 {relPath, absPath}
async function archivePart({ storageRoot, incomingDir, uploadId, album, month, name, sha256hex }) {
  const partPath = path.join(incomingDir, uploadId + '.part');
  const { relPath, absPath } = await decidePath(storageRoot, album, month, name, sha256hex);
  await renameWithRetry(partPath, absPath);
  return { relPath, absPath };
}

module.exports = {
  sanitizeAlbum,
  sanitizeName,
  decidePath,
  renameWithRetry,
  freeBytes,
  sniffExt,
  archivePart,
};

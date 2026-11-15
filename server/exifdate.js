'use strict';
// 拍摄日期解析 fallback 链：
// EXIF DateTimeOriginal/CreateDate（+OffsetTimeOriginal）→ MOV mvhd → 文件 mtime → 上传当天。
// 每步成功即停；date_source 落库（assets.date_source）供排查。

const fsp = require('node:fs/promises');
const logger = require('./logger');

// 服务端本地时区偏移（毫秒）
function serverOffsetMs() {
  return -new Date().getTimezoneOffset() * 60000;
}

// "+02:00" / "-0530" / "Z" → 毫秒；解析失败返回 null
function parseOffsetMs(s) {
  if (!s) return null;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(s).trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

async function readHead(absPath, n) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

// 图片：exifr 解析 EXIF（注意不能设 ifd0:false——ExifIFDPointer 就在 IFD0 里）
async function exifEpoch(buf) {
  const exifr = require('exifr');
  const exif = await exifr.parse(buf, {
    tiff: true, exif: true, gps: false, xmp: false, iptc: false, icc: false,
    translateValues: true, reviveValues: true, silentErrors: true,
  });
  if (!exif) return null;
  const dto = exif.DateTimeOriginal !== undefined ? exif.DateTimeOriginal
    : exif.CreateDate !== undefined ? exif.CreateDate : null;
  if (!(dto instanceof Date) || isNaN(dto.getTime())) return null;
  return { date: dto, offsetMs: parseOffsetMs(exif.OffsetTimeOriginal || exif.OffsetTime) };
}

// MOV/MP4：顶层 box 走查 → moov → mvhd → creation_time（1904 起算的 UTC 秒）
async function movEpoch(absPath) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const st = await fh.stat();
    const fileSize = st.size;
    const head = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= fileSize) {
      await fh.read(head, 0, 8, pos);
      const size = head.readUInt32BE(0);
      const type = head.toString('ascii', 4, 8);
      let boxSize = size;
      let headerLen = 8;
      if (size === 1) {
        await fh.read(head, 0, 16, pos);
        boxSize = Number(head.readBigUInt64BE(8));
        headerLen = 16;
      } else if (size === 0) {
        boxSize = fileSize - pos;
      }
      if (boxSize < headerLen) return null; // 结构损坏
      if (type === 'moov') {
        const mvhd = await findMvhd(fh, pos + headerLen, pos + boxSize);
        if (mvhd !== null) return mvhd;
      }
      pos += boxSize;
    }
    return null;
  } catch (e) {
    logger.warn('mvhd 解析失败', { file: absPath, err: String(e && e.message || e) });
    return null;
  } finally {
    await fh.close();
  }
}

async function findMvhd(fh, start, end) {
  const head = Buffer.alloc(16);
  let pos = start;
  while (pos + 8 <= end) {
    await fh.read(head, 0, 8, pos);
    const size = head.readUInt32BE(0);
    const type = head.toString('ascii', 4, 8);
    let boxSize = size;
    let headerLen = 8;
    if (size === 1) {
      await fh.read(head, 0, 16, pos);
      boxSize = Number(head.readBigUInt64BE(8));
      headerLen = 16;
    } else if (size === 0) {
      boxSize = end - pos;
    }
    if (boxSize < headerLen || pos + boxSize > end) return null;
    if (type === 'mvhd') {
      const payload = Buffer.alloc(Math.min(boxSize - headerLen, 40));
      await fh.read(payload, 0, payload.length, pos + headerLen);
      const version = payload[0];
      let secs;
      if (version === 1) {
        if (payload.length < 20) return null;
        secs = Number(payload.readBigUInt64BE(4));
      } else {
        if (payload.length < 8) return null;
        secs = payload.readUInt32BE(4);
      }
      const epoch = (secs - 2082844800) * 1000; // 1904-01-01 UTC → 1970 epoch
      // 合理区间：1990 ~ 明年
      if (epoch > 631152000000 && epoch < Date.now() + 366 * 86400000) return epoch;
      return null;
    }
    pos += boxSize;
  }
  return null;
}

const IMG_RE = /\.(heic|heif|jpg|jpeg|jpe|tif|tiff|png|webp)$/i;
const MOV_RE = /\.(mov|mp4|m4v)$/i;

// 主入口：返回 { epochMs, source }
// 注意：complete 阶段的实际文件是 .part，扩展名判断要用原始文件名（fileNameHint）
async function captureDate(absPath, { mtimeMs, mime, fileNameHint } = {}) {
  const lower = String(fileNameHint || absPath).toLowerCase();
  try {
    if (IMG_RE.test(lower) || (mime && mime.startsWith('image/'))) {
      const buf = await readHead(absPath, 512 * 1024);
      const r = await exifEpoch(buf);
      if (r) {
        // 实测（scripts/dbg-exif.js + Pillow 样张）：exifr 按"服务器本地时区"构造 Date，
        // getTime() = 墙钟 − 服务器偏移。真 epoch = 墙钟 − 拍摄时区偏移
        //            = getTime() + 服务器偏移 − 拍摄偏移。
        // 无 OffsetTime 时保持本地解释（假设拍摄时区≈服务器时区，同一国家成立）。
        let epoch = r.date.getTime();
        if (r.offsetMs !== null) epoch += serverOffsetMs() - r.offsetMs;
        return { epochMs: epoch, source: 'exif' };
      }
    }
  } catch { /* 落入下一级 */ }
  try {
    if (MOV_RE.test(lower) || (mime && mime.startsWith('video/'))) {
      const epoch = await movEpoch(absPath);
      if (epoch !== null) return { epochMs: epoch, source: 'mov' };
    }
  } catch { /* 落入下一级 */ }
  if (Number(mtimeMs) > 0) return { epochMs: Number(mtimeMs), source: 'mtime' };
  return { epochMs: Date.now(), source: 'upload' };
}

// 绝对时刻 → 服务器本地时区的 {month, day}（日期仅用于目录归类）
function monthDay(epochMs) {
  const d = new Date(epochMs);
  const p = (n) => String(n).padStart(2, '0');
  const month = `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
  return { month, day: `${month}-${p(d.getDate())}` };
}

module.exports = { captureDate, monthDay, parseOffsetMs, movEpoch };

'use strict';
// exifdate 验证：合成 JPEG(EXIF DateTimeOriginal+OffsetTimeOriginal) 与合成 MP4(mvhd)。
// 运行：node scripts/test-exifdate.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { captureDate, monthDay } = require('../server/exifdate');

let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m, x !== undefined ? JSON.stringify(x) : ''); } };

// —— 合成 JPEG + EXIF ——
function makeExifJpeg(dir, dateTimeOriginal, offsetTime) {
  // TIFF（小端）：头8 + IFD0(2+12+4) + ExifIFD(2+24+4) + DTO(20) + OT(7)
  const tiff = Buffer.alloc(8 + 18 + 30 + 20 + 7);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);            // IFD0 偏移
  // IFD0 @8：1 条 → ExifIFD 指针
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);      // ExifIFDPointer
  tiff.writeUInt16LE(4, 12);           // LONG
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);          // ExifIFD 偏移
  tiff.writeUInt32LE(0, 22);           // next=0
  // ExifIFD @26：2 条
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(0x9003, 28);      // DateTimeOriginal
  tiff.writeUInt16LE(2, 30);           // ASCII
  tiff.writeUInt32LE(20, 32);
  tiff.writeUInt32LE(56, 36);          // 值偏移
  tiff.writeUInt16LE(0x9011, 40);      // OffsetTimeOriginal
  tiff.writeUInt16LE(2, 42);
  tiff.writeUInt32LE(7, 44);
  tiff.writeUInt32LE(76, 48);          // 值偏移
  tiff.writeUInt32LE(0, 52);
  tiff.write(dateTimeOriginal + '\0', 56, 'ascii');   // 20 字节
  tiff.write(offsetTime + '\0', 76, 'ascii');         // 7 字节

  const tiffLen = tiff.length;                      // 83
  const app1Len = 2 + 6 + tiffLen;
  const app1 = Buffer.alloc(2 + app1Len);
  app1.writeUInt16BE(app1Len, 0);
  app1.write('Exif\0\0', 2, 'ascii');
  tiff.copy(app1, 8);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
  const f = path.join(dir, 'exif-test.jpg');
  fs.writeFileSync(f, jpeg);
  return f;
}

// —— 合成 MP4 + mvhd ——（creationSecs 为 1904-01-01 起算的 UTC 秒，即 epoch + 2082844800）
function makeMov(dir, mvhdSecs) {
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0); ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii'); ftyp.writeUInt32BE(512, 12);
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload[0] = 0; // version 0
  mvhdPayload.writeUInt32BE(mvhdSecs, 4);
  mvhdPayload.writeUInt32BE(mvhdSecs, 8);
  mvhdPayload.writeUInt32BE(1000, 12);   // timescale
  const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 108]), Buffer.from('mvhd', 'ascii'), mvhdPayload]);
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhd.length]), Buffer.from('moov', 'ascii'), mvhd]);
  const f = path.join(dir, 'exif-test.mov');
  fs.writeFileSync(f, Buffer.concat([ftyp, moov]));
  return f;
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipp-exif-'));

  // 1) 真实样张（Pillow 生成，"2024:01:15 08:30:00" + "+02:00"）：
  //    真 epoch = 2024-01-15T06:30:00Z = 1705300200000
  const sample = path.join(os.tmpdir(), 'sipp-exif-sample', 'exif-real.jpg');
  let jpg;
  if (fs.existsSync(sample)) jpg = sample;
  else jpg = makeExifJpeg(dir, '2024:01:15 08:30:00', '+02:00'); // 合成样张结构自造，可能不被 exifr 认
  const r1 = await captureDate(jpg, { mtimeMs: 0 });
  ok(r1.source === 'exif', 'JPEG 走 exif 分支', r1);
  if (fs.existsSync(sample)) {
    ok(r1.epochMs === 1705300200000, 'EXIF + 时区偏移 → 绝对时刻正确', { got: r1.epochMs, want: 1705300200000 });
    const md1 = monthDay(r1.epochMs);
    ok(md1.month === '2024-01' && md1.day === '2024-01-15', '月/日归档正确', md1);
  }
  const md1 = monthDay(r1.epochMs);
  ok(md1.month === '2024-01' && md1.day === '2024-01-15', '月/日归档正确', md1);

  // 2) 无 OffsetTime 的真实样张（老设备场景）：按服务器本地时区解释
  const sample2 = path.join(os.tmpdir(), 'sipp-exif-sample', 'exif-nooffset.jpg');
  if (fs.existsSync(sample2)) {
    const r2 = await captureDate(sample2, { mtimeMs: 0 });
    ok(r2.source === 'exif', '无偏移 EXIF 也走 exif 分支', r2);
    const md2 = monthDay(r2.epochMs);
    ok(md2.day === '2023-06-01', '无偏移墙钟按服务器本地时区归档', md2);
  } else {
    console.log('  (跳过：未生成 exif-nooffset.jpg，请先运行 python scripts/make-exif-sample.py)');
  }

  // 3) MOV mvhd：creation(1904 起算) = 1700000000 + 2082844800 → epoch 1700000000000
  const mov = makeMov(dir, 1700000000 + 2082844800);
  const r3 = await captureDate(mov, { mtimeMs: 0 });
  ok(r3.source === 'mov', 'MOV 走 mvhd 分支', r3);
  ok(r3.epochMs === 1700000000000, 'mvhd creation → epoch 正确', { got: r3.epochMs, want: 1700000000000 });

  // 4) 全失败 → mtime fallback
  const bin = path.join(dir, 'plain.bin');
  fs.writeFileSync(bin, Buffer.alloc(100));
  const r4 = await captureDate(bin, { mtimeMs: 1700000123456 });
  ok(r4.source === 'mtime' && r4.epochMs === 1700000123456, 'fallback 到 mtime', r4);

  // 5) 全空 → upload 当天
  const r5 = await captureDate(bin, { mtimeMs: 0 });
  ok(r5.source === 'upload', 'fallback 到上传当天', r5);

  console.log(`\n结果: pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

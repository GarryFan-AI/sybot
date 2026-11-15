'use strict';
// 调试：exifr 对合成 JPEG 的解析输出 + movEpoch 对合成 MP4 的输出
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const exifr = require('exifr');
const { movEpoch } = require('../server/exifdate');

function makeExifJpeg(dir, dto, ot) {
  const tiff = Buffer.alloc(8 + 18 + 30 + 20 + 7);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8769, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(0x9003, 28);
  tiff.writeUInt16LE(2, 30);
  tiff.writeUInt32LE(20, 32);
  tiff.writeUInt32LE(56, 36);
  tiff.writeUInt16LE(0x9011, 40);
  tiff.writeUInt16LE(2, 42);
  tiff.writeUInt32LE(7, 44);
  tiff.writeUInt32LE(76, 48);
  tiff.writeUInt32LE(0, 52);
  tiff.write(dto + '\0', 56, 'ascii');
  tiff.write(ot + '\0', 76, 'ascii');
  const tiffLen = tiff.length;
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

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sybot-dbg-'));
  const jpg = makeExifJpeg(dir, '2024:01:15 08:30:00', '+02:00');
  const buf = fs.readFileSync(jpg);
  const out = await exifr.parse(buf, { tiff: true, exif: true, ifd0: false, gps: false, xmp: false, iptc: false, silentErrors: true });
  console.log('exifr parse keys:', out ? Object.keys(out) : null);
  console.log('exifr parse 值:', out);
  if (out && out.DateTimeOriginal) {
    const d = out.DateTimeOriginal;
    console.log('DTO instanceof Date:', d instanceof Date, 'ISO:', d.toISOString(), 'getUTC:', d.toUTCString());
    console.log('getTime:', d.getTime(), '期望(UTC解释)=1705314600000, 期望(本地+08解释)=1705285800000');
    console.log('1705314600000 =', new Date(1705314600000).toISOString(), '(= 2024-01-15T08:30:00Z 墙钟按UTC)');
    console.log('1705285800000 =', new Date(1705285800000).toISOString());
  }

  // MOV
  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(16, 0); ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii'); ftyp.writeUInt32BE(512, 12);
  const mvhdPayload = Buffer.alloc(100);
  mvhdPayload[0] = 0;
  mvhdPayload.writeUInt32BE(1700000000, 4);
  mvhdPayload.writeUInt32BE(1700000000, 8);
  mvhdPayload.writeUInt32BE(1000, 12);
  const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhdPayload.length]), Buffer.from('mvhd', 'ascii'), mvhdPayload]);
  const moov = Buffer.concat([Buffer.from([0, 0, 0, 8 + mvhd.length]), Buffer.from('moov', 'ascii'), mvhd]);
  const mov = path.join(dir, 't.mov');
  fs.writeFileSync(mov, Buffer.concat([ftyp, moov]));
  const mv = await movEpoch(mov);
  console.log('movEpoch:', mv, '期望 1700000000000');
})();

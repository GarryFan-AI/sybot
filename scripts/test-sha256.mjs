// 前端纯 JS SHA-256 vs Node 原生 crypto 对照测试
// 运行：node scripts/test-sha256.mjs
import { createSha256, sha256OfBlob } from '../web/vendor/sha256.js';
import crypto from 'node:crypto';

function ref(u8) { return crypto.createHash('sha256').update(u8).digest('hex'); }
let fail = 0;
const sizes = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 255, 256, 1000, 65537];
for (const n of sizes) {
  const u8 = crypto.randomBytes(n);
  const h = createSha256(); h.update(u8);
  if (h.digestHex() !== ref(u8)) { console.log('FAIL size', n); fail++; }
}
const big = crypto.randomBytes(3 * 1024 * 1024 + 13);
for (const slice of [1, 7, 64, 4096, 1048576, 3145721]) {
  const h = createSha256();
  for (let i = 0; i < big.length; i += slice) h.update(big.subarray(i, Math.min(i + slice, big.length)));
  if (h.digestHex() !== ref(big)) { console.log('FAIL slice', slice); fail++; }
}
const blob = new Blob([big]);
if ((await sha256OfBlob(blob)) !== ref(big)) { console.log('FAIL blob'); fail++; }
console.log(fail ? `sha256 FAIL ${fail}` : `sha256 全部通过（${sizes.length} 尺寸 + 6 分片 + blob）`);
process.exit(fail ? 1 : 0);

'use strict';
// 访问控制：/k/:key 路径密钥校验 + 私网白名单 + 每 IP 限速。
// 也支持 X-Access-Key 头（脚本调用用）。

const crypto = require('node:crypto');
const { ApiError } = require('./router');

function isPrivateIp(ipRaw) {
  if (!ipRaw) return false;
  let ip = ipRaw;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  if (ip === '::1' || ip === '127.0.0.1') return true;
  const m4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const [a, b] = [Number(m4[1]), Number(m4[2])];
    if (a === 10 || a === 192 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false; // 链路本地 169.254 不算
  }
  const v6 = ip.toLowerCase();
  return v6.startsWith('fc') || v6.startsWith('fd'); // IPv6 唯一本地 fc00::/7
}

// 恒定时间字符串比较（补齐到等长再比较）
function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.concat([ab, Buffer.alloc(len - ab.length)]);
  const bp = Buffer.concat([bb, Buffer.alloc(len - bb.length)]);
  const eq = crypto.timingSafeEqual(ap, bp);
  return eq && ab.length === bb.length;
}

function createAccess(cfg) {
  const rate = new Map(); // ip -> {count, windowStart}

  return {
    check(ctx) {
      const ip = ctx.ip;
      if (!isPrivateIp(ip)) {
        throw new ApiError(403, 'NOT_LAN', '仅允许局域网/本机访问');
      }

      // 限速（粗粒度：每 IP 每秒）
      const now = Date.now();
      let r = rate.get(ip);
      if (!r || now - r.windowStart >= 1000) {
        r = { count: 0, windowStart: now };
        rate.set(ip, r);
        if (rate.size > 10000) rate.clear();
      }
      r.count++;
      if (r.count > cfg.rateLimitQps) {
        throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁', { retryAfterMs: 1000 });
      }

      // 密钥：路径 /k/<key>/ 或 X-Access-Key 头
      const headerKey = ctx.req.headers['x-access-key'];
      const m = /^\/k\/([^/]+)(\/.*)?$/.exec(ctx.pathname);
      if (m) {
        if (!safeEqual(m[1], cfg.accessKey)) {
          throw new ApiError(401, 'BAD_KEY', '访问密钥错误，请重新扫码');
        }
        ctx.restPath = m[2] || '/';
      } else {
        ctx.restPath = ctx.pathname; // 根路径等不要求密钥
      }
      if (headerKey && !safeEqual(headerKey, cfg.accessKey)) {
        throw new ApiError(401, 'BAD_KEY', '访问密钥错误（X-Access-Key）');
      }
    },
  };
}

module.exports = { createAccess, isPrivateIp, safeEqual };

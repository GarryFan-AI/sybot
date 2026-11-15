'use strict';
// 入口：配置 → 开库（含启动对账）→ 起服务 → sweeper → 打印地址与二维码。

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { load } = require('./config');
const logger = require('./logger');
const { open, reconcileUploads } = require('./db');
const { createRouter, ApiError, sendError, sendJson, newRequestId } = require('./router');
const { createAccess, isPrivateIp } = require('./access');
const { Uploads } = require('./uploads');
const { HashPool } = require('./hashworker');
const { createSweeper } = require('./sweeper');
const api = require('./api');
const { handleStatic } = require('./static');
const path = require('node:path');

const WEB_ROOT = path.join(__dirname, '..', 'web');

async function main() {
  const cfg = load();
  logger.init({ dir: cfg.logDir, keepDays: cfg.logKeepDays });
  logger.info('启动', { port: cfg.port, storageRoot: cfg.storageRoot });

  const { db, tx, backup } = open(cfg);
  reconcileUploads({ db }, cfg.incomingDir, require('node:fs'));

  const secret = crypto.randomBytes(32); // token HMAC 密钥（重启后 token 失效属预期，客户端会重新 init）
  const uploads = new Uploads({ db, tx, cfg, secret });
  const hashPool = new HashPool(2);
  const sweeper = createSweeper({ cfg, db, uploads });
  const access = createAccess(cfg);
  const router = createRouter();
  api.register(router, { cfg, db, tx, uploads, hashPool, backup, sweepNow: sweeper.sweepNow, log: logger, startedAt: Date.now() });

  const server = http.createServer((req, res) => {
    const requestId = newRequestId();
    const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
    const ctx = {
      req, res, url,
      pathname: url.pathname,
      query: url.searchParams,
      ip: req.socket.remoteAddress || '',
      requestId,
      log: {
        info: (m, e) => logger.info(m, { rid: requestId, ...e }),
        warn: (m, e) => logger.warn(m, { rid: requestId, ...e }),
        error: (m, e) => logger.error(m, { rid: requestId, ...e }),
      },
    };
    handleRequest(ctx, { cfg, access, router }).catch((e) => {
      logger.error('请求处理异常', { rid: requestId, err: e.stack || String(e) });
      sendError(res, 500, 'INTERNAL', '内部错误', {}, requestId);
    });
  });
  server.headersTimeout = 120000;
  server.requestTimeout = 0; // 大块上传不设总超时，单块由 headersTimeout 与客户端超时约束
  server.keepAliveTimeout = 15000;

  await new Promise((resolve) => server.listen(cfg.port, '0.0.0.0', resolve));
  logger.info(`服务已监听 0.0.0.0:${cfg.port}`);

  // 打印候选地址 + 二维码（qrcode 为 devDependency，缺失时只打印地址）
  const urls = candidateUrls(cfg.port);
  console.log('\n==============================================');
  console.log('  sybot 已启动');
  console.log('  用 iPhone（同一 Wi-Fi）扫描二维码或打开下面的地址：');
  urls.forEach((u) => console.log('    ' + u));
  console.log(`  存储目录: ${cfg.storageRoot}`);
  console.log('==============================================\n');
  try {
    const QRCode = (await import('qrcode')).default;
    const primary = urls.find((u) => u.includes('172.22.')) || urls[0];
    const link = `${primary}k/${cfg.accessKey}/`;
    console.log(await QRCode.toString(link, { type: 'terminal', small: true }));
    console.log('  ↑ 扫码打开（链接含访问密钥）');
  } catch (e) {
    logger.warn('二维码生成失败（npm i 可装 qrcode）', { err: String(e && e.message || e) });
  }

  // 优雅退出
  const shutdown = async (sig) => {
    logger.info('退出', { sig });
    sweeper.stop();
    server.close();
    await uploads.closeAll();
    await hashPool.close();
    try { db.close(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function candidateUrls(port) {
  const out = [];
  const seen = new Set();
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const it of ifaces[name] || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (!isPrivateIp(it.address)) continue;
      const u = `http://${it.address}:${port}/`;
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
  }
  return out;
}

async function handleRequest(ctx, { cfg, access, router }) {
  const { req, res } = ctx;
  try {
    access.check(ctx);
  } catch (e) {
    if (e instanceof ApiError) {
      // 根路径的未带密钥访问给一个引导页而不是裸错误
      if (ctx.pathname === '/' && e.code !== 'NOT_LAN') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(landingHtml());
        return;
      }
      sendError(res, e.status, e.code, e.message, e.extra, ctx.requestId);
      return;
    }
    throw e;
  }

  const rest = ctx.restPath || '/';
  if (rest.startsWith('/api/') || rest.startsWith('/media/')) {
    ctx.pathname = rest; // router 只匹配业务路径
    const matched = await router.dispatch(ctx);
    if (!matched) sendError(res, 404, 'NOT_FOUND', '接口不存在', {}, ctx.requestId);
    return;
  }
  if (handleStatic(ctx, WEB_ROOT)) return;

  // 静态未命中：/k/<key>/ 下兜底回 index.html（hash 路由）
  if (rest.startsWith('/k/') || ctx.pathname.startsWith('/k/')) {
    if (handleStatic({ ...ctx, restPath: '/index.html' }, WEB_ROOT)) return;
  }
  if (ctx.pathname === '/' || ctx.pathname === '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(landingHtml());
    return;
  }
  sendError(res, 404, 'NOT_FOUND', '资源不存在', {}, ctx.requestId);
}

function landingHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sybot</title>
<style>body{font-family:-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#333;background:#f6f7f9}div{text-align:center;max-width:32em;padding:1em;line-height:1.7}</style>
</head><body><div>
<h2>sybot 服务正在运行</h2>
<p>请用电脑上显示的<b>带密钥链接</b>或扫码打开同步页面。<br>直接访问根路径不带密钥是不行的：链接形如 <code>http://电脑IP:端口/k/密钥/</code></p>
</div></body></html>`;
}

main().catch((e) => {
  logger.error('启动失败', { err: e.stack || String(e) });
  console.error(e);
  process.exit(1);
});

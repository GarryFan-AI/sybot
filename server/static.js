'use strict';
// 静态托管 web/ 目录。HTML 设 no-store（Safari 对 module 缓存激进）；
// 带 ?v= 的静态资源设 immutable 长缓存。

const fs = require('node:fs');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, filePath, { immutable = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// restPath 为 /k/<key> 之后的路径（'/'、'/app.js?v=xx'、'/manifest.webmanifest'）
function handleStatic(ctx, webRoot) {
  let urlPath = ctx.restPath || '/';
  urlPath = urlPath.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const immutable = ctx.query.has('v');
  const resolved = path.normalize(path.join(webRoot, urlPath));
  if (!resolved.startsWith(webRoot + path.sep) && resolved !== webRoot) {
    return false; // 路径穿越
  }
  return serveFile(ctx.res, resolved, { immutable });
}

module.exports = { handleStatic, serveFile, MIME };

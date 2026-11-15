'use strict';
// 路由与请求体读取：node:http 之上的极简框架。
// 统一错误信封 {"error":{code,message,...expected?}} 与 requestId。

const crypto = require('node:crypto');

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

function createRouter() {
  const routes = [];
  return {
    routes,
    add(method, pattern, handler, opts = {}) {
      // pattern 形如 '/k/:key/api/upload/:id/chunk'
      const names = [];
      const re = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => {
        names.push(m.slice(1));
        return '([^/]+)';
      }) + '$');
      routes.push({ method, re, names, handler, opts });
    },
    async dispatch(ctx) {
      const { req, res, pathname } = ctx;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        ctx.params = params;
        ctx.routeOpts = r.opts;
        try {
          await r.handler(ctx);
        } catch (e) {
          if (e instanceof ApiError) {
            sendError(res, e.status, e.code, e.message, e.extra, ctx.requestId);
          } else {
            ctx.log.error('未处理异常', { err: e.stack || String(e), path: pathname });
            sendError(res, 500, 'INTERNAL', '内部错误', {}, ctx.requestId);
          }
        }
        return true;
      }
      return false;
    },
  };
}

function readBody(req, limit, onProgress) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length'] || 0);
    if (cl > limit) {
      reject(new ApiError(413, 'BODY_TOO_LARGE', `请求体超过上限 ${limit} 字节`));
      req.resume(); // 排干，便于连接复用
      return;
    }
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) {
        reject(new ApiError(413, 'BODY_TOO_LARGE', `请求体超过上限 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(c);
      if (onProgress) onProgress(total);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

async function readJson(ctx, limit) {
  const buf = await readBody(ctx.req, limit);
  if (buf.length === 0) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_ARGUMENT', 'JSON 解析失败');
  }
}

async function readRaw(ctx, limit) {
  return readBody(ctx.req, limit);
}

function sendJson(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...(headers || {}),
  });
  res.end(body);
}

function sendError(res, status, code, message, extra, requestId) {
  if (res.headersSent) { try { res.destroy(); } catch { /* */ } return; }
  const err = { code, message, ...(extra || {}) };
  if (requestId) err.requestId = requestId;
  sendJson(res, status, { error: err });
}

module.exports = {
  ApiError,
  createRouter,
  readBody,
  readJson,
  readRaw,
  sendJson,
  sendError,
  newRequestId: () => crypto.randomBytes(4).toString('hex'),
};

'use strict';
// 三级查重：sha256（内容，最高优先）> quick_key > (name,size) 兜底。
// quick_key 非唯一：命中多条且内容指纹不同 → ambiguous，交给 init/客户端哈希裁决。
// 绝不做 name+size 覆盖。

const { quickKeyOf } = require('./uploads');
const { sanitizeName } = require('./storage');
const { ApiError } = require('./router');

// items: [{name,size,mtime,sha256?}]（≤2000 条）→ results: [{i,state,by,...}]
function checkItems(db, items) {
  if (!Array.isArray(items)) throw new ApiError(400, 'INVALID_ARGUMENT', 'items 须为数组');
  if (items.length > 2000) throw new ApiError(413, 'BODY_TOO_LARGE', 'items 最多 2000 条');

  const qkStmt = db.prepare(`SELECT id, rel_path, sha256 FROM assets WHERE quick_key=?`);
  const shaStmt = db.prepare(`SELECT id, rel_path, sha256, month, day FROM assets WHERE sha256=?`);
  const nsStmt = db.prepare(`SELECT id, rel_path, sha256 FROM assets WHERE name=? AND size=?`);
  const partialStmt = db.prepare(
    `SELECT id, received FROM uploads WHERE quick_key=? AND size=? AND state IN ('receiving','abandoned') ORDER BY received DESC LIMIT 1`
  );

  return items.map((it, i) => {
    if (!it || typeof it !== 'object') return { i, state: 'new', by: null };
    const name = sanitizeName(it.name);
    const size = Number(it.size);
    const mtime = Number(it.mtime) || 0;
    if (!Number.isFinite(size) || size < 0) return { i, state: 'new', by: null };
    const sha = typeof it.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(it.sha256) ? it.sha256.toLowerCase() : null;
    const qk = quickKeyOf(name, size, mtime);

    // 1) 内容指纹（权威）
    if (sha) {
      const a = shaStmt.get(sha);
      if (a) return { i, state: 'done', by: 'sha256', assetId: a.id, relPath: a.rel_path, sha256: a.sha256 };
    }

    // 2) quickKey
    const qHits = qkStmt.all(qk);
    if (qHits.length === 1) {
      return { i, state: 'done', by: 'quick', assetId: qHits[0].id, relPath: qHits[0].rel_path, sha256: qHits[0].sha256 };
    }
    if (qHits.length > 1) {
      const shas = new Set(qHits.map((h) => h.sha256));
      if (shas.size === 1) {
        return { i, state: 'done', by: 'quick', assetId: qHits[0].id, relPath: qHits[0].rel_path, sha256: qHits[0].sha256 };
      }
      // 多条且内容不同：交给哈希/init 裁决；但有在途续传时优先续传
      const p = partialStmt.get(qk, size);
      if (p) return { i, state: 'partial', by: 'quick', uploadId: p.id, offset: p.received };
      return { i, state: 'new', by: null, ambiguous: true, candidates: qHits.length };
    }

    // 3) 在途续传（quickKey 未命中资产时）
    const p = partialStmt.get(qk, size);
    if (p) return { i, state: 'partial', by: 'quick', uploadId: p.id, offset: p.received };

    // 4) (name,size) 兜底：仅当 mtime 缺失/为 0（来源不稳）时启用。
    //    mtime>0 且 quickKey 未命中 → 视为新内容（同名不同内容以 -<sha8> 共存，
    //    内容相同则被 sha256 UNIQUE 兜底）——宁可信其新，不可漏传。
    if (mtime === 0) {
      const ns = nsStmt.all(name, size);
      if (ns.length === 1) {
        return { i, state: 'done', by: 'namesize', assetId: ns[0].id, relPath: ns[0].rel_path, sha256: ns[0].sha256 };
      }
    }
    return { i, state: 'new', by: null };
  });
}

// init 时对单个 (sha256?, quickKey, mtime) 的资产裁决：返回命中资产或 null
function findAsset(db, { sha, quickKey, size, name, mtime }) {
  if (sha) {
    const a = db.prepare(`SELECT * FROM assets WHERE sha256=?`).get(sha);
    if (a) return { asset: a, by: 'sha256' };
  }
  if (quickKey) {
    const hits = db.prepare(`SELECT * FROM assets WHERE quick_key=?`).all(quickKey);
    if (hits.length === 1) return { asset: hits[0], by: 'quick' };
    if (hits.length > 1) {
      const shas = new Set(hits.map((h) => h.sha256));
      if (shas.size === 1) return { asset: hits[0], by: 'quick' };
      // ambiguous → 不判 done；若无在途则交由内容（客户端哈希或服务端收完再判）
      const p = db.prepare(
        `SELECT id, received FROM uploads WHERE quick_key=? AND size=? AND state IN ('receiving','abandoned') ORDER BY received DESC LIMIT 1`
      ).get(quickKey, size);
      if (p) return { partial: p, by: 'quick' };
      return { ambiguous: true };
    }
    // quickKey 未命中资产 → 在途？
    const p = db.prepare(
      `SELECT id, received FROM uploads WHERE quick_key=? AND size=? AND state IN ('receiving','abandoned') ORDER BY received DESC LIMIT 1`
    ).get(quickKey, size);
    if (p) return { partial: p, by: 'quick' };
    // (name,size) 兜底：仅 mtime 缺失/为 0 时启用（宁可信其新，不可漏传）
    if (name && Number.isFinite(size) && !mtime) {
      const ns = db.prepare(`SELECT * FROM assets WHERE name=? AND size=?`).all(name, size);
      if (ns.length === 1) return { asset: ns[0], by: 'namesize' };
    }
  }
  return null;
}

module.exports = { checkItems, findAsset };

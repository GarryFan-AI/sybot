// IndexedDB 元数据缓存。只存元数据（批次、最近相册、累计统计），绝不存 File/Blob；
// 续传状态以服务端为唯一可信源（Safari ITP 7 天会清站点数据，丢了最多重选一次相册）。

const DB_NAME = 'sybot';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// IDB 不可用（如锁定模式）时降级 localStorage
let idbOk = 'indexedDB' in window;

export const store = {
  async get(key) {
    if (!idbOk) {
      try { return JSON.parse(localStorage.getItem('sybot:' + key)); } catch { return undefined; }
    }
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } catch {
      idbOk = false;
      return this.get(key);
    }
  },

  async set(key, value) {
    if (!idbOk) {
      try { localStorage.setItem('sybot:' + key, JSON.stringify(value)); } catch { /* */ }
      return;
    }
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      idbOk = false;
      this.set(key, value);
    }
  },
};

// —— 会话累计（跨批次持久） ——
export async function loadSession() {
  return (await store.get('session')) || {
    uploaded: 0, skipped: 0, failed: 0, bytes: 0, batches: 0, startedAt: Date.now(),
  };
}
export async function saveSession(s) { await store.set('session', s); }

// 最近相册名（下拉记忆 + 自动回填）
export async function loadRecentAlbums() { return (await store.get('recentAlbums')) || []; }
export async function pushRecentAlbum(name) {
  if (!name) return [];
  let list = await loadRecentAlbums();
  list = [name, ...list.filter((x) => x !== name)].slice(0, 10);
  await store.set('recentAlbums', list);
  return list;
}

// 上一批次（刷新后的 NEEDS_REPICK 提示）
export async function loadLastBatch() { return (await store.get('lastBatch')) || null; }
export async function saveLastBatch(b) { await store.set('lastBatch', b); }

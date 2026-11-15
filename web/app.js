// 应用编排：批次循环（继续下一批）、UI 状态、前台约束（visibility/online/wake lock）、浏览页。

import { Engine } from './engine.js';
import {
  store, loadSession, saveSession, loadRecentAlbums, pushRecentAlbum, loadLastBatch, saveLastBatch,
} from './store.js';
import { fmtBytes, fmtSpeed, fmtCount, el, toast } from './ui.js';

// —— 基础 ——
const key = (() => {
  const m = /^\/k\/([^/]+)/.exec(location.pathname);
  return m ? m[1] : '';
})();
const baseUrl = '/k/' + key;

const $ = (id) => document.getElementById(id);
const state = {
  running: false,
  engine: null,
  settings: null,     // {concurrency, batchTarget}
  session: null,      // 跨批次累计
  health: null,
  speed: { at: 0, bytes: 0, value: 0 },
  lastFileEvent: null,
  rows: new Map(),    // i → row element（仅渲染最近若干条）
};

const ACCEPT = 'image/heic,image/heif,image/jpeg,image/png,image/webp,video/quicktime,video/mp4,.heic,.heif,.jpg,.jpeg,.mov,.mp4';

async function api(method, path, opts) {
  const res = await fetch(`${baseUrl}/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts && opts.headers) },
    body: opts && opts.body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `HTTP ${res.status}`);
  return j;
}

// —— 启动 ——
async function init() {
  state.settings = { concurrency: 2, batchTarget: 120, ...((await store.get('settings')) || {}) };
  state.session = await loadSession();
  renderSession();
  $('fileInput').setAttribute('accept', ACCEPT);

  try {
    state.health = await api('GET', 'health');
    renderServerInfo();
  } catch (e) {
    $('serverInfo').textContent = '无法连接服务器：' + e.message;
  }

  // 最近相册下拉
  const albums = await loadRecentAlbums();
  const dl = $('albumList');
  for (const a of albums) dl.appendChild(el('option', { value: a }));
  if (albums[0] && !$('albumInput').value) $('albumInput').value = albums[0];
  $('albumInput').addEventListener('change', () => pushRecentAlbum($('albumInput').value.trim()).then(fillAlbumList));
  // 服务端相册也进下拉
  api('GET', 'albums').then((r) => {
    const names = r.albums.map((a) => a.album).filter(Boolean);
    return Promise.all(names.map((n) => pushRecentAlbum(n)));
  }).then(fillAlbumList).catch(() => {});

  // 上一批次恢复提示
  const last = await loadLastBatch();
  if (last && !last.finished) {
    $('recoverCard').classList.remove('hidden');
    $('recoverText').textContent =
      `上一批次「${last.album || '未整理'}」可能未完成。重新选择同一相册的照片即可续传：` +
      `已传过的会瞬时跳过，半成品从断点继续。`;
    $('recoverBtn').onclick = () => {
      if (last.album) $('albumInput').value = last.album;
      $('fileInput').click();
    };
    $('recoverDismiss').onclick = () => { saveLastBatch({ ...last, finished: true }); $('recoverCard').classList.add('hidden'); };
  }

  // 事件
  $('pickBtn').onclick = () => {
    if (state.running) { toast('当前批次进行中，可先暂停或等待完成'); return; }
    $('fileInput').click();
  };
  $('nextBatchBtn').onclick = () => {
    if (state.running) return;
    $('fileInput').click();
  };
  $('fileInput').addEventListener('change', onPick);
  $('pauseBtn').onclick = () => {
    if (!state.engine) return;
    state.engine.paused = true;
    $('pauseBtn').classList.add('hidden');
    $('resumeBtn').classList.remove('hidden');
    toast('已暂停，点"继续"恢复');
  };
  $('resumeBtn').onclick = () => {
    if (!state.engine) return;
    state.engine.paused = false;
    $('resumeBtn').classList.add('hidden');
    $('pauseBtn').classList.remove('hidden');
  };
  $('stopBtn').onclick = () => {
    if (state.engine) { state.engine.abortedByUser = true; state.engine.stop(); }
  };

  // 前台约束
  document.addEventListener('visibilitychange', () => {
    if (!state.engine) return;
    if (document.hidden) {
      state.engine.frozen = true;
      state.engine.abortAll(); // 立即掐断在途请求，防 Safari 冻结时写出半截块
    } else {
      state.engine.frozen = !navigator.onLine;
    }
  });
  window.addEventListener('offline', () => { if (state.engine) state.engine.frozen = true; setNet(false); });
  window.addEventListener('online', () => { if (state.engine) state.engine.frozen = false; setNet(true); });
  setNet(navigator.onLine);

  // 浏览页
  initBrowse();
  window.addEventListener('hashchange', route);
  route();

  // 服务器统计周期刷新
  setInterval(() => api('GET', 'stats').then((s) => {
    state.health = state.health || {};
    state.health.storageRoot = s.storageRoot;
    state.serverStats = s;
    renderServerInfo();
  }).catch(() => {}), 30000);
}

function fillAlbumList(list) {
  const dl = $('albumList');
  dl.innerHTML = '';
  for (const a of list || []) dl.appendChild(el('option', { value: a }));
}

function setNet(on) {
  $('netDot').className = 'dot ' + (on ? 'ok' : 'bad');
  $('netText').textContent = on ? '已连接' : '网络断开（恢复后自动续传）';
}

// —— 批次主流程 ——
async function onPick() {
  const files = [...($('fileInput').files || [])];
  $('fileInput').value = '';
  if (!files.length || state.running) return;
  state.running = true;
  setRunning(true);

  const albumTag = $('albumInput').value.trim();
  await pushRecentAlbum(albumTag);
  fillAlbumList(await loadRecentAlbums());
  state.session.batches++;

  let engine;
  try {
    const health = state.health || (await api('GET', 'health'));
    state.health = health;
    const batch = await api('POST', 'batch/start', { body: JSON.stringify({ album: albumTag }) });
    saveLastBatch({ batchId: batch.batchId, album: albumTag, finished: false });

    engine = new Engine({ baseUrl, onEvent: onEngineEvent });
    state.engine = engine;
    engine.abortedByUser = false;
    $('batchCard').classList.remove('hidden');
    $('nextWrap').classList.add('hidden');
    $('batchTitle').textContent = `批次 #${batch.batchId} · ${albumTag || '未整理'} · ${fmtCount(files.length)} 项`;

    requestWakeLock();

    const jobs = await engine.filterFiles(files);
    engine.jobs = jobs;
    if (!engine.stopped) {
      await engine.hashSurvivors(jobs, health.hashMaxBytes);
      await engine.uploadAll(jobs, {
        batchId: batch.batchId, albumTag, concurrency: state.settings.concurrency,
      });
    }

    // 批次收尾（服务端计数为准）
    try {
      await api('POST', `batch/${batch.batchId}/finish`, {
        body: JSON.stringify({
          selected: files.length,
          skipped: engine.stats.skipped,
          failed: engine.stats.failed,
        }),
      });
    } catch { /* 批次统计失败不阻断 */ }

    // 累计会话
    state.session.uploaded += engine.stats.uploaded;
    state.session.skipped += engine.stats.skipped;
    state.session.failed += engine.stats.failed;
    state.session.bytes += engine.stats.bytes;
    await saveSession(state.session);
    await saveLastBatch({ batchId: batch.batchId, album: albumTag, finished: true });

    renderSession();
    $('batchTitle').textContent = `批次 #${batch.batchId} 完成 · 上传 ${fmtCount(engine.stats.uploaded)} · 跳过 ${fmtCount(engine.stats.skipped)} · 失败 ${fmtCount(engine.stats.failed)}`;
    if (engine.stats.failed > 0) {
      toast(`本批有 ${engine.stats.failed} 个失败项，重新选择同一相册可自动重试`, 5000);
    }
    $('nextWrap').classList.remove('hidden');
    $('nextBatchBtn').textContent =
      `继续下一批（已累计 ${fmtCount(state.session.uploaded + state.session.skipped)} 项）`;
    if (engine.stats.uploaded === 0 && engine.stats.failed === 0 && engine.stats.skipped > 0) {
      $('nextBatchBtn').textContent = `本批全部已存在 · 换个范围再选一批（累计已同步 ${fmtCount(state.session.uploaded + state.session.skipped)}）`;
    }
  } catch (e) {
    toast('批次异常：' + (e.message || e), 5000);
    console.error(e);
  } finally {
    releaseWakeLock();
    state.engine = null;
    state.running = false;
    setRunning(false);
  }
}

function onEngineEvent(type, payload) {
  if (type === 'file') {
    state.lastFileEvent = payload;
    renderFileRow(payload);
  } else if (type === 'stats') {
    renderBatchStats(payload);
  } else if (type === 'filter') {
    $('batchPhase').textContent = `查重 ${fmtCount(payload.scanned)}/${fmtCount(payload.total)}（秒级，零读取）`;
  } else if (type === 'hash') {
    $('batchPhase').textContent = '计算内容指纹（用于内容级去重）…';
  } else if (type === 'wait') {
    $('batchPhase').textContent = `网络异常，${Math.round(payload.ms / 1000)}s 后重试（第 ${payload.attempt} 次）`;
  } else if (type === 'batchAbort') {
    toast(payload.message, 8000);
  }
}

function renderBatchStats(s) {
  const done = s.uploaded + s.skipped + s.failed;
  const total = Math.max(done, state.engine ? state.engine.jobs.length : 0) || 1;
  const pct = Math.min(100, Math.round((done / total) * 100));
  $('batchBar').style.width = pct + '%';
  $('batchCounters').textContent =
    `上传 ${fmtCount(s.uploaded)} · 跳过 ${fmtCount(s.skipped)} · 失败 ${fmtCount(s.failed)}`;
  const now = Date.now();
  if (state.lastFileEvent && now - state.speed.at > 1000) {
    const dt = (now - state.speed.at) / 1000;
    const db = (state.lastFileEvent.offset || 0) - (state.speed.lastOffset || 0);
    if (dt > 0 && db > 0) state.speed.value = db / dt;
    state.speed.at = now;
    state.speed.lastOffset = state.lastFileEvent.offset;
  }
  const f = state.lastFileEvent;
  if (f && (f.state === 'uploading' || f.state === 'hashing')) {
    $('batchPhase').textContent =
      f.state === 'uploading'
        ? `${f.name} · ${fmtBytes(f.offset)}/${fmtBytes(f.size)} · ${fmtSpeed(state.speed.value)}`
        : `${f.name} · 计算指纹 ${fmtBytes(f.offset)}/${fmtBytes(f.size)}`;
  }
}

function renderFileRow(f) {
  const box = $('fileRows');
  let row = state.rows.get(f.i);
  if (!row) {
    row = el('div', { class: 'fileRow' });
    row.appendChild(el('span', { class: 'fName' }));
    row.appendChild(el('span', { class: 'fInfo' }));
    box.prepend(row);
    state.rows.set(f.i, row);
    state.rowOrder = state.rowOrder || [];
    state.rowOrder.push(f.i);
    while (box.children.length > 8) {
      const old = state.rowOrder.shift();
      const oldRow = state.rows.get(old);
      if (oldRow && oldRow.parentNode) oldRow.parentNode.removeChild(oldRow);
      state.rows.delete(old);
    }
  }
  const [nameEl, infoEl] = row.children;
  nameEl.textContent = f.name;
  const icon = { exists: '⏭', done: '✓', failed: '✗', uploading: '↑', hashing: '🔒', completing: '⏳', initing: '…', pending: '·' }[f.state] || '·';
  nameEl.textContent = `${icon} ${f.name}`;
  infoEl.textContent =
    f.state === 'uploading' ? `${fmtBytes(f.offset)}/${fmtBytes(f.size)}`
      : f.state === 'exists' ? '已存在，跳过'
        : f.state === 'done' ? '完成'
          : f.state === 'failed' ? (f.error || '失败')
            : f.state === 'hashing' ? '指纹计算中' : '';
  row.className = 'fileRow ' + (f.state === 'failed' ? 'isFail' : f.state === 'done' || f.state === 'exists' ? 'isDone' : '');
}

function renderSession() {
  const s = state.session;
  $('sessionStats').textContent =
    `会话累计：上传 ${fmtCount(s.uploaded)} · 跳过 ${fmtCount(s.skipped)} · 失败 ${fmtCount(s.failed)} · ${fmtBytes(s.bytes)} · ${fmtCount(s.batches)} 批`;
}

function renderServerInfo() {
  const s = state.serverStats;
  const h = state.health;
  if (!h) return;
  const parts = [];
  if (s) parts.push(`已存 ${fmtCount(s.total.count)} 项 / ${fmtBytes(s.total.bytes)}`);
  if (h.freeBytes != null) parts.push(`剩余空间 ${fmtBytes(h.freeBytes)}`);
  $('serverInfo').textContent = parts.join(' · ') || '服务器就绪';
}

function setRunning(on) {
  $('pickBtn').disabled = on;
  $('pauseBtn').classList.toggle('hidden', !on);
  $('stopBtn').classList.toggle('hidden', !on);
  if (!on) { $('resumeBtn').classList.add('hidden'); $('pauseBtn').classList.remove('hidden'); }
}

// —— Wake Lock（HTTP 下不可用，探测降级） ——
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* HTTP 下没有 */ }
}
async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* */ }
  wakeLock = null;
}

// —— 浏览页 ——
const browse = { album: '', month: '', offset: 0, total: 0, loading: false };

function fillMonths(albumRow) {
  const sel = $('browseMonth');
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '', text: '全部月份' }));
  for (const m of (albumRow && albumRow.months) || []) {
    sel.appendChild(el('option', { value: m.month, text: `${m.month} (${m.count})` }));
  }
}

function initBrowse() {
  // album 的 change 处理在 route() 首次进入时挂载（需服务端月度聚合）
  $('browseMonth').addEventListener('change', () => { browse.month = $('browseMonth').value; reloadBrowse(); });
  $('browseMore').onclick = loadMoreBrowse;
  $('lightbox').onclick = () => { $('lightbox').classList.add('hidden'); $('lightbox').innerHTML = ''; };
}

async function reloadBrowse() {
  browse.offset = 0;
  $('browseGrid').innerHTML = '';
  await loadMoreBrowse();
}

async function loadMoreBrowse() {
  if (browse.loading) return;
  browse.loading = true;
  try {
    const params = new URLSearchParams({ limit: '60', offset: String(browse.offset) });
    if (browse.album) params.set('album', browse.album);
    if (browse.month) params.set('month', browse.month);
    const r = await api('GET', 'assets?' + params.toString());
    browse.total = r.total;
    for (const it of r.items) {
      const isVideo = ['mov', 'mp4', 'm4v'].includes(it.ext);
      const media = isVideo
        ? el('video', { src: `${baseUrl}/media/${it.id}`, preload: 'metadata', controls: '', playsinline: '' })
        : el('img', { src: `${baseUrl}/media/${it.id}`, loading: 'lazy', alt: it.name });
      const card = el('div', { class: 'cell' + (isVideo ? ' video' : '') }, [media]);
      card.onclick = () => openLightbox(it, isVideo);
      $('browseGrid').appendChild(card);
    }
    browse.offset += r.items.length;
    $('browseMore').classList.toggle('hidden', browse.offset >= browse.total);
    $('browseCount').textContent = `${fmtCount(browse.offset)}/${fmtCount(browse.total)}`;
  } catch (e) {
    toast('浏览加载失败：' + e.message);
  } finally {
    browse.loading = false;
  }
}

function openLightbox(it, isVideo) {
  const box = $('lightbox');
  box.innerHTML = '';
  const media = isVideo
    ? el('video', { src: `${baseUrl}/media/${it.id}`, controls: '', autoplay: '', playsinline: '' })
    : el('img', { src: `${baseUrl}/media/${it.id}` });
  box.appendChild(media);
  box.appendChild(el('div', { class: 'cap', text: `${it.name} · ${fmtBytes(it.size)} · ${it.day || it.month}（来源: ${it.dateSource}）` }));
  box.classList.remove('hidden');
}

// —— 路由 ——
function route() {
  const sync = location.hash !== '#/browse';
  $('view-sync').classList.toggle('hidden', !sync);
  $('view-browse').classList.toggle('hidden', sync);
  document.querySelectorAll('nav button').forEach((b, i) => b.classList.toggle('active', i === (sync ? 0 : 1)));
  if (!sync && !$('browseGrid').children.length) reloadBrowse();
  if (!sync) {
    api('GET', 'albums').then((r) => {
      const sel = $('browseAlbum');
      const keep = sel.value;
      sel.innerHTML = '';
      sel.appendChild(el('option', { value: '', text: '全部相册' }));
      for (const a of r.albums) sel.appendChild(el('option', { value: a.album, text: `${a.album} (${a.count})` }));
      if (keep) sel.value = keep;
      sel.onchange = () => { browse.album = sel.value; fillMonths(r.albums.find((a) => a.album === sel.value)); browse.month = ''; reloadBrowse(); };
    }).catch(() => {});
  }
}

init().catch((e) => { console.error(e); toast('初始化失败：' + e.message, 8000); });

// 测试钩子（无副作用）
window.__sipp = { get state() { return state; }, onPick };

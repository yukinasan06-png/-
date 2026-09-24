'use strict';
// 配信用カウンター & 盛り上がりメーター & ルーレット
// 依存パッケージなし（Node.js 標準モジュールのみ）で動作します。

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

const TEMPLATE_COUNT = 30;
const CUSTOM_COUNT = 10;
const HISTORY_MAX = 30;

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

function defaultItems() {
  const items = [
    { id: 'likes', name: '高評価', kind: 'auto', value: 0, points: 1, show: true },
    { id: 'superchat', name: 'スパチャ', kind: 'auto', value: 0, points: 10, show: true, amount: 0, yenPoints: 0 },
    { id: 'first', name: '初見コメント', kind: 'auto', value: 0, points: 5, show: true },
    { id: 'comments', name: 'コメント数', kind: 'auto', value: 0, points: 1, show: true },
    { id: 'gift', name: 'メンギフ', kind: 'auto', value: 0, points: 20, show: true },
    { id: 'keyword', name: '特定の言葉', kind: 'auto', value: 0, points: 2, show: true, words: ['草', '888'] },
  ];
  for (let i = 1; i <= CUSTOM_COUNT; i++) {
    items.push({ id: 'custom' + i, name: 'カスタム' + i, kind: 'custom', enabled: false, value: 0, points: 1, show: true, words: [] });
  }
  return items;
}

function defaultTemplates() {
  const list = [];
  for (let i = 0; i < TEMPLATE_COUNT; i++) list.push({ name: 'テンプレ' + (i + 1), items: [] });
  list[0].items = ['歌う', 'モノマネ', 'セリフ読み', '一発ギャグ', '変顔', 'スクワット10回'];
  return list;
}

function defaultState() {
  return {
    items: defaultItems(),
    settings: {
      onecomme: { enabled: true, host: '127.0.0.1', port: 11180, excludeOwner: true },
      youtube: { apiKey: '', video: '', channelId: '', likeInterval: 30, chatInterval: 15 },
      // likes / gift の取得元: 'youtube' | 'onecomme' | 'off'
      sources: { likes: 'youtube', gift: 'youtube' },
      meter: { title: '盛り上がりメーター', threshold: 100, autoSpin: true },
      roulette: { duration: 6, hold: 5, shuffleEachSpin: false, alwaysShow: false },
    },
    meter: { fired: 0 },
    likes: { base: 0, raw: null, videoId: '' },
    roulette: { templates: defaultTemplates(), active: 0, queue: 0, history: [] },
  };
}

let state = loadState();
let spinning = null; // 実行中のルーレット（保存しない）

function loadState() {
  const def = defaultState();
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return def;
  }
  try {
    const s = def;
    if (Array.isArray(saved.items)) {
      for (const it of s.items) {
        const old = saved.items.find(x => x && x.id === it.id);
        if (old) Object.assign(it, old, { id: it.id, kind: it.kind });
      }
    }
    if (saved.settings) {
      for (const k of Object.keys(s.settings)) Object.assign(s.settings[k], saved.settings[k] || {});
    }
    Object.assign(s.meter, saved.meter || {});
    Object.assign(s.likes, saved.likes || {});
    if (saved.roulette) {
      const r = saved.roulette;
      if (Array.isArray(r.templates)) {
        for (let i = 0; i < TEMPLATE_COUNT; i++) {
          const t = r.templates[i];
          if (t) s.roulette.templates[i] = { name: String(t.name || ''), items: Array.isArray(t.items) ? t.items.map(String) : [] };
        }
      }
      s.roulette.active = clampInt(r.active, 0, TEMPLATE_COUNT - 1, 0);
      s.roulette.queue = clampInt(r.queue, 0, 999, 0);
      s.roulette.history = Array.isArray(r.history) ? r.history.slice(0, HISTORY_MAX) : [];
    }
    return s;
  } catch (e) {
    console.error('data.json の読み込みに失敗しました。初期設定で起動します:', e.message);
    return def;
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(state, null, 2), err => {
      if (err) return console.error('保存に失敗:', err.message);
      fs.rename(tmp, DATA_FILE, err2 => err2 && console.error('保存に失敗:', err2.message));
    });
  }, 1000);
}

function clampInt(v, min, max, def) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function getItem(id) {
  return state.items.find(i => i.id === id);
}

function itemActive(it) {
  return it.kind === 'auto' || it.enabled;
}

function totalPoints() {
  let t = 0;
  for (const it of state.items) {
    if (!itemActive(it)) continue;
    t += (it.value || 0) * (it.points || 0);
    if (it.id === 'superchat' && it.yenPoints) t += ((it.amount || 0) / 100) * it.yenPoints;
  }
  return Math.floor(t);
}

// ---------------------------------------------------------------------------
// 配信 (SSE)
// ---------------------------------------------------------------------------

const clients = new Set();
const status = {
  onecomme: { state: 'off', message: '未接続' },
  youtube: { state: 'off', message: '未設定' },
};

function publicState() {
  const total = totalPoints();
  const threshold = Math.max(1, state.settings.meter.threshold);
  return {
    items: state.items,
    settings: state.settings,
    likes: state.likes,
    meter: {
      total,
      threshold,
      fired: state.meter.fired,
      progress: Math.min(threshold, Math.max(0, total - state.meter.fired * threshold)),
      title: state.settings.meter.title,
    },
    roulette: {
      templates: state.roulette.templates,
      active: state.roulette.active,
      queue: state.roulette.queue,
      history: state.roulette.history,
      spinning,
      options: state.settings.roulette,
    },
    status,
    templateCount: TEMPLATE_COUNT,
  };
}

function send(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

let broadcastTimer = null;
function changed() {
  checkMeter();
  scheduleSave();
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const s = { t: 'state', state: publicState() };
    for (const c of clients) send(c, s);
  }, 50);
}

function emit(event) {
  for (const c of clients) send(c, { t: 'event', event });
}

// ---------------------------------------------------------------------------
// メーター & ルーレット
// ---------------------------------------------------------------------------

function checkMeter() {
  const threshold = Math.max(1, state.settings.meter.threshold);
  const fills = Math.floor(totalPoints() / threshold);
  if (fills > state.meter.fired) {
    const n = fills - state.meter.fired;
    state.meter.fired = fills;
    emit({ type: 'meterFull', count: n });
    if (state.settings.meter.autoSpin) {
      state.roulette.queue += n;
      setImmediate(processSpinQueue);
    }
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function processSpinQueue() {
  if (spinning || state.roulette.queue <= 0) return;
  const tpl = state.roulette.templates[state.roulette.active];
  let items = (tpl.items || []).map(s => String(s).trim()).filter(Boolean);
  if (items.length === 0) {
    status.rouletteError = `「${tpl.name}」に項目がありません`;
    changed();
    return;
  }
  delete status.rouletteError;
  if (state.settings.roulette.shuffleEachSpin) items = shuffle(items);
  state.roulette.queue--;
  const opts = state.settings.roulette;
  const duration = Math.max(1, num(opts.duration, 6));
  const hold = Math.max(0, num(opts.hold, 5));
  const index = crypto.randomInt(items.length);
  spinning = {
    id: crypto.randomUUID(),
    template: tpl.name,
    items,
    index,
    result: items[index],
    duration,
    hold,
    startedAt: Date.now(),
    done: false,
  };
  const current = spinning;
  emit({ type: 'spin', spin: current });
  changed();
  setTimeout(() => {
    current.done = true;
    state.roulette.history.unshift({ result: current.result, template: current.template, time: Date.now() });
    state.roulette.history = state.roulette.history.slice(0, HISTORY_MAX);
    emit({ type: 'result', spin: current });
    changed();
    setTimeout(() => {
      if (spinning === current) spinning = null;
      changed();
      processSpinQueue();
    }, hold * 1000);
  }, duration * 1000);
}

// ---------------------------------------------------------------------------
// コメント処理（わんコメ）
// ---------------------------------------------------------------------------

const seenComments = new Set();
function markSeen(id) {
  if (!id) return false;
  if (seenComments.has(id)) return true;
  seenComments.add(id);
  if (seenComments.size > 20000) {
    const first = seenComments.values().next().value;
    seenComments.delete(first);
  }
  return false;
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function textHasWord(text, words) {
  if (!Array.isArray(words)) return false;
  const lower = text.toLowerCase();
  return words.some(w => {
    const k = String(w).trim().toLowerCase();
    return k && lower.includes(k);
  });
}

// メンバーシップギフトの件数を検出（なければ 0）
function detectGift(data, text) {
  for (const key of ['giftCount', 'membershipGiftCount', 'giftMembershipsCount', 'giftedMembershipCount']) {
    const n = Number(data[key]);
    if (n > 0) return n;
  }
  const m =
    text.match(/メンバーシップ\s*ギフト[^\d]{0,20}(\d+)\s*(?:個|件|人|つ)/) ||
    text.match(/(\d+)\s*(?:個|件|人|つ)の[^\n]{0,30}メンバーシップ\s*ギフト/) ||
    text.match(/(?:gifted|sent)\s+(\d+)[^\n]{0,40}(?:gift\s*)?membership/i);
  return m ? Number(m[1]) : 0;
}

function isGiftRedemption(text) {
  return /メンバーシップ\s*ギフトを受け取りました|received a gift membership/i.test(text);
}

function addValue(id, delta) {
  const it = getItem(id);
  if (!it || !itemActive(it)) return;
  it.value = Math.max(0, (it.value || 0) + delta);
}

function processComment(c, { simulate = false } = {}) {
  const data = (c && c.data) || c || {};
  const id = (c && c.id) || data.id;
  if (!simulate && markSeen(id)) return;
  if (data.isOwner && state.settings.onecomme.excludeOwner) return;

  const text = stripHtml(data.comment) + ' ' + stripHtml(data.paidText || '');
  if (isGiftRedemption(text)) return;

  const giftN = detectGift(data, text);
  if (giftN > 0) {
    if (state.settings.sources.gift === 'onecomme' || simulate) addValue('gift', giftN);
    changed();
    return;
  }

  addValue('comments', 1);
  if (data.isFirstTime) addValue('first', 1);

  const price = Number(data.price) || 0;
  if (data.hasGift && price > 0) {
    addValue('superchat', 1);
    const sc = getItem('superchat');
    sc.amount = (sc.amount || 0) + price;
  }

  const body = stripHtml(data.comment);
  for (const it of state.items) {
    if (it.id === 'keyword' || (it.kind === 'custom' && it.enabled)) {
      if (textHasWord(body, it.words)) addValue(it.id, 1);
    }
  }
  changed();
}

// meta から高評価数らしき値を探す
function findLikeCount(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const key of ['upVote', 'likeCount', 'likes']) {
    if (typeof obj[key] === 'number') return obj[key];
    if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) return Number(obj[key]);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findLikeCount(v, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

function handleOneCommeMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return;
  }
  const type = msg.type;
  const data = msg.data || {};
  if (type === 'connected') {
    // 接続時に送られてくる既存コメントはカウントしない
    for (const c of data.comments || []) markSeen(c.id || (c.data && c.data.id));
    return;
  }
  if (type === 'comments') {
    for (const c of data.comments || []) processComment(c);
    return;
  }
  if (type === 'meta' && state.settings.sources.likes === 'onecomme') {
    const n = findLikeCount(data);
    if (n !== null) updateLikes(n, 'onecomme');
  }
}

// ---------------------------------------------------------------------------
// 最小限の WebSocket クライアント（わんコメ接続用）
// ---------------------------------------------------------------------------

function wsConnect(host, port, pathname, handlers) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, host);
  let buf = Buffer.alloc(0);
  let open = false;
  let frags = [];
  let fragOp = 0;
  let closed = false;

  function close(err) {
    if (closed) return;
    closed = true;
    sock.destroy();
    handlers.close(err);
  }

  function sendFrame(op, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    sock.write(Buffer.concat([header, mask, masked]));
  }

  sock.setNoDelay(true);
  sock.on('connect', () => {
    sock.write(
      `GET ${pathname} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
  sock.on('data', chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!open) {
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = buf.subarray(0, idx).toString();
      if (!/^HTTP\/1\.[01] 101/.test(head)) return close(new Error('WebSocket ハンドシェイク失敗'));
      open = true;
      buf = buf.subarray(idx + 4);
      handlers.open();
    }
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4);
        off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

      if (op === 0x8) return close();
      if (op === 0x9) {
        sendFrame(0xa, payload);
        continue;
      }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2) {
        fragOp = op;
        frags = [payload];
      } else if (op === 0x0) {
        frags.push(payload);
      }
      if (fin && frags.length) {
        const message = Buffer.concat(frags);
        frags = [];
        if (fragOp === 0x1) {
          try {
            handlers.message(message.toString('utf8'));
          } catch (e) {
            console.error('メッセージ処理エラー:', e);
          }
        }
      }
    }
  });
  sock.on('error', err => close(err));
  sock.on('close', () => close());
  return { close: () => close() };
}

let ocConn = null;
let ocRetryTimer = null;
let ocGen = 0;

function oneCommeRestart() {
  ocGen++;
  if (ocConn) ocConn.close();
  ocConn = null;
  clearTimeout(ocRetryTimer);
  const cfg = state.settings.onecomme;
  if (!cfg.enabled) {
    status.onecomme = { state: 'off', message: '無効' };
    changed();
    return;
  }
  const gen = ocGen;
  status.onecomme = { state: 'connecting', message: `${cfg.host}:${cfg.port} に接続中…` };
  changed();
  ocConn = wsConnect(cfg.host, Number(cfg.port) || 11180, '/sub', {
    open() {
      if (gen !== ocGen) return;
      status.onecomme = { state: 'ok', message: '接続中' };
      console.log('[わんコメ] 接続しました');
      changed();
    },
    message(raw) {
      if (gen !== ocGen) return;
      handleOneCommeMessage(raw);
    },
    close(err) {
      if (gen !== ocGen) return;
      ocConn = null;
      status.onecomme = {
        state: 'error',
        message: (err ? err.code || err.message : '切断されました') + '（5秒後に再接続）',
      };
      changed();
      ocRetryTimer = setTimeout(() => gen === ocGen && oneCommeRestart(), 5000);
    },
  });
}

// ---------------------------------------------------------------------------
// YouTube Data API（高評価・メンギフ）
// ---------------------------------------------------------------------------

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          return reject(new Error('HTTP ' + res.statusCode));
        }
        if (res.statusCode >= 400) {
          const err = new Error((json.error && json.error.message) || 'HTTP ' + res.statusCode);
          err.reason = json.error && json.error.errors && json.error.errors[0] && json.error.errors[0].reason;
          return reject(err);
        }
        resolve(json);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('タイムアウト')));
    req.on('error', reject);
  });
}

function parseVideoId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  if (/^[\w-]{11}$/.test(s)) return s;
  const m =
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/\/(?:live|shorts|embed)\/([\w-]{11})/);
  return m ? m[1] : '';
}

function updateLikes(raw, source) {
  const L = state.likes;
  L.raw = raw;
  L.source = source;
  const it = getItem('likes');
  it.value = Math.max(0, raw - (L.base || 0));
  changed();
}

const yt = { gen: 0, videoTimer: null, chatTimer: null, liveChatId: null, chatPrimed: false, pageToken: null, seen: new Set() };

function ytStatus(stateName, message) {
  status.youtube = { state: stateName, message };
  changed();
}

function ytNeeded() {
  const src = state.settings.sources;
  return src.likes === 'youtube' || src.gift === 'youtube';
}

async function youtubeRestart() {
  yt.gen++;
  const gen = yt.gen;
  clearTimeout(yt.videoTimer);
  clearTimeout(yt.chatTimer);
  yt.liveChatId = null;
  yt.chatPrimed = false;
  yt.pageToken = null;
  const cfg = state.settings.youtube;
  if (!ytNeeded()) return ytStatus('off', '未使用（取得元がYouTube以外）');
  if (!cfg.apiKey) return ytStatus('off', 'APIキー未設定');

  let videoId = parseVideoId(cfg.video);
  if (!videoId && cfg.channelId) {
    ytStatus('connecting', 'チャンネルの配信を検索中…');
    try {
      const r = await getJson(
        `https://www.googleapis.com/youtube/v3/search?part=id&type=video&eventType=live&channelId=${encodeURIComponent(
          cfg.channelId
        )}&key=${encodeURIComponent(cfg.apiKey)}`
      );
      if (gen !== yt.gen) return;
      videoId = r.items && r.items[0] && r.items[0].id && r.items[0].id.videoId;
      if (!videoId) {
        ytStatus('error', '配信中のライブが見つかりません（60秒後に再検索）');
        yt.videoTimer = setTimeout(() => gen === yt.gen && youtubeRestart(), 60000);
        return;
      }
    } catch (e) {
      if (gen !== yt.gen) return;
      ytStatus('error', '検索エラー: ' + e.message);
      yt.videoTimer = setTimeout(() => gen === yt.gen && youtubeRestart(), 60000);
      return;
    }
  }
  if (!videoId) return ytStatus('off', '配信URL（または動画ID / チャンネルID）未設定');

  if (state.likes.videoId !== videoId) {
    // 別の配信に切り替えたら高評価の基準をリセット
    state.likes.videoId = videoId;
    state.likes.base = 0;
    state.likes.raw = null;
  }
  ytStatus('connecting', `動画 ${videoId} に接続中…`);
  pollVideo(gen, videoId);
}

async function pollVideo(gen, videoId) {
  const cfg = state.settings.youtube;
  try {
    const r = await getJson(
      `https://www.googleapis.com/youtube/v3/videos?part=statistics,liveStreamingDetails&id=${videoId}&key=${encodeURIComponent(cfg.apiKey)}`
    );
    if (gen !== yt.gen) return;
    const v = r.items && r.items[0];
    if (!v) throw new Error('動画が見つかりません');
    if (state.settings.sources.likes === 'youtube' && v.statistics && v.statistics.likeCount !== undefined) {
      updateLikes(Number(v.statistics.likeCount) || 0, 'youtube');
    }
    const chatId = v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
    const msgs = [`動画 ${videoId}`];
    if (state.settings.sources.likes === 'youtube') msgs.push(`高評価 ${state.likes.raw ?? '-'}`);
    if (state.settings.sources.gift === 'youtube') {
      if (chatId) {
        msgs.push('チャット取得中');
        if (chatId !== yt.liveChatId) {
          yt.liveChatId = chatId;
          yt.chatPrimed = false;
          yt.pageToken = null;
          clearTimeout(yt.chatTimer);
          pollChat(gen);
        }
      } else {
        msgs.push('ライブチャットなし（配信前/終了？）');
      }
    }
    if (status.youtube.state !== 'error' || !yt.chatError) ytStatus('ok', msgs.join(' / '));
  } catch (e) {
    if (gen !== yt.gen) return;
    ytStatus('error', 'YouTube API エラー: ' + e.message);
    if (e.reason === 'quotaExceeded') {
      yt.videoTimer = setTimeout(() => pollVideo(gen, videoId), 10 * 60 * 1000);
      return;
    }
  }
  const interval = Math.max(10, num(cfg.likeInterval, 30)) * 1000;
  yt.videoTimer = setTimeout(() => pollVideo(gen, videoId), interval);
}

async function pollChat(gen) {
  const cfg = state.settings.youtube;
  let wait = Math.max(5, num(cfg.chatInterval, 15)) * 1000;
  try {
    let url =
      `https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet&maxResults=2000&liveChatId=${encodeURIComponent(
        yt.liveChatId
      )}&key=${encodeURIComponent(cfg.apiKey)}`;
    if (yt.pageToken) url += '&pageToken=' + encodeURIComponent(yt.pageToken);
    const r = await getJson(url);
    if (gen !== yt.gen) return;
    yt.chatError = null;
    yt.pageToken = r.nextPageToken || yt.pageToken;
    for (const m of r.items || []) {
      if (yt.seen.has(m.id)) continue;
      yt.seen.add(m.id);
      if (!yt.chatPrimed) continue; // 接続前のメッセージは数えない
      const sn = m.snippet || {};
      if (sn.type === 'membershipGiftingEvent' && state.settings.sources.gift === 'youtube') {
        const n = Number(sn.membershipGiftingDetails && sn.membershipGiftingDetails.giftMembershipsCount) || 1;
        addValue('gift', n);
        changed();
      }
    }
    if (yt.seen.size > 20000) yt.seen = new Set([...yt.seen].slice(-5000));
    yt.chatPrimed = true;
    if (r.pollingIntervalMillis) wait = Math.max(wait, r.pollingIntervalMillis);
  } catch (e) {
    if (gen !== yt.gen) return;
    yt.chatError = e.message;
    ytStatus('error', 'ライブチャット取得エラー: ' + e.message);
    if (e.reason === 'liveChatEnded' || e.reason === 'liveChatNotFound') {
      yt.liveChatId = null;
      return;
    }
    wait = e.reason === 'quotaExceeded' ? 10 * 60 * 1000 : 30000;
  }
  yt.chatTimer = setTimeout(() => pollChat(gen), wait);
}

// ---------------------------------------------------------------------------
// 操作 API
// ---------------------------------------------------------------------------

function words(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v || '')
    .split(/[,、\n]/)
    .map(s => s.trim())
    .filter(Boolean);
}

function applyItemPatch(it, p) {
  if (p.name !== undefined) it.name = String(p.name).slice(0, 40);
  if (p.points !== undefined) it.points = num(p.points, it.points);
  if (p.show !== undefined) it.show = !!p.show;
  if (p.enabled !== undefined && it.kind === 'custom') it.enabled = !!p.enabled;
  if (p.words !== undefined && (it.id === 'keyword' || it.kind === 'custom')) it.words = words(p.words);
  if (p.yenPoints !== undefined && it.id === 'superchat') it.yenPoints = num(p.yenPoints, 0);
  if (p.amount !== undefined && it.id === 'superchat') it.amount = Math.max(0, num(p.amount, 0));
}

function resetCounters() {
  for (const it of state.items) {
    it.value = 0;
    if (it.id === 'superchat') it.amount = 0;
  }
  state.likes.base = state.likes.raw || 0;
  state.meter.fired = 0;
  state.roulette.queue = 0;
}

const actions = {
  adjust({ id, delta }) {
    const it = getItem(id);
    if (!it) throw new Error('項目がありません');
    const d = Math.trunc(num(delta, 0));
    const before = it.value || 0;
    it.value = Math.max(0, before + d);
    if (id === 'likes') state.likes.base = (state.likes.base || 0) - (it.value - before);
  },
  setValue({ id, value }) {
    const it = getItem(id);
    if (!it) throw new Error('項目がありません');
    const before = it.value || 0;
    it.value = Math.max(0, Math.trunc(num(value, 0)));
    if (id === 'likes') state.likes.base = (state.likes.base || 0) - (it.value - before);
  },
  updateItem({ id, patch }) {
    const it = getItem(id);
    if (!it) throw new Error('項目がありません');
    applyItemPatch(it, patch || {});
  },
  resetCounters() {
    resetCounters();
  },
  resetItem({ id }) {
    const it = getItem(id);
    if (!it) throw new Error('項目がありません');
    it.value = 0;
    if (id === 'superchat') it.amount = 0;
    if (id === 'likes') state.likes.base = state.likes.raw || 0;
  },
  updateSettings({ settings }) {
    const s = settings || {};
    const cur = state.settings;
    const ocBefore = JSON.stringify(cur.onecomme);
    const ytBefore = JSON.stringify([cur.youtube, cur.sources]);
    if (s.onecomme) {
      const o = s.onecomme;
      if (o.enabled !== undefined) cur.onecomme.enabled = !!o.enabled;
      if (o.host !== undefined) cur.onecomme.host = String(o.host).trim() || '127.0.0.1';
      if (o.port !== undefined) cur.onecomme.port = clampInt(o.port, 1, 65535, 11180);
      if (o.excludeOwner !== undefined) cur.onecomme.excludeOwner = !!o.excludeOwner;
    }
    if (s.youtube) {
      const y = s.youtube;
      if (y.apiKey !== undefined) cur.youtube.apiKey = String(y.apiKey).trim();
      if (y.video !== undefined) cur.youtube.video = String(y.video).trim();
      if (y.channelId !== undefined) cur.youtube.channelId = String(y.channelId).trim();
      if (y.likeInterval !== undefined) cur.youtube.likeInterval = clampInt(y.likeInterval, 10, 600, 30);
      if (y.chatInterval !== undefined) cur.youtube.chatInterval = clampInt(y.chatInterval, 5, 600, 15);
    }
    if (s.sources) {
      const ok = ['youtube', 'onecomme', 'off'];
      if (ok.includes(s.sources.likes)) cur.sources.likes = s.sources.likes;
      if (ok.includes(s.sources.gift)) cur.sources.gift = s.sources.gift;
    }
    if (s.meter) {
      const m = s.meter;
      if (m.title !== undefined) cur.meter.title = String(m.title).slice(0, 60);
      if (m.autoSpin !== undefined) cur.meter.autoSpin = !!m.autoSpin;
      if (m.threshold !== undefined) {
        const t = clampInt(m.threshold, 1, 100000000, 100);
        if (t !== cur.meter.threshold) {
          cur.meter.threshold = t;
          // しきい値変更時は、今の合計で満タン済みの回数を引き直す（まとめて発火しないように）
          state.meter.fired = Math.floor(totalPoints() / t);
        }
      }
    }
    if (s.roulette) {
      const r = s.roulette;
      if (r.duration !== undefined) cur.roulette.duration = Math.min(60, Math.max(1, num(r.duration, 6)));
      if (r.hold !== undefined) cur.roulette.hold = Math.min(120, Math.max(0, num(r.hold, 5)));
      if (r.shuffleEachSpin !== undefined) cur.roulette.shuffleEachSpin = !!r.shuffleEachSpin;
      if (r.alwaysShow !== undefined) cur.roulette.alwaysShow = !!r.alwaysShow;
    }
    if (JSON.stringify(cur.onecomme) !== ocBefore) setImmediate(oneCommeRestart);
    if (JSON.stringify([cur.youtube, cur.sources]) !== ytBefore) setImmediate(youtubeRestart);
  },
  reconnect() {
    setImmediate(oneCommeRestart);
    setImmediate(youtubeRestart);
  },
  resetLikesBase() {
    state.likes.base = state.likes.raw || 0;
    getItem('likes').value = 0;
  },
  saveTemplate({ index, name, items }) {
    const i = clampInt(index, 0, TEMPLATE_COUNT - 1, -1);
    if (i < 0) throw new Error('テンプレ番号が不正です');
    const list = (Array.isArray(items) ? items : String(items || '').split('\n'))
      .map(s => String(s).trim())
      .filter(Boolean)
      .slice(0, 200);
    state.roulette.templates[i] = { name: String(name || 'テンプレ' + (i + 1)).slice(0, 40), items: list };
  },
  shuffleTemplate({ index }) {
    const i = clampInt(index, 0, TEMPLATE_COUNT - 1, -1);
    if (i < 0) throw new Error('テンプレ番号が不正です');
    state.roulette.templates[i].items = shuffle(state.roulette.templates[i].items);
  },
  setActiveTemplate({ index }) {
    state.roulette.active = clampInt(index, 0, TEMPLATE_COUNT - 1, 0);
  },
  spin() {
    state.roulette.queue++;
    setImmediate(processSpinQueue);
  },
  clearQueue() {
    state.roulette.queue = 0;
  },
  clearHistory() {
    state.roulette.history = [];
  },
  simulate({ kind, text, price, count }) {
    // 動作確認用のテスト入力
    const base = { id: 'sim-' + crypto.randomUUID(), comment: String(text || ''), displayName: 'テスト' };
    if (kind === 'first') base.isFirstTime = true;
    if (kind === 'superchat') {
      base.hasGift = true;
      base.price = Math.max(1, num(price, 500));
    }
    if (kind === 'gift') base.giftCount = Math.max(1, clampInt(count, 1, 1000, 5));
    if (kind === 'like') {
      const n = clampInt(count, 1, 100000, 1);
      getItem('likes').value += n;
      state.likes.base = (state.likes.base || 0) - n;
      return;
    }
    processComment({ id: base.id, data: base }, { simulate: true });
  },
};

// ---------------------------------------------------------------------------
// HTTP サーバー
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      body += c;
      if (body.length > 2e6) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 2000\n\n');
    send(res, { t: 'state', state: publicState() });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state') return json(res, 200, publicState());
  if (p === '/api/action' && req.method === 'POST') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      const fn = actions[body.action];
      if (!fn) return json(res, 400, { ok: false, error: '不明な操作: ' + body.action });
      fn(body);
      changed();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }
  // 外部ツールから GET で操作できる簡易エンドポイント（例: /api/spin, /api/add?id=custom1&n=1）
  if (p === '/api/spin') {
    actions.spin();
    changed();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/add') {
    try {
      actions.adjust({ id: url.searchParams.get('id'), delta: url.searchParams.get('n') || 1 });
      changed();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  // 静的ファイル
  let file = p === '/' ? '/index.html' : p;
  if (file.endsWith('/')) file += 'index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(file)));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// SSE の接続維持
setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 20000);

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 配信カウンター & 盛り上がりメーター 起動しました');
  console.log(` 操作パネル : http://localhost:${PORT}/`);
  console.log(` OBS用      : http://localhost:${PORT}/overlay/counter.html`);
  console.log(`              http://localhost:${PORT}/overlay/meter.html`);
  console.log(`              http://localhost:${PORT}/overlay/roulette.html`);
  console.log(' 終了するにはこのウィンドウを閉じてください');
  console.log('======================================================');
  oneCommeRestart();
  youtubeRestart();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`ポート ${PORT} は使用中です。すでに起動していないか確認してください。`);
  } else {
    console.error(err);
  }
});

function shutdown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 起動時に保存済みのキューがあれば処理
setTimeout(processSpinQueue, 3000);

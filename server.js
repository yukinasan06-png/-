'use strict';
// 配信用カウンター & 盛り上がりメーター & ルーレット
// 依存パッケージなし（Node.js 標準モジュールのみ）で動作します。
// このサーバーは外部へは接続しません。わんコメ・YouTube の取得はブラウザ側（public/connector.js）が行います。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8790; // 既存ツール(8787)と同時に使えるように別ポート
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');
const SOUNDS_DIR = path.join(__dirname, 'sounds'); // ルーレット用の音声ファイル置き場
const SOUND_EXT = ['.mp3', '.wav', '.ogg', '.m4a'];

// 画面側（public/app.js の APP_VERSION）と合わせる。ずれていると操作パネルに再起動の案内が出る
const VERSION = 8;

const TEMPLATE_COUNT = 30;
const CUSTOM_COUNT = 10;
const HISTORY_MAX = 30;

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

function defaultItems() {
  const items = [
    { id: 'likes', name: '高評価', kind: 'auto', value: 0, points: 1, show: true },
    // 同接は増えたり減ったりするので、メーターには「最高同接 × pt」で加算する
    { id: 'viewers', name: '同接', kind: 'auto', value: 0, peak: 0, points: 0, show: true },
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
      // likes / gift / viewers の取得元: 'youtube' | 'onecomme' | 'off'
      sources: { likes: 'youtube', gift: 'youtube', viewers: 'youtube' },
      meter: { title: '盛り上がりメーター', threshold: 100, autoSpin: true },
      roulette: {
        duration: 6,
        hold: 5,
        shuffleEachSpin: false,
        alwaysShow: false,
        // 効果音: startSe / resultSe は ''=内蔵の音, 'none'=なし, それ以外=sounds フォルダのファイル名。bgm は ''=なし
        soundOn: true,
        volume: 0.7,
        tick: true,
        startSe: '',
        bgm: '',
        resultSe: '',
      },
    },
    meter: { fired: 0 },
    likes: { base: 0, raw: null, videoId: '' },
    roulette: { templates: defaultTemplates(), active: 0, queue: 0, history: [] },
    order: [], // 項目の表示順（id の並び。空なら既定の順）
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
    if (Array.isArray(saved.order)) s.order = saved.order.filter(id => s.items.some(i => i.id === id));
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

// 表示順に並べた項目一覧（order に無い項目は既定の順で後ろへ）
function orderedItems() {
  const pos = id => {
    const i = state.order.indexOf(id);
    return i < 0 ? 1000 + state.items.findIndex(x => x.id === id) : i;
  };
  return state.items.slice().sort((a, b) => pos(a.id) - pos(b.id));
}

function itemActive(it) {
  return it.kind === 'auto' || it.enabled;
}

function totalPoints() {
  let t = 0;
  for (const it of state.items) {
    if (!itemActive(it)) continue;
    t += (it.id === 'viewers' ? it.peak || 0 : it.value || 0) * (it.points || 0);
    if (it.id === 'superchat' && it.yenPoints) t += ((it.amount || 0) / 100) * it.yenPoints;
  }
  return Math.floor(t);
}

// ---------------------------------------------------------------------------
// ハブ（自作 WebSocket サーバー）
//  - 操作パネル / OBS 画面がここにつながる
//  - わんコメ・YouTube への接続はブラウザ側（connector.js）が行い、結果をここへ送る
//    （このサーバー自身は外部へ一切接続しません）
// ---------------------------------------------------------------------------

const clients = new Set(); // { socket, role, id }
let clientSeq = 0;
let leader = null; // わんコメ・YouTube の取得を担当する画面
const status = {
  onecomme: { state: 'off', message: '取得担当の画面がありません' },
  youtube: { state: 'off', message: '取得担当の画面がありません' },
};

function publicState() {
  const total = totalPoints();
  const threshold = Math.max(1, state.settings.meter.threshold);
  return {
    items: orderedItems(),
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
    version: VERSION,
  };
}

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function sendTo(client, obj) {
  try {
    client.socket.write(encodeFrame(JSON.stringify(obj)));
  } catch (e) {}
}

function broadcast(obj) {
  const frame = encodeFrame(JSON.stringify(obj));
  for (const c of clients) {
    try {
      c.socket.write(frame);
    } catch (e) {}
  }
}

let broadcastTimer = null;
function changed() {
  checkMeter();
  scheduleSave();
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcast({ t: 'state', state: publicState() });
  }, 50);
}

function emit(event) {
  broadcast({ t: 'event', event });
}

// 取得担当（リーダー）を選ぶ：操作パネル優先、なければ OBS 画面
function electLeader() {
  const list = [...clients].filter(c => c.role === 'panel' || c.role === 'overlay');
  const next = list.find(c => c.role === 'panel') || list[0] || null;
  if (next === leader && (!leader || clients.has(leader))) return;
  leader = next;
  status.onecomme = { state: 'off', message: leader ? '接続準備中…' : '取得担当の画面がありません' };
  status.youtube = { state: 'off', message: leader ? '接続準備中…' : '取得担当の画面がありません' };
  for (const c of clients) sendTo(c, { t: 'role', leader: c === leader });
  changed();
}

function handleUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  const client = { socket, role: 'unknown', id: ++clientSeq };
  clients.add(client);
  const bye = () => {
    if (!clients.delete(client)) return;
    if (client === leader) electLeader();
  };
  socket.on('close', bye);
  socket.on('error', bye);

  let buffer = Buffer.alloc(0);
  let frags = [];
  socket.on('data', data => {
    buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const dataStart = masked ? offset + 4 : offset;
      if (buffer.length < dataStart + len) return; // まだ全部届いていない
      const payload = Buffer.from(buffer.subarray(dataStart, dataStart + len));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(dataStart + len);

      if (opcode === 0x8) {
        socket.end();
        return bye();
      }
      if (opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0]));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        if (opcode === 0x1) frags = [];
        frags.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(frags).toString('utf8');
        frags = [];
        try {
          onMessage(client, JSON.parse(text));
        } catch (e) {
          console.error('[ws] メッセージ処理エラー:', e.message);
        }
      }
    }
  });
}

function onMessage(client, msg) {
  switch (msg.cmd) {
    case 'hello':
      client.role = msg.role === 'panel' ? 'panel' : 'overlay';
      sendTo(client, { t: 'state', state: publicState() });
      if (!leader || (client.role === 'panel' && leader.role !== 'panel')) {
        if (leader) sendTo(leader, { t: 'role', leader: false });
        leader = null;
        electLeader();
      } else {
        sendTo(client, { t: 'role', leader: client === leader });
      }
      break;

    // 以下は取得担当の画面からのみ受け付ける
    case 'onecomme':
      if (client === leader) handleOneCommeMessage(msg.msg || {});
      break;
    case 'likes':
      if (client === leader) updateLikes(Number(msg.count) || 0, msg.source, msg.videoId);
      break;
    case 'viewers':
      if (client === leader) updateViewers(Number(msg.count) || 0);
      break;
    case 'gifts':
      if (client === leader) handleYoutubeGifts(msg.gifts);
      break;
    // OBS のルーレット画面からの効果音の再生結果
    case 'soundReport':
      if (msg.ok) {
        if (status.sound && status.sound.name === msg.name) delete status.sound;
      } else {
        status.sound = { name: String(msg.name || ''), reason: String(msg.reason || 'error'), time: Date.now() };
      }
      changed();
      break;
    case 'status':
      if (client === leader && (msg.key === 'onecomme' || msg.key === 'youtube')) {
        status[msg.key] = { state: String(msg.state || 'off'), message: String(msg.message || '') };
        changed();
      }
      break;
  }
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

// わんコメの WebSocket メッセージ（ブラウザ側から中継されてくる）
function handleOneCommeMessage(msg) {
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
  if (type === 'meta' && state.settings.sources.viewers === 'onecomme') {
    const n = findCount(data, ['viewer', 'viewers', 'concurrentViewers', 'viewerCount']);
    if (n !== null) updateViewers(n);
  }
}

function findCount(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return null;
  for (const key of keys) {
    if (typeof obj[key] === 'number') return obj[key];
    if (typeof obj[key] === 'string' && /^\d+$/.test(obj[key])) return Number(obj[key]);
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const r = findCount(v, keys, depth + 1);
      if (r !== null) return r;
    }
  }
  return null;
}

// 同接（現在値と最高値）
function updateViewers(n) {
  const it = getItem('viewers');
  it.value = Math.max(0, Math.trunc(n));
  it.peak = Math.max(it.peak || 0, it.value);
  changed();
}

// ---------------------------------------------------------------------------
// YouTube（高評価・メンギフ）: ブラウザ側で取得した結果を受け取る
// ---------------------------------------------------------------------------

// この時刻より前のメンギフは数えない（再起動・画面の切り替え時の二重カウント防止）
let giftSince = Date.now();
const seenGifts = new Set();

function updateLikes(raw, source, videoId) {
  const L = state.likes;
  if (videoId && L.videoId !== videoId) {
    // 別の配信に切り替えたら高評価の基準をリセット
    L.videoId = videoId;
    L.base = 0;
  }
  L.raw = raw;
  L.source = source;
  const it = getItem('likes');
  it.value = Math.max(0, raw - (L.base || 0));
  changed();
}

function handleYoutubeGifts(gifts) {
  if (!Array.isArray(gifts) || state.settings.sources.gift !== 'youtube') return;
  let added = false;
  for (const g of gifts) {
    if (!g || !g.id || seenGifts.has(g.id)) continue;
    seenGifts.add(g.id);
    const t = Date.parse(g.time);
    if (Number.isFinite(t) && t < giftSince) continue;
    addValue('gift', Math.max(1, Math.trunc(Number(g.count) || 1)));
    added = true;
  }
  if (seenGifts.size > 20000) {
    const keep = [...seenGifts].slice(-5000);
    seenGifts.clear();
    keep.forEach(id => seenGifts.add(id));
  }
  if (added) changed();
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
    if (it.id === 'viewers') it.peak = 0;
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
    if (id === 'viewers') it.peak = Math.max(it.peak || 0, it.value);
  },
  setValue({ id, value }) {
    const it = getItem(id);
    if (!it) throw new Error('項目がありません');
    const before = it.value || 0;
    it.value = Math.max(0, Math.trunc(num(value, 0)));
    if (id === 'likes') state.likes.base = (state.likes.base || 0) - (it.value - before);
    if (id === 'viewers') it.peak = it.value;
  },
  setOrder({ order }) {
    if (!Array.isArray(order)) throw new Error('並び順が不正です');
    const ids = [...new Set(order.map(String))].filter(id => getItem(id));
    for (const it of state.items) if (!ids.includes(it.id)) ids.push(it.id);
    state.order = ids;
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
    if (id === 'viewers') it.peak = 0;
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
      if (ok.includes(s.sources.viewers)) cur.sources.viewers = s.sources.viewers;
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
      if (r.soundOn !== undefined) cur.roulette.soundOn = !!r.soundOn;
      if (r.tick !== undefined) cur.roulette.tick = !!r.tick;
      if (r.volume !== undefined) cur.roulette.volume = Math.min(1, Math.max(0, num(r.volume, 0.7)));
      for (const k of ['startSe', 'bgm', 'resultSe']) {
        if (r[k] !== undefined) cur.roulette[k] = r[k] === 'none' ? 'none' : safeSoundName(r[k]) || '';
      }
    }
    // 接続先の変更はブラウザ側（connector.js）が状態の更新を見て再接続する
    if (JSON.stringify(cur.onecomme) !== ocBefore) status.onecomme = { state: 'connecting', message: '再接続中…' };
    if (JSON.stringify([cur.youtube, cur.sources]) !== ytBefore) {
      status.youtube = { state: 'connecting', message: '再接続中…' };
      giftSince = Date.now();
    }
  },
  reconnect() {
    broadcast({ t: 'reconnect' });
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
    if (kind === 'viewers') {
      updateViewers(clampInt(count, 0, 10000000, 10));
      return;
    }
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
  '.m4a': 'audio/mp4',
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

// 音声ファイル名として安全な名前にする（フォルダ区切りや使えない文字を除く）。不正なら ''
function safeSoundName(v) {
  const name = path.basename(String(v || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  if (!name || !SOUND_EXT.includes(path.extname(name).toLowerCase())) return '';
  return name.slice(0, 120);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

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
  // ---- 音声ファイル（ルーレット用）----
  if (p === '/api/sounds') {
    fs.readdir(SOUNDS_DIR, (err, list) => {
      const files = err ? [] : list.filter(f => SOUND_EXT.includes(path.extname(f).toLowerCase())).sort();
      json(res, 200, { ok: true, files });
    });
    return;
  }
  if (p === '/upload' && req.method === 'POST') {
    const name = safeSoundName(url.searchParams.get('name'));
    if (!name) return json(res, 400, { ok: false, error: 'mp3 / wav / ogg / m4a のファイルを選んでください' });
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', c => {
      size += c.length;
      if (size > 30 * 1024 * 1024) {
        tooBig = true;
        return req.destroy();
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return json(res, 413, { ok: false, error: 'ファイルが大きすぎます（30MBまで）' });
      fs.mkdir(SOUNDS_DIR, { recursive: true }, () => {
        fs.writeFile(path.join(SOUNDS_DIR, name), Buffer.concat(chunks), err => {
          if (err) return json(res, 500, { ok: false, error: '保存できませんでした: ' + err.message });
          console.log('[sound] 追加:', name);
          json(res, 200, { ok: true, name });
        });
      });
    });
    req.on('error', () => {});
    return;
  }
  if (p.startsWith('/sounds/')) {
    let name = '';
    try {
      name = safeSoundName(decodeURIComponent(p.slice('/sounds/'.length)));
    } catch (e) {}
    if (!name) {
      res.writeHead(404);
      return res.end();
    }
    fs.readFile(path.join(SOUNDS_DIR, name), (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

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

  // 全角の「？＆＝」や空白が混ざったURL（日本語入力のまま打った場合など）は正しいURLに直して開き直す
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch (e) {}
  const fixed = decoded.replace(/？/g, '?').replace(/＆/g, '&').replace(/＝/g, '=').replace(/[\s\u3000]+/g, '');
  if (fixed !== decoded) {
    const q = fixed.indexOf('?');
    const pathPart = q >= 0 ? fixed.slice(0, q) : fixed;
    const query = (q >= 0 ? fixed.slice(q + 1) : '') + (url.search ? '&' + url.search.slice(1) : '');
    res.writeHead(302, { Location: encodeURI(pathPart) + (query ? '?' + query.replace(/^&/, '') : '') });
    return res.end();
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
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        `<meta charset="utf-8"><body style="font-family:sans-serif;padding:20px;color:#6b4a5c">` +
          `<h3>ページが見つかりません（${String(decoded).replace(/[<>&"]/g, '')}）</h3>` +
          `<p>URLを確認してください。使えるURLは <a href="/">操作パネル</a> の「OBS用URL」タブからコピーできます。</p></body>`
      );
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => handleUpgrade(req, socket));

// 想定外のエラーでもサーバーを止めない（配信中に落ちないための保険）
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.message ? e.message : e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.message ? e.message : e));

server.listen(PORT, HOST, () => {
  console.log('======================================================');
  console.log(' 配信カウンター & 盛り上がりメーター 起動しました');
  console.log(` 操作パネル : http://localhost:${PORT}/`);
  console.log(` OBS用      : http://localhost:${PORT}/overlay/counter.html`);
  console.log(`              http://localhost:${PORT}/overlay/meter.html`);
  console.log(`              http://localhost:${PORT}/overlay/roulette.html`);
  console.log(' ※ わんコメ・YouTube の自動カウントは、操作パネルか');
  console.log('   OBS の画面が開いている間に行われます');
  console.log(' 終了するにはこのウィンドウを閉じてください');
  console.log('======================================================');
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

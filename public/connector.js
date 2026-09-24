'use strict';
/* =========================================================================
 * ハブ接続 + わんコメ / YouTube 取得（ブラウザ側）
 *  - ハブ（server.js）に WebSocket でつなぎ、状態を受け取る
 *  - サーバーから「取得担当」に選ばれた画面だけが、わんコメと YouTube に接続して
 *    結果をハブへ送る（操作パネル優先。なければ OBS の画面が担当）
 * =======================================================================*/

// server.js の VERSION と合わせる（ずれていたら OBS 画面は自動で読み込み直す）
const CLIENT_VERSION = 9;

const Hub = (() => {
  let ws = null;
  let S = null;
  let isLeader = false;
  const handlers = { state: [], event: [] };

  function connect(role) {
    ws = new WebSocket(`ws://${location.host}/`);
    ws.onopen = () => ws.send(JSON.stringify({ cmd: 'hello', role }));
    ws.onmessage = e => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      if (msg.t === 'state') {
        if (role === 'overlay' && msg.state.version !== undefined && msg.state.version !== CLIENT_VERSION) return reloadForUpdate();
        S = msg.state;
        handlers.state.forEach(fn => fn(S));
        Fetcher.update();
      } else if (msg.t === 'event') {
        handlers.event.forEach(fn => fn(msg.event));
      } else if (msg.t === 'role') {
        isLeader = !!msg.leader;
        Fetcher.update();
      } else if (msg.t === 'reconnect') {
        Fetcher.restart();
      }
    };
    ws.onclose = () => {
      isLeader = false;
      Fetcher.update();
      setTimeout(() => connect(role), 2000);
    };
  }

  // サーバーが更新されたら OBS 画面を読み込み直す（連続リロードは 30 秒あける）
  function reloadForUpdate() {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem('hubReloadAt')) || 0;
      if (Date.now() - last < 30000) return;
      sessionStorage.setItem('hubReloadAt', String(Date.now()));
    } catch (e) {}
    const u = new URL(location.href);
    u.searchParams.set('_v', String(Date.now()));
    location.replace(u.toString());
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  return {
    start(role, onState, onEvent) {
      if (onState) handlers.state.push(onState);
      if (onEvent) handlers.event.push(onEvent);
      connect(role);
    },
    send,
    get state() {
      return S;
    },
    get leader() {
      return isLeader;
    },
  };
})();

const Fetcher = (() => {
  let active = false;
  let ocKey = '';
  let ytKey = '';

  function status(key, state, message) {
    Hub.send({ cmd: 'status', key, state, message });
  }

  function update() {
    const S = Hub.state;
    const want = Hub.leader && !!S;
    if (!want) {
      if (active) stopAll();
      active = false;
      return;
    }
    active = true;
    const oc = JSON.stringify(S.settings.onecomme);
    if (oc !== ocKey) {
      ocKey = oc;
      ocRestart();
    }
    const yt = JSON.stringify([S.settings.youtube, S.settings.sources]);
    if (yt !== ytKey) {
      ytKey = yt;
      ytRestart();
    }
  }

  function stopAll() {
    ocKey = '';
    ytKey = '';
    ocClose();
    yt.gen++;
    clearTimeout(yt.videoTimer);
    clearTimeout(yt.chatTimer);
  }

  function restart() {
    ocKey = '';
    ytKey = '';
    update();
  }

  // ---------------- わんコメ ----------------
  let oc = null;
  let ocGen = 0;
  let ocTimer = null;

  function ocClose() {
    ocGen++;
    clearTimeout(ocTimer);
    if (oc) {
      try {
        oc.close();
      } catch (e) {}
    }
    oc = null;
  }

  function ocRestart() {
    ocClose();
    const cfg = Hub.state.settings.onecomme;
    if (!cfg.enabled) return status('onecomme', 'off', '無効');
    const gen = ocGen;
    status('onecomme', 'connecting', `${cfg.host}:${cfg.port} に接続中…`);
    let sock;
    try {
      sock = new WebSocket(`ws://${cfg.host}:${cfg.port}/sub`);
    } catch (e) {
      status('onecomme', 'error', '接続できません: ' + e.message);
      ocTimer = setTimeout(() => gen === ocGen && ocRestart(), 5000);
      return;
    }
    oc = sock;
    sock.onopen = () => gen === ocGen && status('onecomme', 'ok', '接続中');
    sock.onmessage = e => {
      if (gen !== ocGen) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      const data = msg.data || {};
      if (msg.type === 'connected') {
        // 既存コメントは ID だけ送る（カウントしない）
        const comments = (data.comments || []).map(c => ({ id: c.id || (c.data && c.data.id) }));
        Hub.send({ cmd: 'onecomme', msg: { type: 'connected', data: { comments } } });
      } else if (msg.type === 'comments' || msg.type === 'meta') {
        Hub.send({ cmd: 'onecomme', msg: { type: msg.type, data } });
      }
    };
    sock.onclose = () => {
      if (gen !== ocGen) return;
      oc = null;
      status('onecomme', 'error', 'わんコメに接続できません（起動していますか？ 5秒後に再接続）');
      ocTimer = setTimeout(() => gen === ocGen && ocRestart(), 5000);
    };
  }

  // ---------------- YouTube Data API ----------------
  const yt = { gen: 0, videoTimer: null, chatTimer: null, liveChatId: null, pageToken: null, chatError: null };

  async function getJson(url) {
    const r = await fetch(url);
    let j = {};
    try {
      j = await r.json();
    } catch (e) {}
    if (!r.ok) {
      const err = new Error((j.error && j.error.message) || 'HTTP ' + r.status);
      err.reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
      throw err;
    }
    return j;
  }

  function parseVideoId(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    if (/^[\w-]{11}$/.test(s)) return s;
    const m = s.match(/[?&]v=([\w-]{11})/) || s.match(/youtu\.be\/([\w-]{11})/) || s.match(/\/(?:live|shorts|embed)\/([\w-]{11})/);
    return m ? m[1] : '';
  }

  function sources() {
    return Hub.state.settings.sources;
  }

  async function ytRestart() {
    yt.gen++;
    const gen = yt.gen;
    clearTimeout(yt.videoTimer);
    clearTimeout(yt.chatTimer);
    yt.liveChatId = null;
    yt.pageToken = null;
    yt.chatError = null;
    const cfg = Hub.state.settings.youtube;
    const src = sources();
    if (src.likes !== 'youtube' && src.gift !== 'youtube' && src.viewers !== 'youtube') return status('youtube', 'off', '未使用（取得元がYouTube以外）');
    if (!cfg.apiKey) return status('youtube', 'off', 'APIキー未設定');

    let videoId = parseVideoId(cfg.video);
    if (!videoId && cfg.channelId) {
      status('youtube', 'connecting', 'チャンネルの配信を検索中…');
      try {
        const r = await getJson(
          `https://www.googleapis.com/youtube/v3/search?part=id&type=video&eventType=live&channelId=${encodeURIComponent(cfg.channelId)}&key=${encodeURIComponent(cfg.apiKey)}`
        );
        if (gen !== yt.gen) return;
        videoId = r.items && r.items[0] && r.items[0].id && r.items[0].id.videoId;
        if (!videoId) {
          status('youtube', 'error', '配信中のライブが見つかりません（60秒後に再検索）');
          yt.videoTimer = setTimeout(() => gen === yt.gen && ytRestart(), 60000);
          return;
        }
      } catch (e) {
        if (gen !== yt.gen) return;
        status('youtube', 'error', '検索エラー: ' + e.message);
        yt.videoTimer = setTimeout(() => gen === yt.gen && ytRestart(), 60000);
        return;
      }
    }
    if (!videoId) return status('youtube', 'off', '配信URL（または動画ID / チャンネルID）未設定');
    status('youtube', 'connecting', `動画 ${videoId} に接続中…`);
    pollVideo(gen, videoId);
  }

  async function pollVideo(gen, videoId) {
    const cfg = Hub.state.settings.youtube;
    try {
      const r = await getJson(
        `https://www.googleapis.com/youtube/v3/videos?part=statistics,liveStreamingDetails&id=${videoId}&key=${encodeURIComponent(cfg.apiKey)}`
      );
      if (gen !== yt.gen) return;
      const v = r.items && r.items[0];
      if (!v) throw new Error('動画が見つかりません');
      const msgs = [`動画 ${videoId}`];
      if (sources().likes === 'youtube' && v.statistics && v.statistics.likeCount !== undefined) {
        const n = Number(v.statistics.likeCount) || 0;
        Hub.send({ cmd: 'likes', count: n, source: 'youtube', videoId });
        msgs.push(`高評価 ${n}`);
      }
      if (sources().viewers === 'youtube') {
        const cv = v.liveStreamingDetails && v.liveStreamingDetails.concurrentViewers;
        if (cv !== undefined) {
          Hub.send({ cmd: 'viewers', count: Number(cv) || 0 });
          msgs.push(`同接 ${cv}`);
        } else {
          msgs.push('同接なし（配信前/終了？）');
        }
      }
      const chatId = v.liveStreamingDetails && v.liveStreamingDetails.activeLiveChatId;
      if (sources().gift === 'youtube') {
        if (chatId) {
          msgs.push('チャット取得中');
          if (chatId !== yt.liveChatId) {
            yt.liveChatId = chatId;
            yt.pageToken = null;
            clearTimeout(yt.chatTimer);
            pollChat(gen);
          }
        } else {
          msgs.push('ライブチャットなし（配信前/終了？）');
        }
      }
      if (!yt.chatError) status('youtube', 'ok', msgs.join(' / '));
    } catch (e) {
      if (gen !== yt.gen) return;
      status('youtube', 'error', 'YouTube API エラー: ' + e.message);
      if (e.reason === 'quotaExceeded') {
        yt.videoTimer = setTimeout(() => pollVideo(gen, videoId), 10 * 60 * 1000);
        return;
      }
    }
    const interval = Math.max(10, Number(cfg.likeInterval) || 30) * 1000;
    yt.videoTimer = setTimeout(() => pollVideo(gen, videoId), interval);
  }

  async function pollChat(gen) {
    const cfg = Hub.state.settings.youtube;
    let wait = Math.max(5, Number(cfg.chatInterval) || 15) * 1000;
    try {
      let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet&maxResults=2000&liveChatId=${encodeURIComponent(
        yt.liveChatId
      )}&key=${encodeURIComponent(cfg.apiKey)}`;
      if (yt.pageToken) url += '&pageToken=' + encodeURIComponent(yt.pageToken);
      const r = await getJson(url);
      if (gen !== yt.gen) return;
      yt.chatError = null;
      yt.pageToken = r.nextPageToken || yt.pageToken;
      const gifts = [];
      for (const m of r.items || []) {
        const sn = m.snippet || {};
        if (sn.type === 'membershipGiftingEvent') {
          gifts.push({
            id: m.id,
            time: sn.publishedAt,
            count: Number(sn.membershipGiftingDetails && sn.membershipGiftingDetails.giftMembershipsCount) || 1,
          });
        }
      }
      // 古いメッセージや重複はサーバー側で除外される
      if (gifts.length) Hub.send({ cmd: 'gifts', gifts });
      if (r.pollingIntervalMillis) wait = Math.max(wait, r.pollingIntervalMillis);
    } catch (e) {
      if (gen !== yt.gen) return;
      yt.chatError = e.message;
      status('youtube', 'error', 'ライブチャット取得エラー: ' + e.message);
      if (e.reason === 'liveChatEnded' || e.reason === 'liveChatNotFound') {
        yt.liveChatId = null;
        return;
      }
      wait = e.reason === 'quotaExceeded' ? 10 * 60 * 1000 : 30000;
    }
    yt.chatTimer = setTimeout(() => pollChat(gen), wait);
  }

  return { update, restart };
})();

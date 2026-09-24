'use strict';
/* =========================================================================
 * ルーレットの効果音
 *  - 設定（settings.roulette）の startSe / bgm / resultSe に従って鳴らす
 *    ''     … 内蔵の音（開始音・結果音）。BGM は '' で「なし」
 *    'none' … 鳴らさない
 *    それ以外 … sounds フォルダの音声ファイル名
 * =======================================================================*/
const Sound = (() => {
  let ctx = null;
  let bgm = null;

  function ac() {
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) {
      return null;
    }
    return ctx;
  }

  function vol(o) {
    const v = Number(o && o.volume);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.7;
  }

  // 内蔵音: 短い音を並べて鳴らす
  function notes(list, v, type) {
    const a = ac();
    if (!a) return;
    for (const [freq, at, len, gain] of list) {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      o.frequency.value = freq;
      const t = a.currentTime + at;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * v), t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + len + 0.05);
    }
  }

  const builtin = {
    // キラキラ上がる開始音
    start: v => notes([[784, 0, .12, .12], [988, .07, .12, .12], [1175, .14, .12, .12], [1568, .21, .35, .12], [2093, .28, .4, .08]], v, 'sine'),
    tick: v => notes([[1500, 0, .045, .18]], v, 'triangle'),
    // ファンファーレ
    result: v =>
      notes([[523, 0, .14, .1], [659, .12, .14, .1], [784, .24, .14, .1], [1047, .36, .6, .1], [784, .36, .6, .05], [1319, .5, .5, .06]], v, 'square'),
  };

  // 再生結果の通知先（OBS 画面がサーバーへ報告するのに使う）
  let reporter = null;

  function playFile(name, v, loop, fallback) {
    const el = new Audio('/sounds/' + encodeURIComponent(name));
    el.volume = v;
    el.loop = !!loop;
    let failed = false;
    const fail = reason => {
      if (failed) return;
      failed = true;
      if (fallback) fallback();
      if (reporter) reporter({ ok: false, name, reason });
    };
    el.addEventListener('error', () => {
      const code = el.error && el.error.code;
      fail(code === 4 ? 'unsupported' : code === 2 ? 'network' : 'error');
    });
    el.addEventListener('playing', () => reporter && reporter({ ok: true, name }), { once: true });
    el.play().catch(e => fail(e && e.name === 'NotAllowedError' ? 'blocked' : e && e.name === 'NotSupportedError' ? 'unsupported' : 'error'));
    return el;
  }

  function play(kind, o) {
    const v = vol(o);
    const key = kind === 'start' ? 'startSe' : 'resultSe';
    const f = o[key];
    if (f === 'none') return;
    // ファイルが鳴らせなかったときは内蔵の音で代わりに鳴らす
    if (f) playFile(f, v, false, () => builtin[kind](v));
    else builtin[kind](v);
  }

  let bgmTimer = null;

  // BGM を止める（フェードアウト）。画面が見えていなくても確実に止まるよう setInterval を使う
  function stopBgm(fadeMs = 600) {
    clearTimeout(bgmTimer);
    const el = bgm;
    bgm = null;
    if (!el) return;
    const halt = () => {
      el.pause();
      el.currentTime = 0;
      el.src = '';
    };
    if (!fadeMs) return halt();
    const from = el.volume;
    const t0 = Date.now();
    const iv = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / fadeMs);
      el.volume = Math.max(0, from * (1 - k));
      if (k >= 1) {
        clearInterval(iv);
        halt();
      }
    }, 40);
  }

  return {
    // ルーレット開始（開始音＋BGM）。maxMs 経ったら BGM は必ず止める（止め忘れ防止）
    start(o, maxMs) {
      stopBgm(0);
      if (!o || !o.soundOn) return;
      play('start', o);
      if (o.bgm && o.bgm !== 'none') {
        bgm = playFile(o.bgm, vol(o), true);
        if (maxMs) bgmTimer = setTimeout(() => stopBgm(), maxMs);
      }
    },
    tick(o) {
      if (o && o.soundOn && o.tick) builtin.tick(vol(o));
    },
    // 結果が出た（BGM を止めて結果音）
    result(o) {
      if (!o || !o.soundOn) return;
      stopBgm();
      play('result', o);
    },
    stopBgm,
    onReport(fn) {
      reporter = fn;
    },
    // 操作パネルの試聴用
    preview(kind, o) {
      const opt = Object.assign({}, o, { soundOn: true });
      stopBgm(0);
      if (kind === 'bgm') {
        if (!opt.bgm || opt.bgm === 'none') return false;
        bgm = playFile(opt.bgm, vol(opt), true);
        bgmTimer = setTimeout(() => stopBgm(), 5000);
      } else if (kind === 'tick') {
        for (let i = 0; i < 8; i++) setTimeout(() => builtin.tick(vol(opt)), i * (60 + i * 25));
      } else {
        play(kind, opt);
      }
      return true;
    },
  };
})();

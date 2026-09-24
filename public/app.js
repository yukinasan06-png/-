'use strict';

let S = null; // サーバーから受け取った状態
let selectedTpl = 0;
let tplDirty = false;
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// ---------------- 通信 ----------------
async function act(action, params = {}) {
  try {
    const r = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...params }),
    });
    const j = await r.json();
    if (!j.ok) toast('エラー: ' + j.error);
    return j;
  } catch (e) {
    toast('サーバーに接続できません');
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function connect() {
  Hub.start(
    'panel',
    state => {
      S = state;
      render();
    },
    onEvent
  );
}

function onEvent(ev) {
  if (ev.type === 'meterFull') toast('🎉 メーター満タン！');
  if (ev.type === 'spin') $('#rl-result').textContent = '🎡 回転中…';
  if (ev.type === 'result') {
    $('#rl-result').textContent = '🎯 ' + ev.spin.result;
  }
}

// 入力中の欄は上書きしない
function setField(el, v) {
  if (!el || el === document.activeElement || el.dataset.dirty) return;
  if (el.type === 'checkbox') el.checked = !!v;
  else el.value = v ?? '';
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

// ---------------- 描画 ----------------
function render() {
  if (!S) return;
  renderHeader();
  renderCounters();
  renderMeter();
  renderRoulette();
  renderConnect();
}

function renderHeader() {
  const m = S.meter;
  $('#hdr-title').textContent = m.title;
  $('#hdr-fill').style.width = (m.progress / m.threshold) * 100 + '%';
  $('#hdr-label').textContent = `${fmt(m.progress)} / ${fmt(m.threshold)} pt`;
  $('#hdr-queue').textContent = S.roulette.queue ? `(待機 ${S.roulette.queue})` : '';
  for (const [key, el] of [['onecomme', '#st-oc'], ['youtube', '#st-yt']]) {
    const st = S.status[key];
    const node = $(el);
    node.querySelector('.dot').className = 'dot ' + st.state;
    node.title = st.message;
  }
}

let counterKeys = '';
function visibleItems() {
  return S.items.filter(it => it.kind === 'auto' || it.enabled);
}

function renderCounters() {
  const items = visibleItems();
  const keys = items.map(i => i.id).join(',');
  const wrap = $('#counters');
  if (keys !== counterKeys) {
    counterKeys = keys;
    wrap.innerHTML = '';
    for (const it of items) wrap.appendChild(buildCounter(it));
  }
  for (const it of items) {
    const card = wrap.querySelector(`[data-id="${it.id}"]`);
    const valEl = card.querySelector('.value');
    const prev = valEl.dataset.v;
    let html = fmt(it.value);
    if (it.id === 'superchat') html += `<small>¥${fmt(it.amount)}</small>`;
    if (it.id === 'likes') {
      const src = S.settings.sources.likes;
      html += `<small>${src === 'off' ? '手動' : src === 'youtube' ? 'YouTube' : 'わんコメ'}${S.likes.raw != null ? ' / 総数 ' + fmt(S.likes.raw) : ''}</small>`;
    }
    if (it.id === 'gift') {
      const src = S.settings.sources.gift;
      html += `<small>${src === 'off' ? '手動' : src === 'youtube' ? 'YouTube' : 'わんコメ'}</small>`;
    }
    if (valEl.innerHTML !== html) valEl.innerHTML = html;
    if (prev !== undefined && prev !== String(it.value)) {
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    }
    valEl.dataset.v = String(it.value);
    card.querySelector('.title').textContent = it.name;
    card.title = it.name;
    setField(card.querySelector('.name'), it.name);
    setField(card.querySelector('.points'), it.points);
    setField(card.querySelector('.show'), it.show);
    const w = card.querySelector('.words');
    if (w) setField(w, (it.words || []).join(', '));
    const y = card.querySelector('.yen');
    if (y) setField(y, it.yenPoints);
  }
  const canAdd = S.items.some(i => i.kind === 'custom' && !i.enabled);
  $('#add-custom').disabled = !canAdd;
}

const ICONS = { likes: '💗', superchat: '💰', first: '🌱', comments: '💬', gift: '🎁', keyword: '✨' };

function buildCounter(it) {
  const el = document.createElement('div');
  el.className = 'counter';
  el.dataset.id = it.id;
  const isCustom = it.kind === 'custom';
  const hasWords = it.id === 'keyword' || isCustom;
  const num = isCustom ? Number(it.id.replace('custom', '')) : 0;
  el.innerHTML = `
    <div class="top">
      <span class="icon">${ICONS[it.id] || '⭐'}</span>
      <span class="title"></span>
      <button class="gear" title="設定">⚙</button>
    </div>
    <div class="value"></div>
    <div class="value-row">
      <button class="minus" title="−1">−</button>
      <button class="plus" title="+1">＋</button>
    </div>
    <div class="settings">
      <div class="settings-head"><b>${isCustom ? 'カスタム' + num : '自動'}の設定</b><button class="small close">閉じる</button></div>
      <div class="opts">
        <span>名前</span><input class="name" type="text" maxlength="40">
        <span>pt / 回</span><input class="points" type="number" step="any">
        ${it.id === 'superchat' ? '<span>pt / 100円</span><input class="yen" type="number" step="any">' : ''}
        ${hasWords ? `<span>${it.id === 'keyword' ? '言葉' : '反応ワード'}</span><input class="words" type="text" placeholder="カンマ区切り（例: 草, 888）">` : ''}
        <span>OBS表示</span><label><input class="show" type="checkbox"></label>
      </div>
      <div class="foot">
        <button class="small set">数値を指定</button>
        <button class="small reset">0に戻す</button>
        ${isCustom ? '<button class="small danger remove">項目を削除</button>' : ''}
      </div>
    </div>`;
  el.querySelector('.gear').onclick = e => {
    e.stopPropagation();
    const open = !el.classList.contains('open');
    $$('.counter.open').forEach(c => c.classList.remove('open'));
    el.classList.toggle('open', open);
  };
  el.querySelector('.close').onclick = () => el.classList.remove('open');
  el.querySelector('.settings').addEventListener('click', e => e.stopPropagation());
  const id = it.id;
  el.querySelector('.minus').onclick = () => act('adjust', { id, delta: -1 });
  el.querySelector('.plus').onclick = () => act('adjust', { id, delta: 1 });
  el.querySelector('.set').onclick = () => {
    const cur = S.items.find(i => i.id === id);
    const v = prompt(`「${cur.name}」の数値`, cur.value);
    if (v !== null && v.trim() !== '') act('setValue', { id, value: Number(v) });
  };
  el.querySelector('.reset').onclick = () => {
    const cur = S.items.find(i => i.id === id);
    if (confirm(`「${cur.name}」を0に戻しますか？`)) act('resetItem', { id });
  };
  const rm = el.querySelector('.remove');
  if (rm)
    rm.onclick = () => {
      const cur = S.items.find(i => i.id === id);
      if (confirm(`「${cur.name}」を削除しますか？（数値もリセットされます）`)) {
        act('setValue', { id, value: 0 });
        act('updateItem', { id, patch: { enabled: false } });
      }
    };
  const bind = (sel, key, conv = v => v) => {
    const input = el.querySelector(sel);
    if (!input) return;
    input.addEventListener('change', () => {
      const v = input.type === 'checkbox' ? input.checked : input.value;
      act('updateItem', { id, patch: { [key]: conv(v) } });
    });
  };
  bind('.name', 'name');
  bind('.points', 'points', Number);
  bind('.yen', 'yenPoints', Number);
  bind('.words', 'words');
  bind('.show', 'show');
  return el;
}

function renderMeter() {
  const m = S.meter;
  const f = $('#meter-form');
  setField(f.querySelector('[data-key=title]'), S.settings.meter.title);
  setField(f.querySelector('[data-key=threshold]'), S.settings.meter.threshold);
  setField(f.querySelector('[data-key=autoSpin]'), S.settings.meter.autoSpin);
  $('#meter-total').textContent = `合計 ${fmt(m.total)} pt`;
  $('#meter-detail').textContent = `満タン ${fmt(m.fired)} 回 ／ 次まで ${fmt(m.threshold - m.progress)} pt`;
  const rows = visibleItems().map(it => {
    let p = (it.value || 0) * (it.points || 0);
    let extra = '';
    if (it.id === 'superchat' && it.yenPoints) {
      const y = ((it.amount || 0) / 100) * it.yenPoints;
      p += y;
      extra = ` + 金額 ${fmt(Math.floor(y))}`;
    }
    return `<tr><td style="padding:4px 8px">${esc(it.name)}</td><td style="padding:4px 8px;text-align:right">${fmt(it.value)} × ${it.points}${extra}</td><td style="padding:4px 8px;text-align:right"><b>${fmt(Math.floor(p))}</b> pt</td></tr>`;
  });
  const html = rows.join('');
  const tbl = $('#meter-breakdown');
  if (tbl.innerHTML !== html) tbl.innerHTML = html;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderRoulette() {
  const R = S.roulette;
  // テンプレ一覧
  const grid = $('#tpl-grid');
  const html = R.templates
    .map(
      (t, i) =>
        `<button data-i="${i}" class="${i === selectedTpl ? 'selected' : ''} ${i === R.active ? 'active-tpl' : ''}" title="${esc(t.name)}"><span class="n">${
          i + 1
        }</span><span>${esc(t.name)}</span><span class="c">${t.items.length}</span></button>`
    )
    .join('');
  if (grid.dataset.html !== html) {
    grid.innerHTML = html;
    grid.dataset.html = html;
  }
  if (!tplDirty) loadTplEditor();
  $('#tpl-count').textContent = countLines() + ' 項目';
  $('#rl-active').textContent = `使用中: ${R.active + 1}. ${R.templates[R.active].name}`;
  const qb = $('#rl-queue');
  qb.hidden = !R.queue;
  qb.textContent = `待機 ${R.queue}`;
  if (R.spinning) {
    $('#rl-result').textContent = R.spinning.done ? '🎯 ' + R.spinning.result : '🎡 回転中…';
  }
  if (S.status.rouletteError) $('#rl-result').textContent = '⚠ ' + S.status.rouletteError;

  const opts = R.options;
  const f = $('#rl-form');
  for (const k of ['duration', 'hold', 'shuffleEachSpin', 'alwaysShow']) setField(f.querySelector(`[data-key=${k}]`), opts[k]);

  const hist = R.history
    .map(h => {
      const d = new Date(h.time);
      const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `<li><span class="time">${t}</span><span>${esc(h.result)}</span><span class="tpl">${esc(h.template)}</span></li>`;
    })
    .join('');
  const hl = $('#rl-history');
  if (hl.dataset.html !== hist) {
    hl.innerHTML = hist || '<li class="hint">まだありません</li>';
    hl.dataset.html = hist;
  }
}

function loadTplEditor() {
  const t = S.roulette.templates[selectedTpl];
  $('#tpl-no').textContent = `No.${selectedTpl + 1}`;
  $('#tpl-name').value = t.name;
  $('#tpl-items').value = t.items.join('\n');
  tplDirty = false;
  $('#tpl-count').textContent = countLines() + ' 項目';
}

function tplLines() {
  return $('#tpl-items')
    .value.split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}
function countLines() {
  return tplLines().length;
}

function renderConnect() {
  const s = S.settings;
  for (const [form, obj] of [
    ['#oc-form', s.onecomme],
    ['#yt-form', s.youtube],
    ['#src-form', s.sources],
  ]) {
    for (const el of $$(form + ' [data-key]')) setField(el, obj[el.dataset.key]);
  }
  $('#oc-status').innerHTML = statusHtml(S.status.onecomme);
  $('#yt-status').innerHTML = statusHtml(S.status.youtube);
}

function statusHtml(st) {
  return `<span class="dot ${st.state}"></span>${esc(st.message)}`;
}

function readForm(sel) {
  const out = {};
  for (const el of $$(sel + ' [data-key]')) {
    out[el.dataset.key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    delete el.dataset.dirty;
  }
  return out;
}

// ---------------- イベント ----------------
function setup() {
  // タブ
  $('#tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    $$('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    $$('section.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
    try {
      localStorage.setItem('tab', b.dataset.tab);
    } catch (e) {}
  });
  try {
    const t = localStorage.getItem('tab');
    if (t) $(`#tabs button[data-tab="${t}"]`)?.click();
  } catch (e) {}

  // 入力途中の設定フォームは状態更新で上書きしない
  for (const sel of ['#meter-form', '#rl-form', '#oc-form', '#yt-form', '#src-form']) {
    $(sel).addEventListener('input', e => {
      if (e.target.dataset.key) e.target.dataset.dirty = '1';
    });
  }

  $('#hdr-spin').onclick = () => act('spin');
  $('#rl-spin').onclick = () => act('spin');
  $('#rl-clear-queue').onclick = () => act('clearQueue');
  $('#rl-clear-history').onclick = () => confirm('履歴を消しますか？') && act('clearHistory');

  $('#add-custom').onclick = () => {
    const it = S.items.find(i => i.kind === 'custom' && !i.enabled);
    if (it) act('updateItem', { id: it.id, patch: { enabled: true } });
  };
  $('#reset-all').onclick = () => {
    if (confirm('すべてのカウンターとメーターを0に戻しますか？（ルーレット待機もクリアされます）')) act('resetCounters');
  };

  $('#meter-save').onclick = async () => {
    const r = await act('updateSettings', { settings: { meter: readForm('#meter-form') } });
    if (r?.ok) toast('保存しました');
  };
  $('#rl-save').onclick = async () => {
    const r = await act('updateSettings', { settings: { roulette: readForm('#rl-form') } });
    if (r?.ok) toast('保存しました');
  };
  $('#conn-save').onclick = async () => {
    const r = await act('updateSettings', {
      settings: { onecomme: readForm('#oc-form'), youtube: readForm('#yt-form'), sources: readForm('#src-form') },
    });
    await act('reconnect');
    if (r?.ok) toast('保存して再接続します');
  };
  $('#likes-base').onclick = () => {
    if (confirm('高評価カウンターを0にして、今の高評価数から数え直しますか？')) act('resetLikesBase');
  };

  // テンプレ
  $('#tpl-grid').addEventListener('click', e => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    if (tplDirty && !confirm('保存していない変更があります。破棄しますか？')) return;
    selectedTpl = Number(b.dataset.i);
    tplDirty = false;
    render();
  });
  $('#tpl-grid').addEventListener('dblclick', e => {
    const b = e.target.closest('button[data-i]');
    if (b) act('setActiveTemplate', { index: Number(b.dataset.i) });
  });
  for (const sel of ['#tpl-name', '#tpl-items']) {
    $(sel).addEventListener('input', () => {
      tplDirty = true;
      $('#tpl-count').textContent = countLines() + ' 項目（未保存）';
    });
  }
  const saveTpl = async () => {
    const r = await act('saveTemplate', { index: selectedTpl, name: $('#tpl-name').value, items: tplLines() });
    if (r?.ok) {
      tplDirty = false;
      toast('テンプレを保存しました');
    }
    return r;
  };
  $('#tpl-save').onclick = saveTpl;
  $('#tpl-shuffle').onclick = () => {
    const a = tplLines();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    $('#tpl-items').value = a.join('\n');
    saveTpl();
  };
  $('#tpl-dedupe').onclick = () => {
    $('#tpl-items').value = [...new Set(tplLines())].join('\n');
    saveTpl();
  };
  $('#tpl-clear').onclick = () => {
    if (!confirm('このテンプレの項目をすべて消しますか？')) return;
    $('#tpl-items').value = '';
    saveTpl();
  };
  $('#tpl-use').onclick = async () => {
    if (tplDirty) await saveTpl();
    act('setActiveTemplate', { index: selectedTpl });
    toast(`テンプレ ${selectedTpl + 1} を使用します`);
  };
  const addOne = () => {
    const v = $('#tpl-add').value.trim();
    if (!v) return;
    const ta = $('#tpl-items');
    ta.value = (ta.value.trim() ? ta.value.replace(/\s*$/, '\n') : '') + v;
    $('#tpl-add').value = '';
    saveTpl();
  };
  $('#tpl-add-btn').onclick = addOne;
  $('#tpl-add').addEventListener('keydown', e => e.key === 'Enter' && addOne());

  // 一括インポート / エクスポート
  $('#bulk-export').onclick = () => {
    $('#bulk-text').value = S.roulette.templates
      .map(t => `## ${t.name}\n${t.items.join('\n')}`)
      .join('\n');
  };
  $('#bulk-import').onclick = async () => {
    const blocks = [];
    let cur = null;
    for (const line of $('#bulk-text').value.split('\n')) {
      const m = line.match(/^\s*##\s*(.*)$/);
      if (m) {
        cur = { name: m[1].trim(), items: [] };
        blocks.push(cur);
      } else if (line.trim()) {
        if (!cur) {
          cur = { name: '', items: [] };
          blocks.push(cur);
        }
        cur.items.push(line.trim());
      }
    }
    if (!blocks.length) return toast('内容がありません');
    if (blocks.length > S.templateCount) return toast(`テンプレは最大${S.templateCount}個です`);
    if (!confirm(`テンプレ 1〜${blocks.length} を上書きします。よろしいですか？`)) return;
    for (let i = 0; i < blocks.length; i++) {
      await act('saveTemplate', { index: i, name: blocks[i].name || 'テンプレ' + (i + 1), items: blocks[i].items });
    }
    tplDirty = false;
    toast(`${blocks.length} 個のテンプレを反映しました`);
  };

  // テスト
  $$('[data-sim]').forEach(b => {
    b.onclick = () =>
      act('simulate', {
        kind: b.dataset.sim,
        text: $('#test-text').value,
        price: Number($('#test-price').value),
        count: Number($('#test-count').value),
      });
  });

  // OBS URL
  const base = location.origin;
  const urls = [
    ['カウンター（縦）', '/overlay/counter.html'],
    ['カウンター（横・正方形）', '/overlay/counter.html?layout=row'],
    ['メーター（横）', '/overlay/meter.html'],
    ['メーター（縦）', '/overlay/meter.html?vertical=1'],
    ['ルーレット', '/overlay/roulette.html'],
  ];
  $('#urls').innerHTML = urls
    .map(
      ([n, p]) => `<div class="url-row"><span class="name">${n}</span><input type="text" readonly value="${base + p}">
      <button class="copy">コピー</button><a href="${p}" target="_blank">開く</a></div>`
    )
    .join('');
  $$('#urls .copy').forEach(b => {
    b.onclick = async () => {
      const input = b.previousElementSibling;
      try {
        await navigator.clipboard.writeText(input.value);
      } catch (e) {
        input.select();
        document.execCommand('copy');
      }
      toast('コピーしました');
    };
  });

  // キーボードショートカット（カスタム1〜10）
  document.addEventListener('keydown', e => {
    if (!S || e.ctrlKey || e.altKey || e.metaKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const m = e.code.match(/^(?:Digit|Numpad)(\d)$/);
    if (!m) return;
    const n = m[1] === '0' ? 10 : Number(m[1]);
    const it = S.items.find(i => i.id === 'custom' + n);
    if (!it || !it.enabled) return;
    e.preventDefault();
    act('adjust', { id: it.id, delta: e.shiftKey ? -1 : 1 });
  });
}

// 設定の吹き出しは外側をクリックで閉じる
document.addEventListener('click', () => $$('.counter.open').forEach(c => c.classList.remove('open')));

setup();
connect();

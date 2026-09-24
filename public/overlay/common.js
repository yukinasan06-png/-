'use strict';
// オーバーレイ共通: サーバーの状態を受信する
const params = new URLSearchParams(location.search);

// connector.js の Hub を使う（操作パネルが開いていないときは、この画面がわんコメ・YouTube の取得を担当します）
function subscribe(onState, onEvent) {
  Hub.start('overlay', onState, onEvent);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const scale = Number(params.get('scale')) || 1;
if (scale !== 1) document.documentElement.style.zoom = scale;

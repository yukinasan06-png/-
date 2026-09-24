'use strict';
// オーバーレイ共通: サーバーの状態を受信する
const params = new URLSearchParams(location.search);

function subscribe(onState, onEvent) {
  const es = new EventSource('/events');
  es.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'state') onState && onState(msg.state);
    else if (msg.t === 'event') onEvent && onEvent(msg.event);
  };
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ja-JP');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const scale = Number(params.get('scale')) || 1;
if (scale !== 1) document.documentElement.style.zoom = scale;

// CfCopy - Cloudflare Worker + Durable Object 大文件中继服务
//
// 路由：
//   GET /register?id=<channelId>&token=<token>   cf-send 的 WebSocket 注册
//   GET /d/<channelId>/<key>                      下载端点（支持 Range 断点续传）
//   GET /health                                   健康检查
//
// 协议（DO <-> cf-send 之间）：
//   文本帧 = JSON 控制消息：
//     sender -> DO   : {t:'meta', name, size, mime}
//                      {t:'pong'}
//                      {t:'eof',  connId}          该连接数据发完
//                      {t:'err',  connId, message} 读文件出错
//     DO -> sender   : {t:'download', connId, offset}   请求从 offset 开始发数据
//                      {t:'abort', connId}               接收端断开，停止该流
//                      {t:'ping'}
//   二进制帧 = [4字节大端connId][数据chunk]，DO 剥掉前缀写入对应下载流

const HEARTBEAT_MS = 30_000;
const DEAD_MS = 60_000;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } });
    }

    if (url.pathname === '/health') return jsonResponse({ status: 'ok' });

    // 浏览器版发送页面
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(SENDER_PAGE_HTML, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // cf-send 注册
    if (url.pathname === '/register') {
      const id = url.searchParams.get('id') || '';
      if (!/^[\w-]+$/.test(id)) return jsonResponse({ error: 'bad channel id' }, 400);
      // 可选的服务密码：设置了 REGISTER_KEY 环境变量后，注册必须带上匹配的 rk 参数
      if (env.REGISTER_KEY) {
        const rk = url.searchParams.get('rk') || '';
        if (rk !== env.REGISTER_KEY) {
          return jsonResponse({ error: 'invalid register key' }, 403);
        }
      }
      const stub = env.RELAY_DO.get(env.RELAY_DO.idFromName(id));
      const doUrl = new URL(request.url);
      doUrl.pathname = '/register';
      return stub.fetch(new Request(doUrl, request));
    }

    // 下载：/d/<channelId>/<key>
    const m = url.pathname.match(/^\/d\/([\w-]+)\/([\w-]+)$/);
    if (m) {
      const stub = env.RELAY_DO.get(env.RELAY_DO.idFromName(m[1]));
      const doUrl = new URL(request.url);
      doUrl.pathname = '/download/' + m[2];
      doUrl.searchParams.set('originalPath', url.pathname);
      return stub.fetch(new Request(doUrl, request));
    }

    return jsonResponse({ error: 'not found' }, 404);
  },
};

export class RelayDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.senderWs = null;      // cf-send 的 WebSocket
    this.meta = null;          // { name, size, mime, key }
    this.downloads = new Map(); // connId -> { writer, closed }
    this.heartbeatTimer = null;
    this.lastPong = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/register') return this.handleRegister(request);
    if (url.pathname.startsWith('/download/')) return this.handleDownload(request, url.pathname.slice('/download/'.length), url);

    return jsonResponse({ error: 'not found' }, 404);
  }

  // ---------- cf-send 注册 ----------

  handleRegister(request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return jsonResponse({ error: 'expected websocket' }, 400);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.binaryType = 'arraybuffer';

    // 踢掉旧连接，防止数据错发
    const hadOld = !!this.senderWs;
    if (this.senderWs) {
      try { this.senderWs.close(4003, 'Replaced by new connection'); } catch {}
      this.abortAllDownloads();
      this.senderWs = null;
      this.meta = null;
    }

    this.senderWs = server;
    this.lastPong = Date.now();
    this.registeredAt = Date.now();
    this.totalBytes = 0;
    console.log('sender registered', JSON.stringify({ channelId: this.channelId || null, replaced: hadOld }));
    this.startHeartbeat();

    server.addEventListener('message', (ev) => this.onSenderMessage(ev));
    server.addEventListener('close', () => this.onSenderClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  onSenderMessage(ev) {
    const ws = this.senderWs;
    if (!ws) return;

    if (typeof ev.data === 'string') {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === 'meta') {
        this.meta = { name: msg.name, size: msg.size, mime: msg.mime || 'application/octet-stream', key: msg.key };
      } else if (msg.t === 'pong') {
        this.lastPong = Date.now();
      } else if (msg.t === 'eof' || msg.t === 'err') {
        const dl = this.downloads.get(msg.connId);
        if (dl) {
          if (msg.t === 'err') {
            try { dl.writer.abort(new Error(msg.message || 'sender error')).catch(() => {}); } catch {}
          } else {
            try { dl.writer.close(); } catch {}
          }
          this.downloads.delete(msg.connId);
        }
      }
      return;
    }

    // 二进制数据帧：[4字节connId][chunk]
    const buf = new Uint8Array(ev.data);
    if (buf.length < 4) return;
    const connId = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
    const dl = this.downloads.get(connId);
    if (!dl || dl.closed) return;
    try {
      dl.writer.write(buf.slice(4));
    } catch {
      // 写入失败 = 接收端已断开：清理并通知 sender 停流
      this.downloads.delete(connId);
      try { ws.send(JSON.stringify({ t: 'abort', connId })); } catch {}
    }
  }

  onSenderClose(ws) {
    if (ws !== this.senderWs) return; // 已被新连接替换
    console.log('sender ws closed', JSON.stringify({
      channelId: this.channelId || null,
      activeDownloads: this.downloads.size,
      uptimeMs: this.registeredAt ? Date.now() - this.registeredAt : null,
    }));
    this.senderWs = null;
    this.meta = null;
    this.stopHeartbeat();
    this.abortAllDownloads();
  }

  abortAllDownloads() {
    for (const [connId, dl] of this.downloads) {
      try { dl.writer.abort(new Error('sender disconnected')).catch(() => {}); } catch {}
      this.downloads.delete(connId);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.senderWs) return this.stopHeartbeat();
      if (Date.now() - this.lastPong > DEAD_MS) {
        try { this.senderWs.close(4001, 'heartbeat timeout'); } catch {}
        this.onSenderClose(this.senderWs);
        return;
      }
      try { this.senderWs.send(JSON.stringify({ t: 'ping' })); } catch {}
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  // ---------- 下载 ----------

  async handleDownload(request, key, url) {
    const cors = {
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
    };

    // sender 没注册（或还没上报 meta）-> 404
    if (!this.senderWs || !this.meta) {
      return new Response('Not Found: sender is offline', { status: 404, headers: cors });
    }
    if (key !== this.meta.key) {
      return new Response('Forbidden', { status: 403, headers: cors });
    }

    const meta = this.meta;

    // 解析 Range: bytes=N- / bytes=N-M
    let start = 0, end = meta.size - 1, isRange = false;
    const rangeHeader = request.headers.get('range');
    if (rangeHeader) {
      const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!m || (!m[1] && !m[2])) {
        return new Response('Invalid Range', { status: 416, headers: cors });
      }
      if (m[1] === '') {
        // suffix range: bytes=-N，取文件末尾 N 字节
        const n = parseInt(m[2], 10);
        if (n === 0) return new Response(null, { status: 416, headers: { ...cors, 'content-range': `bytes */${meta.size}` } });
        start = Math.max(0, meta.size - n);
        end = meta.size - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] === '' ? meta.size - 1 : Math.min(parseInt(m[2], 10), meta.size - 1);
      }
      if (start >= meta.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { ...cors, 'content-range': `bytes */${meta.size}` },
        });
      }
      isRange = true;
    }

    const headers = {
      ...cors,
      'content-type': meta.mime,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'content-length': String(end - start + 1),
    };
    if (isRange) {
      headers['content-range'] = `bytes ${start}-${end}/${meta.size}`;
    }

    if (request.method === 'HEAD') {
      return new Response(null, { status: isRange ? 206 : 200, headers });
    }
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }

    const status = isRange ? 206 : 200;

    // 空文件或零长度区间：直接空响应
    if (end < start) return new Response(null, { status, headers });

    // 通知 sender 从 start 开始发数据，流式桥接
    let connId = Math.floor(Math.random() * 0xffffffff) >>> 0;
    while (this.downloads.has(connId)) connId = (connId + 1) >>> 0;

    const { readable, writable } = new FixedLengthStream(end - start + 1);
    const writer = writable.getWriter();
    this.downloads.set(connId, { writer, closed: false });

    // 发送下载请求（带结束边界，sender 只发 [start, end] 区间）
    try {
      this.senderWs.send(JSON.stringify({ t: 'download', connId, offset: start, end }));
    } catch (e) {
      this.downloads.delete(connId);
      return new Response('sender unavailable', { status: 502, headers: cors });
    }

    // 接收端断开时通知 sender 停流
    request.signal.addEventListener('abort', () => {
      const dl = this.downloads.get(connId);
      if (dl) {
        dl.closed = true;
        this.downloads.delete(connId);
        try { writer.abort().catch(() => {}); } catch {}
        try { this.senderWs?.send(JSON.stringify({ t: 'abort', connId })); } catch {}
      }
    });

    return new Response(readable, { status, headers });
  }
}

// ---------------------------------------------------------------------------
// 浏览器版发送页面（单文件 HTML，无外部依赖；每个文件一条独立 WS 通道）
// ---------------------------------------------------------------------------

const SENDER_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cf-Copy 发送端</title>
<style>
  :root { --accent: #f6821f; --ok: #2e9e5b; --err: #d64545; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f4f5f7; margin: 0; padding: 24px 16px 60px; color: #222; }
  .wrap { max-width: 780px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 18px; }
  .panel { background: #fff; border: 1px solid #e2e4e8; border-radius: 10px; padding: 16px; margin-bottom: 14px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  input[type=password] { flex: 1; min-width: 200px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; }
  label.chk { font-size: 13px; color: #555; display: flex; align-items: center; gap: 4px; }
  #drop { border: 2px dashed #bbb; border-radius: 10px; padding: 28px; text-align: center;
          color: #888; cursor: pointer; transition: all .15s; }
  #drop.on { border-color: var(--accent); color: var(--accent); background: #fff8f2; }
  .card { background: #fff; border: 1px solid #e2e4e8; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .card.dead { border-color: var(--err); }
  .chead { display: flex; align-items: center; gap: 8px; }
  .fname { font-weight: 600; word-break: break-all; }
  .fsize { color: #777; font-size: 12px; white-space: nowrap; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #eef0f3; color: #555; white-space: nowrap; }
  .badge.live { background: #e5f5ec; color: var(--ok); }
  .badge.off { background: #fdeaea; color: var(--err); }
  .urlrow { display: flex; gap: 6px; margin: 10px 0 6px; }
  .urlrow input { flex: 1; padding: 7px 9px; border: 1px solid #d8dadd; border-radius: 6px;
                  font-size: 13px; color: #0b63ce; min-width: 120px; }
  button { border: 1px solid #ccc; background: #fff; border-radius: 6px; padding: 7px 12px;
           cursor: pointer; font-size: 13px; }
  button:hover { background: #f0f1f3; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { background: #d9731a; }
  button.danger { color: var(--err); border-color: #e6bcbc; }
  .conn { margin-top: 8px; font-size: 13px; }
  .conn .line { display: flex; justify-content: space-between; color: #555; margin-bottom: 2px; }
  .bar { height: 8px; background: #eceef1; border-radius: 4px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .2s; }
  .conn.done .bar i { background: var(--ok); }
  .conn.cancel .bar i { background: #999; }
  .stats { margin-top: 8px; font-size: 12px; color: #777; }
  .warn { background: #fff8e6; border: 1px solid #f0dfae; color: #7a5b00; border-radius: 8px;
          padding: 10px 12px; font-size: 13px; margin-bottom: 14px; }
  .msg { color: var(--err); font-size: 13px; min-height: 18px; margin-top: 6px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Cf-Copy 文件发送</h1>
  <div class="sub">选择文件后生成下载链接发给对方。对方可用浏览器或任意下载工具（支持断点续传）接收。</div>

  <div class="warn">⚠️ 发送期间请<b>保持本页面打开</b>：关闭或刷新页面，所有下载链接立即失效。</div>

  <div class="panel">
    <div class="row">
      <input type="password" id="rk" placeholder="注册密码（向服务提供者索要）">
      <label class="chk"><input type="checkbox" id="remember" checked>记住</label>
    </div>
  </div>

  <div class="panel">
    <div id="drop">点击选择文件（可多选），或把文件拖到这里</div>
    <input type="file" id="picker" multiple style="display:none">
  </div>

  <div id="cards"></div>
  <div class="msg" id="msg"></div>
</div>

<script>
(function () {
  'use strict';
  var CHUNK = 256 * 1024;
  var BUF_LIMIT = 8 * 1024 * 1024;

  var drop = document.getElementById('drop');
  var picker = document.getElementById('picker');
  var rkInput = document.getElementById('rk');
  var remember = document.getElementById('remember');
  var cardsBox = document.getElementById('cards');
  var msg = document.getElementById('msg');

  rkInput.value = localStorage.getItem('cfcopy_rk') || '';

  function setMsg(s) { msg.textContent = s || ''; }

  function fmt(n) {
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(1) + ' ' + u[i];
  }
  function randHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  function waitBuffer(ws) {
    return new Promise(function (res) {
      var t = setInterval(function () {
        if (ws.readyState !== 1 || ws.bufferedAmount <= BUF_LIMIT / 2) { clearInterval(t); res(); }
      }, 50);
    });
  }

  drop.onclick = function () { picker.click(); };
  picker.onchange = function () {
    for (var i = 0; i < picker.files.length; i++) startFile(picker.files[i]);
    picker.value = '';
  };
  ['dragover', 'dragenter'].forEach(function (e) {
    drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.add('on'); });
  });
  ['dragleave', 'drop'].forEach(function (e) {
    drop.addEventListener(e, function (ev) { ev.preventDefault(); drop.classList.remove('on'); });
  });
  drop.addEventListener('drop', function (ev) {
    var fs = ev.dataTransfer && ev.dataTransfer.files;
    if (fs) for (var i = 0; i < fs.length; i++) startFile(fs[i]);
  });

  window.addEventListener('beforeunload', function (e) {
    if (cardsBox.children.length) { e.preventDefault(); e.returnValue = ''; }
  });

  function startFile(file) {
    if (remember.checked) localStorage.setItem('cfcopy_rk', rkInput.value.trim());

    var channelId = randHex(8);
    var dlKey = randHex(12);
    var dlUrl = location.origin + '/d/' + channelId + '/' + dlKey;

    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="chead"><span class="fname"></span><span class="fsize"></span>' +
      '<span class="badge">连接中…</span><span style="flex:1"></span>' +
      '<button class="danger" title="停止该文件的发送">移除</button></div>' +
      '<div class="urlrow"><input readonly><button class="primary">复制链接</button></div>' +
      '<div class="conns"></div><div class="stats"></div>';
    cardsBox.appendChild(card);

    card.querySelector('.fname').textContent = file.name;
    card.querySelector('.fsize').textContent = fmt(file.size);
    var urlInput = card.querySelector('.urlrow input');
    urlInput.value = '正在建立通道…';
    var badge = card.querySelector('.badge');
    var connsBox = card.querySelector('.conns');
    var statsEl = card.querySelector('.stats');
    var removeBtn = card.querySelector('button.danger');
    var copyBtn = card.querySelector('button.primary');

    var ch = { file: file, ws: null, conns: new Map(), totalSent: 0, dead: false };

    copyBtn.onclick = function () {
      urlInput.select();
      if (navigator.clipboard) navigator.clipboard.writeText(urlInput.value).then(function () {
        copyBtn.textContent = '已复制'; setTimeout(function () { copyBtn.textContent = '复制链接'; }, 1200);
      });
      else { document.execCommand('copy'); }
    };
    removeBtn.onclick = function () {
      ch.dead = true;
      try { ch.ws.close(1000); } catch (e) {}
      card.remove();
    };

    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host +
                '/register?id=' + channelId +
                (rkInput.value.trim() ? '&rk=' + encodeURIComponent(rkInput.value.trim()) : '');
    var ws = null;
    ch.connect = function () {
      badge.textContent = '连接中…';
      badge.className = 'badge';
      card.classList.remove('dead');
      var s = new WebSocket(wsUrl);
      ws = ch.ws = s;
      s.binaryType = 'arraybuffer';

      s.onopen = function () {
        ch.retries = 0;
        badge.textContent = '等待下载';
        badge.className = 'badge';
        urlInput.value = dlUrl;
        s.send(JSON.stringify({ t: 'meta', name: file.name, size: file.size,
          mime: file.type || 'application/octet-stream', key: dlKey }));
        renderStats();
      };
      s.onclose = function (ev) {
        if (ch.dead) return;
        // 意外断开：把进行中的连接标记取消，然后自动重连（URL 不变）
        ch.conns.forEach(function (c, id) { stopConnById(ch, id, '连接中断'); });
        ch.retries = (ch.retries || 0) + 1;
        var delay = Math.min(500 * ch.retries, 5000);
        badge.textContent = '重连中… (' + ch.retries + ')';
        badge.className = 'badge off';
        setTimeout(function () { if (!ch.dead) ch.connect(); }, delay);
      };
      s.onerror = function () { setMsg('通道连接出错，正在自动重连…（请确认注册密码正确）'); };
      s.onmessage = function (ev) {
        if (typeof ev.data !== 'string') return;
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'ping') { s.send(JSON.stringify({ t: 'pong' })); }
        else if (m.t === 'download') startStream(ch, m.connId, m.offset, (m.end != null ? m.end : ch.file.size - 1));
        else if (m.t === 'abort') stopConn(ch, m.connId, '已取消');
      };
    };
    ch.connect();

    function renderStats() {
      var w = ch.ws;
      var active = 0, sending = 0;
      ch.conns.forEach(function (c) { if (!c.stopped) active++; sending += c.sent; });
      badge.textContent = active ? (active + ' 人下载中') : '等待下载';
      badge.className = active ? 'badge live' : 'badge';
      statsEl.textContent = '累计发出 ' + fmt(ch.totalSent) +
        ' · 发送缓冲 ' + fmt(w && w.readyState === 1 ? w.bufferedAmount : 0);
    }
    var statsTimer = setInterval(renderStats, 500);
    removeBtn.addEventListener('click', function () { clearInterval(statsTimer); });

    async function startStream(c, connId, offset, end) {
      var w = c.ws;
      var row = document.createElement('div');
      row.className = 'conn';
      row.innerHTML = '<div class="line"><span></span><span></span></div><div class="bar"><i></i></div>';
      connsBox.appendChild(row);
      var label = row.querySelector('span');
      var right = row.querySelectorAll('span')[1];
      var barFill = row.querySelector('i');
      var st = { sent: 0, total: end - offset + 1, stopped: false, ele: row };
      c.conns.set(connId, st);
      label.textContent = '▶ #' + connId.toString(16) + ' 从 ' + fmt(offset) + ' 起';

      var pos = offset;
      try {
        while (pos <= end && !st.stopped && w.readyState === 1) {
          if (w.bufferedAmount > BUF_LIMIT) await waitBuffer(w);
          if (st.stopped || w.readyState !== 1) break;
          var slice = c.file.slice(pos, Math.min(pos + CHUNK, end + 1));
          var buf = await slice.arrayBuffer();
          var frame = new Uint8Array(4 + buf.byteLength);
          new DataView(frame.buffer).setUint32(0, connId);
          frame.set(new Uint8Array(buf), 4);
          w.send(frame);
          pos += buf.byteLength;
          st.sent += buf.byteLength;
          c.totalSent += buf.byteLength;
          var pct = Math.floor(st.sent * 100 / st.total);
          right.textContent = fmt(st.sent) + ' / ' + fmt(st.total) + '（剩 ' + fmt(st.total - st.sent) + '）';
          barFill.style.width = pct + '%';
        }
      } catch (e) {
        row.classList.add('cancel');
        c.conns.delete(connId);
        return;
      }
      if (st.stopped) return;
      c.conns.delete(connId);
      row.classList.add('done');
      barFill.style.width = '100%';
      right.textContent = '完成 ✔';
      w.send(JSON.stringify({ t: 'eof', connId: connId }));
    }

    function stopConn(c, connId, text) {
      var st = c.conns.get(connId);
      if (!st) return;
      st.stopped = true;
      c.conns.delete(connId);
      st.ele.classList.add('cancel');
      st.ele.querySelectorAll('span')[1].textContent = text;
    }
    function stopConnById(c, connId, text) { stopConn(c, connId, text); }
  }
})();
</script>
</body>
</html>`;

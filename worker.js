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
    this.downloads = new Map(); // connId -> { controller, writer, closed }
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
    if (this.senderWs) {
      try { this.senderWs.close(4003, 'Replaced by new connection'); } catch {}
      this.abortAllDownloads();
      this.senderWs = null;
      this.meta = null;
    }

    this.senderWs = server;
    this.lastPong = Date.now();
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
            try { dl.controller.error(new Error(msg.message || 'sender error')); } catch {}
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
    this.senderWs = null;
    this.meta = null;
    this.stopHeartbeat();
    this.abortAllDownloads();
  }

  abortAllDownloads() {
    for (const [connId, dl] of this.downloads) {
      try { dl.controller.error(new Error('sender disconnected')); } catch {}
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
    this.downloads.set(connId, { controller: writer, writer, closed: false });

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
        try { dl.writer.releaseLock(); writable.abort().catch(() => {}); } catch {}
        try { this.senderWs?.send(JSON.stringify({ t: 'abort', connId })); } catch {}
      }
    });

    return new Response(readable, { status, headers });
  }
}

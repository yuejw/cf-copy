#!/usr/bin/env node
// cf-send - CfCopy 发送端 CLI（零依赖，需 Node >= 22）
//
// 用法：
//   node send.mjs <文件路径>
//   node send.mjs                # Windows 下弹出文件选择对话框
//
// 环境变量：
//   CFCOPY_SERVER   Worker 地址，默认 https://cfcopy.<你的子域>.workers.dev
//                   （也可用 --server https://xxx.workers.dev 参数覆盖）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const CHUNK_SIZE = 256 * 1024;     // 单个 WS 二进制帧的数据量
const BUFFER_LIMIT = 8 * 1024 * 1024; // WS 发送缓冲上限，超过则暂停读取（背压）

// ---------- 参数解析 ----------

const args = process.argv.slice(2);
let server = process.env.CFCOPY_SERVER || '';
let registerKey = process.env.CFCOPY_KEY || '';
let filePath = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--server' && args[i + 1]) { server = args[++i]; }
  else if (args[i] === '--key' && args[i + 1]) { registerKey = args[++i]; }
  else filePath = args[i];
}

if (!server) {
  console.error('错误：未指定 Worker 地址。用 --server https://xxx.workers.dev 或环境变量 CFCOPY_SERVER。');
  process.exit(1);
}
server = server.replace(/\/+$/, '');

if (typeof WebSocket === 'undefined') {
  console.error('错误：当前 Node 没有全局 WebSocket，请使用 Node 22 及以上版本。');
  process.exit(1);
}

// ---------- 选择文件 ----------

if (!filePath && process.platform === 'win32') {
  filePath = pickFileWindows();
}
if (!filePath) {
  console.error('用法: node send.mjs <文件路径>');
  process.exit(1);
}

filePath = path.resolve(filePath);
let stat;
try {
  stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('不是普通文件');
} catch (e) {
  console.error(`错误：无法访问文件 ${filePath} (${e.message})`);
  process.exit(1);
}

function pickFileWindows() {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = '选择要发送的文件'
if ($dlg.ShowDialog() -eq 'OK') { Write-Output $dlg.FileName }
`;
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-STA', '-Command', script], { encoding: 'utf8' });
    return out.trim();
  } catch {
    return '';
  }
}

// ---------- 注册并等待下载 ----------

const channelId = crypto.randomBytes(8).toString('hex');      // 16 位通道 id
const key = crypto.randomBytes(12).toString('base64url');     // 下载密钥
const fileName = path.basename(filePath);
const size = stat.size;

const mime = guessMime(fileName);
const downloadUrl = `${server}/d/${channelId}/${key}`;

let url = `${server}/register?id=${channelId}`;
if (registerKey) url += `&rk=${encodeURIComponent(registerKey)}`;
console.log(`正在连接 ${server} ...`);

// 预检：先用普通 HTTP 请求探测，把服务端拒绝的具体原因打出来
// （WebSocket 的 error 事件不携带 HTTP 状态码，只能显示笼统的 1006）
try {
  const probe = await fetch(url);
  if (probe.status === 403) {
    console.error('❌ 注册被拒绝（403）：服务端开启了注册密码，请用 --key <密码> 提供正确的密码。');
    process.exit(1);
  }
  if (probe.status === 400) {
    const body = await probe.json().catch(() => ({}));
    if (body.error === 'bad channel id') {
      console.error('❌ 注册被拒绝（400）：通道 id 不合法。');
      process.exit(1);
    }
    // error === 'expected websocket' 是正常情况，继续走 WS 升级
  } else if (!probe.ok) {
    console.error(`❌ 服务端返回异常状态 ${probe.status}，无法注册。`);
    process.exit(1);
  }
} catch (e) {
  console.error(`❌ 无法连接服务器 ${server}：${e.message}`);
  console.error('   请检查 --server 地址是否正确、网络是否可达。');
  process.exit(1);
}

const ws = new WebSocket(url);
ws.binaryType = 'nodebuffer';

const streams = new Map(); // connId -> fs.ReadStream

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ t: 'meta', name: fileName, size, mime, key }));
  console.log('');
  console.log('  ✅ 通道已建立，等待接收方下载');
  console.log(`  📄 文件: ${fileName} (${formatSize(size)})`);
  console.log('');
  console.log(`  ⬇️  下载地址: ${downloadUrl}`);
  console.log('');
  console.log('  接收端示例（支持断点续传）:');
  console.log(`     curl -L -O -C - "${downloadUrl}"`);
  console.log('');
  console.log('  Ctrl+C 退出。发送端不在线时，下载地址返回 404。');
});

ws.addEventListener('message', (ev) => {
  if (typeof ev.data !== 'string') return; // 协议里 sender 不接收二进制帧

  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  if (msg.t === 'ping') {
    ws.send(JSON.stringify({ t: 'pong' }));
  } else if (msg.t === 'download') {
    startStream(msg.connId, msg.offset, msg.end ?? size - 1);
  } else if (msg.t === 'abort') {
    const s = streams.get(msg.connId);
    if (s) { streams.delete(msg.connId); s.destroy(); console.log(`  ↩️  连接 #${msg.connId} 已取消`); }
  }
});

ws.addEventListener('close', (ev) => {
  for (const s of streams.values()) s.destroy();
  streams.clear();
  let hint = '';
  if (ev.code === 1006 && registerKey) hint = '（注意：服务器可能开启了 REGISTER_KEY 且 key 不匹配）';
  console.error(`\n与服务器的连接已断开 (code=${ev.code}${ev.reason ? ', ' + ev.reason : ''})${hint}，退出。`);
  process.exit(1);
});

ws.addEventListener('error', () => {
  console.error('连接出错（详情见上方报错）');
});

process.on('SIGINT', () => {
  console.log('\n退出，关闭通道。');
  try { ws.close(1000); } catch {}
  for (const s of streams.values()) s.destroy();
  process.exit(0);
});

// ---------- 数据流 ----------

function startStream(connId, offset, end) {
  console.log(`  ▶️  连接 #${connId} 开始下载，从字节 ${offset} 到 ${end}`);
  const stream = fs.createReadStream(filePath, { start: offset, end });
  streams.set(connId, stream);

  let sent = 0;
  let resumeTimer = null;
  stream.on('data', (chunk) => {
    // 末尾对齐 end（Range 区间）
    let buf = chunk;
    const remaining = (end - offset + 1) - sent;
    if (buf.length > remaining) buf = buf.subarray(0, remaining);
    sent += buf.length;

    const frame = Buffer.allocUnsafe(4 + buf.length);
    frame.writeUInt32BE(connId, 0);
    buf.copy(frame, 4);
    ws.send(frame);

    // 背压：缓冲积压时暂停读文件，缓冲消化后恢复
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > BUFFER_LIMIT && !resumeTimer) {
      stream.pause();
      resumeTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount <= BUFFER_LIMIT / 2) {
          clearInterval(resumeTimer);
          resumeTimer = null;
          if (ws.readyState === WebSocket.OPEN) stream.resume();
        }
      }, 50);
    }
  });

  stream.on('close', () => {
    if (resumeTimer) { clearInterval(resumeTimer); resumeTimer = null; }
    // WS 按序送达，eof 一定在所有数据帧之后到达 DO
    if (streams.get(connId) === stream) {
      streams.delete(connId);
      ws.send(JSON.stringify({ t: 'eof', connId }));
      console.log(`  ✔️  连接 #${connId} 完成，本次发送 ${formatSize(sent)}`);
    }
  });

  stream.on('error', (err) => {
    streams.delete(connId);
    ws.send(JSON.stringify({ t: 'err', connId, message: err.message }));
    console.error(`  ❌ 连接 #${connId} 读文件出错: ${err.message}`);
  });
}

// ---------- 工具 ----------

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(1)} ${units[i]}`;
}

function guessMime(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
    '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg',
    '.txt': 'text/plain', '.json': 'application/json', '.iso': 'application/x-iso9660-image',
    '.exe': 'application/x-msdownload', '.msi': 'application/x-msi',
  };
  return map[ext] || 'application/octet-stream';
}

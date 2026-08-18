# CfCopy

基于 Cloudflare Worker + Durable Object 的大文件中继服务，帮助**无法直连的两台机器**复制文件：
一端运行 `cf-send`（发送方），另一端用浏览器 / curl / wget / IDM 等任意 HTTP 工具下载（接收方）。

- 🕳️ 穿透 NAT / 无公网 IP：数据经 Cloudflare 中继，发送端只需能访问外网
- ⏸️ **断点续传**：标准 HTTP `Range` 支持，下载工具的续传功能开箱即用
- 💤 发送端在线才可下载；`cf-send` 未运行时下载地址返回 **404**
- 🔗 下载地址带随机密钥，难以被猜到
- 💰 免费计划即可运行（数据流式转发，不占 Worker 请求时长）

## 架构

```
cf-send (Node.js CLI)                         浏览器 / curl / wget / IDM
      │ wss 长连接（注册 + 数据上行）                 │ https GET（支持 Range）
      ▼                                             ▼
   ┌────────────── Cloudflare Worker + Durable Object ──────────────┐
   │  RelayDO(idFromName(channelId))：管理 sender 连接、桥接下载流   │
   └─────────────────────────────────────────────────────────────────┘
```

发送端不主动推数据：只有当有人访问下载 URL 时，DO 才通知 `cf-send` 从指定偏移开始读文件并流式回传。

## 部署

需要 Node ≥ 18。任选下面**一种**方式安装 wrangler。

> **背景知识**：`npm install -g` 装到系统全局目录并加入 PATH，任何位置都能直接用 `wrangler` 命令；不带 `-g` 则装进**执行命令时所在目录**的 `node_modules`，不进 PATH，要用 `npx wrangler ...` 调用。两种方式都必须先在**对应目录**执行一次 `npm install`，再放行安装脚本。
>
> **关于 allow-scripts**：esbuild 和 workerd 两个包在安装时要执行 postinstall 脚本下载平台二进制，部分 npm 配置会拦截它（安装时会看到 `npm warn allow-scripts ...` 警告）。被拦截时 wrangler 无法打包部署（报 esbuild 相关错误），因此安装命令里直接带上 `--allow-scripts=esbuild,workerd` 一步到位放行。无论全局还是项目目录安装，都需要这一步。

### 方式 A：全局安装（推荐，最省心）

```bash
npm install -g --allow-scripts=esbuild,workerd wrangler
wrangler login                        # 打开浏览器登录 Cloudflare 账号
```

之后在任何目录都可以直接使用 `wrangler` 命令。

### 方式 B：安装到项目目录

```bash
cd Cfcopy                              # 先进入本项目目录，避免污染其他目录
npm install --save-dev --allow-scripts=esbuild,workerd wrangler
npx wrangler login
```

此方式下所有 wrangler 命令都要通过 `npx` 调用（npx 会自动找到 `node_modules` 里的 wrangler）。

> ⚠️ 注意 `npm install`（不带 `-g`）装到的是**当前目录**。如果在家目录（如 `C:\Users\你`）执行，会在那里生成 `node_modules`、`package.json` 等垃圾文件——发现装错位置时删掉这三个即可：`node_modules/`、`package.json`、`package-lock.json`。

### 部署

1. 修改 `wrangler.toml` 里的 `name = "cfcopy"`（可选，默认即可）。
2. 部署：
   ```bash
   wrangler deploy        # 方式 A
   npx wrangler deploy    # 方式 B
   ```
   记下输出的 `https://cfcopy.<你的子域>.workers.dev`。

### ⚠️ 国内用户必读：workers.dev 域名存在 DNS 污染

默认的 `*.workers.dev` 域名在国内网络环境下**普遍存在 DNS 污染**：域名会被解析到错误的 IP，导致 `wrangler deploy` 能成功（走的是 API 域名），但发送端连接、浏览器访问全部超时，WebSocket 直接异常关闭（code=1006）。

解决办法是申请一个自己的域名并托管到 Cloudflare，然后通过 `routes` 给 Worker 绑定自定义域名：

1. 在 Cloudflare 控制台添加你的域名（免费计划即可），按提示把域名 NS 记录改到 Cloudflare；
2. 在 `wrangler.toml` 中添加 `routes` 配置（本项目已自带示例，替换成你自己的域名）：
   ```toml
   routes = [
     { pattern = "copy.你的域名.com", custom_domain = true }
   ]
   ```
   例如本项目的实际配置是 `copy.yuejw.ccwu.cc`。部署时 Cloudflare 会自动创建 DNS 记录并签发证书；
3. 重新 `wrangler deploy`，之后所有地址都用 `https://copy.你的域名.com` 代替 `https://cfcopy.xxx.workers.dev`。

验证：访问 `https://copy.你的域名.com/health`，返回 `{"status":"ok"}` 即部署成功。

## 使用

### 发送端（Node ≥ 22，零依赖）

```bash
# 方式一：直接指定文件
node send.mjs big-file.zip --server https://cfcopy.xxx.workers.dev

# 方式二：Windows 下不带参数，弹出文件选择对话框
node send.mjs --server https://cfcopy.xxx.workers.dev
```

也可以用环境变量代替 `--server`：

```bash
export CFCOPY_SERVER=https://cfcopy.xxx.workers.dev
node send.mjs big-file.zip
```

运行后会打印下载地址：

```
✅ 通道已建立，等待接收方下载
📄 文件: big-file.zip (1.2 GB)

⬇️  下载地址: https://cfcopy.xxx.workers.dev/d/ab12cd34/xxxxx

接收端示例（支持断点续传）:
   curl -L -O -C - "https://cfcopy.xxx.workers.dev/d/ab12cd34/xxxxx"
```

### 接收端

任意支持 HTTP 下载的工具均可：

```bash
# curl（-C - 表示断点续传）
curl -L -O -C - "https://.../d/<id>/<key>"

# wget（自动续传）
wget -c "https://.../d/<id>/<key>"

# 浏览器直接打开地址即可下载
```

- `cf-send` 未运行 / 已退出 → 地址返回 404
- 支持多人同时下载、分段并行下载（每连接独立偏移读取）
- 下载中接收端可随时中断，重连后从断点继续

## 文件说明

| 文件 | 说明 |
|---|---|
| `worker.js` | Worker 入口 + `RelayDO`（Durable Object），通道管理与流桥接 |
| `wrangler.toml` | 部署配置（DO 绑定、SQLite 迁移） |
| `send.mjs` | `cf-send` 发送端 CLI |

## 注意事项

- 免费计划 Worker 请求数有每日限额（10 万次/天），但单个下载是一条长流，计为一次请求，正常使用远达不到上限。
- 单文件大小无硬性限制（流式转发，不整载内存）；建议接收端使用支持续传的工具，网络闪断可自动恢复。
- 通道密钥仅存在于 URL 中，请通过安全渠道（如自己另建的加密聊天）发给接收方。

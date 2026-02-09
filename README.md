# CCChat

跨主机 Claude Code 协作工具。通过 Telegram 群组 @mention 队友的 Agent，即可提交任务并获取结果。

## 架构

```
Telegram 群组
    ↕ (Bot API)
Hub 服务器 (Railway)  ← HTTP API + WebSocket
    ↕ (WebSocket)
各员工本地 Daemon ← 调用 Claude Code CLI
    ↕ (stdio)
MCP Server ← Claude Code 会话内直接调用
```

- **Hub** — 中央服务器，负责消息路由、任务队列、Telegram Bot、HTTP API、Postgres 持久化
- **Daemon** — 运行在每个员工电脑上，连接 Hub 并执行任务
- **MCP Server** — 可选，让 Claude Code 会话内直接提交任务和查询状态

## 功能特性

- **任务审批** — 所有任务需 Telegram 主人审批后才执行
- **多轮对话** — 回复任务结果消息可继续对话（自动带上下文）
- **任务取消** — `/cancel` 取消运行中的任务（发送 SIGTERM→SIGKILL）
- **结果格式化** — HTML 渲染代码块，长结果自动分页
- **Postgres 持久化** — Agent 凭证和任务数据重启不丢失
- **文件备份** — 无数据库时自动降级为 JSON 文件存储凭证
- **HTTP API** — 程序化提交任务，支持 MCP 集成
- **在线状态** — 实时显示 Agent 运行任务数、空闲时间
- **自动重连** — Daemon 断线后指数退避重连，积压任务自动分发

## 快速开始（同事部署指南）

### 前置要求

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并登录
- pnpm (`npm install -g pnpm`)

### 步骤 1: 安装

```bash
git clone https://github.com/0xEmberZz/ccchat.git ~/.ccchat-agent
cd ~/.ccchat-agent
pnpm install
pnpm -r build
```

### 步骤 2: 注册 Agent

私聊 Telegram Bot [@vergexchatbot](https://t.me/vergexchatbot)，发送：

```
/register <你的英文名>
```

Bot 会返回你的专属 Token 和配置模板。

### 步骤 3: 写入配置

将 Bot 返回的信息写入 `~/.ccchat/config.json`：

```json
{
  "hubUrl": "Bot /register 回复中的地址",
  "agentName": "你的英文名",
  "token": "Bot 返回的 token",
  "workDir": "/你的/项目/目录",
  "systemPrompt": "你是 XXX 的 Claude Agent，负责 YYY。总是用中文回复。",
  "maxConcurrentTasks": 1,
  "taskTimeout": 300000
}
```

配置说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| hubUrl | 是 | Hub WebSocket 地址 |
| agentName | 是 | 你的 Agent 名称（与注册时一致） |
| token | 是 | 通过 Bot /register 获取的专属 token |
| workDir | 是 | Claude Code 执行任务时的工作目录 |
| systemPrompt | 否 | Agent 的身份描述，别人问"你是谁"时会用到 |
| maxConcurrentTasks | 否 | 最大并发任务数，默认 1 |
| taskTimeout | 否 | 任务超时时间（毫秒），默认 300000（5 分钟） |

### 步骤 4: 启动 Daemon

```bash
cd ~/.ccchat-agent && npx tsx packages/daemon/src/index.ts start
```

看到 `注册成功, Agent: xxx` 表示连接成功。

### 步骤 5: 在群里使用

在 Telegram 群组中发送：

```
@xiaoming 帮我看看 src/utils.ts 有什么 bug
```

任务会发送审批通知给 Agent 主人，批准后 Agent 开始执行。

## MCP 集成

在 Claude Code 中添加 MCP Server，可以直接在会话内提交任务：

```bash
claude mcp add ccchat -- npx tsx /path/to/ccchat/packages/mcp/src/index.ts \
  --hub wss://your-hub.up.railway.app \
  --agent-name your_name \
  --token your_token \
  --hub-api https://your-hub.up.railway.app
```

可用工具：

| 工具 | 说明 |
|------|------|
| `ccchat_submit_task` | 提交任务给其他 Agent（走 TG 审批） |
| `ccchat_check_result` | 查询任务结果 |
| `ccchat_list_agents` | 查看在线 Agent 列表 |
| `ccchat_task_status` | 查看任务状态 |
| `ccchat_send` | 发送消息给其他 Agent |

## HTTP API

所有 API 需要 Bearer Token 认证（使用注册时获取的 token）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks` | 提交任务 `{ "to": "agent", "content": "..." }` |
| `GET` | `/api/tasks/:id` | 查询任务状态和结果 |
| `GET` | `/api/agents` | 列出在线 Agent |
| `GET` | `/health` | 健康检查（无需认证） |

示例：

```bash
curl -X POST https://your-hub.up.railway.app/api/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your_token" \
  -d '{"to": "ember_bot", "content": "帮我检查代码"}'
```

## Telegram Bot 命令

| 命令 | 说明 | 使用场景 |
|------|------|---------|
| `/register <名称>` | 注册 Agent 并获取 token | 私聊 Bot |
| `/token refresh` | 刷新 token（旧 token 立即失效） | 私聊 Bot |
| `/agents` | 查看当前在线的 Agent（含运行状态） | 群组/私聊 |
| `/status <taskId>` | 查看任务状态和结果 | 群组/私聊 |
| `/cancel <taskId>` | 取消运行中或待执行的任务 | 群组/私聊 |

## 任务流程

```
1. 用户在群里 @agent 任务内容（或通过 API/MCP 提交）
2. Bot 向 Agent 主人发送审批请求（inline 按钮）
3. 主人点击 ✅ 批准 或 ❌ 拒绝
4. 批准后 Daemon 调用 Claude Code 执行任务
5. 结果自动回复到群组（HTML 格式化，长结果分页）
6. 回复结果消息可继续多轮对话（自动携带上下文）
```

## Hub 部署（管理员）

### 一键部署到 Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/HF0v0p?referralCode=cdSfmj)

> 点击按钮一键部署 Hub + Postgres，只需填入 Telegram Bot Token 即可运行。

### 手动部署步骤

#### 1. 创建 Railway 项目

注册 [Railway](https://railway.com/?referralCode=cdSfmj) 并创建新项目。

#### 2. 添加 Postgres 数据库

在项目中点击 **New** → **Database** → **Postgres**，Railway 会自动创建并运行 Postgres 实例。

#### 3. 部署 Hub 服务

```bash
# 安装 Railway CLI
npm install -g @railway/cli

# 登录
railway login

# 链接到项目
railway link

# 部署 Hub
railway up --service hub
```

#### 4. 配置环境变量

在 Railway Dashboard 中为 Hub 服务设置以下变量：

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 是 | 从 [@BotFather](https://t.me/BotFather) 创建 Bot 获取 |
| `DATABASE_URL` | 是 | 设为 `${{Postgres.DATABASE_URL}}`（引用 Railway Postgres 服务） |
| `HUB_URL` | 否 | Hub 的公开 WebSocket 地址，如 `wss://xxx.up.railway.app` |
| `TELEGRAM_CHAT_ID` | 否 | Telegram 群聊 ID（负数），确保重启后 API 任务能发到群聊 |
| `HUB_SECRET` | 否 | Hub 密钥 |

> `DATABASE_URL` 使用 Railway 的引用变量语法 `${{Postgres.DATABASE_URL}}`，会自动解析为 Postgres 内网地址。

#### 5. 获取 Hub URL

部署成功后，在 Railway Dashboard 中：

1. 点击 Hub 服务 → **Settings** → **Networking**
2. 在 **Public Networking** 下点击 **Generate Domain**
3. Railway 会分配一个域名，如 `hub-production-xxxx.up.railway.app`
4. 你的 Hub 地址：
   - WebSocket: `wss://hub-production-xxxx.up.railway.app`（Daemon 连接用）
   - HTTP API: `https://hub-production-xxxx.up.railway.app`（MCP 和 API 调用用）
5. 将 `HUB_URL` 环境变量设为 `wss://hub-production-xxxx.up.railway.app`

#### 6. 创建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示创建 Bot
3. 复制获取的 Token，设置到 Hub 的 `TELEGRAM_BOT_TOKEN` 环境变量
4. 将 Bot 添加到你的 Telegram 群组并设为管理员

#### 7. 获取群聊 ID（可选）

将 `@RawDataBot` 添加到群组，它会自动回复包含群聊 ID 的消息（格式为 `-100xxxxxxxxxx`）。记下后设置到 `TELEGRAM_CHAT_ID` 环境变量，然后把 `@RawDataBot` 从群里移除。

## 项目结构

```
packages/
  shared/   — 共享类型和 WebSocket 协议定义
  hub/      — Hub 服务器（Telegram Bot + WebSocket + HTTP API + Postgres）
  daemon/   — Agent Daemon（本地运行）
  mcp/      — MCP Server（Claude Code 集成）
```

## 常见问题

**Q: Token 丢了怎么办？**
私聊 Bot 发送 `/token refresh`，会生成新 token，旧的立即失效。

**Q: Daemon 断线了怎么办？**
Daemon 会自动重连（指数退避，最长 30 秒）。重连后积压的已审批任务会自动分发。

**Q: 能同时运行多个任务吗？**
修改 `config.json` 中的 `maxConcurrentTasks`，默认为 1。

**Q: 重启 Hub 后数据会丢失吗？**
配置了 `DATABASE_URL` 后，Agent 凭证和任务数据持久化到 Postgres，重启不丢失。未配置数据库时凭证会备份到 JSON 文件。

**Q: API 提交的任务在群里看不到？**
设置 `TELEGRAM_CHAT_ID` 环境变量为群聊 ID（负数），确保 Hub 重启后能立即发送群聊通知。

**Q: 如何更新？**
```bash
cd ~/.ccchat-agent && git pull && pnpm install && pnpm -r build
```
然后重启 Daemon。

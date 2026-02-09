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

私聊你团队部署的 Telegram Bot，发送：

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
  -d '{"to": "agent_name", "content": "帮我检查代码"}'
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

模板已包含 **Hub 服务 + Postgres 数据库**，`DATABASE_URL` 已自动配置。部署只需 3 步：

#### 1. 创建 Telegram Bot

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)，发送 `/newbot`
2. 按提示设置 Bot 名称和用户名
3. 复制获取的 Token（格式如 `123456:ABC-DEF...`）

#### 2. 点击上方按钮部署

1. 点击 **Deploy on Railway** 按钮
2. 在部署页面填入 `TELEGRAM_BOT_TOKEN`（步骤 1 获取的 Token）
3. 点击 **Deploy**，等待部署完成

#### 3. 获取 Hub URL

部署成功后，在 Railway Dashboard 中：

1. 点击 Hub 服务 → **Settings** → **Networking**
2. 在 **Public Networking** 下点击 **Generate Domain**
3. Railway 会分配一个域名，如 `hub-xxxx.up.railway.app`
4. 你的 Hub 地址：
   - **WebSocket**: `wss://hub-xxxx.up.railway.app`（Daemon 连接用）
   - **HTTP API**: `https://hub-xxxx.up.railway.app`（MCP 和 API 调用用）
5. 回到 Hub 服务的 **Variables**，添加 `HUB_URL=wss://hub-xxxx.up.railway.app`

#### 4. 配置 Telegram 群组

1. 将 Bot 添加到你的 Telegram 群组并设为**管理员**
2. （可选）获取群聊 ID：将 `@RawDataBot` 加入群组，记下回复中的 ID（格式 `-100xxxxxxxxxx`），然后移除它
3. （可选）在 Hub 的 Variables 中添加 `TELEGRAM_CHAT_ID=你的群聊ID`

### 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 是 | Telegram Bot Token（从 @BotFather 获取） |
| `DATABASE_URL` | 自动 | 模板已自动配置，引用 Postgres 服务 |
| `HUB_URL` | 推荐 | Hub 的 WebSocket 地址（显示在 /register 回复中） |
| `TELEGRAM_CHAT_ID` | 可选 | 群聊 ID，确保重启后 API 任务能发到群聊 |
| `HUB_SECRET` | 可选 | Hub 密钥 |

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

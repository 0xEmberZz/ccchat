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

| 组件 | 说明 |
|------|------|
| **Hub** | 中央服务器：Telegram Bot + WebSocket + HTTP API + Postgres |
| **Daemon** | 本地运行，连接 Hub 并调用 Claude Code 执行任务 |
| **MCP Server** | 可选，让 Claude Code 会话内直接提交任务 |

## 功能

- 自动审批（主人自己的任务跳过审批）/ 其他人需主人审批
- 实时进度显示（思考 → 工具调用 → 生成回复）
- 多轮对话（回复结果消息即可继续）
- 图片/文件支持（caption 中 @agent，5MB 限制）
- 历史查询、任务取消、结果自动分页
- Postgres 持久化 / 无 DB 时降级 JSON 备份
- Daemon 断线自动重连（指数退避）

## 部署 Hub（管理员）

### 一键部署

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/HF0v0p?referralCode=cdSfmj)

模板已包含 Hub + Postgres，`DATABASE_URL` 自动配置。

**1. 创建 Telegram Bot**

搜索 [@BotFather](https://t.me/BotFather) → `/newbot` → 获取 Token。

**2. 部署**

点击上方按钮 → 填入 `TELEGRAM_BOT_TOKEN` → Deploy。

**3. 获取 Hub URL**

Railway Dashboard → Hub 服务 → Settings → Networking → Generate Domain → 得到 `hub-xxxx.up.railway.app`。

在 Variables 中添加 `HUB_URL=wss://hub-xxxx.up.railway.app`。

**4. 配置群组**

将 Bot 添加到群组并设为管理员。

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `TELEGRAM_BOT_TOKEN` | 是 | 从 @BotFather 获取 |
| `DATABASE_URL` | 自动 | 模板已配置 |
| `HUB_URL` | 推荐 | WebSocket 地址，显示在 /register 回复中 |
| `TELEGRAM_CHAT_ID` | 可选 | 群聊 ID，确保重启后 API 任务能发到群聊 |

## 加入团队（Daemon 部署）

### 前置要求

- Node.js >= 20、pnpm、[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 安装

```bash
git clone https://github.com/0xEmberZz/ccchat.git ~/.ccchat-agent
cd ~/.ccchat-agent && pnpm install && pnpm -r build
```

### 注册

私聊 Telegram Bot 发送 `/register <你的英文名>`，获取 Token。

### 配置

将信息写入 `~/.ccchat/config.json`：

```json
{
  "hubUrl": "wss://hub-xxxx.up.railway.app",
  "agentName": "你的英文名",
  "token": "Bot 返回的 token",
  "workDir": "/你的/项目/目录",
  "systemPrompt": "你是一个 Claude Agent，用中文回复。",
  "maxConcurrentTasks": 1,
  "taskTimeout": 300000
}
```

`systemPrompt`、`maxConcurrentTasks`、`taskTimeout` 均为可选。

### 启动

```bash
cd ~/.ccchat-agent && npx tsx packages/daemon/src/index.ts start
```

看到 `注册成功, Agent: xxx` 即为成功。后台运行：

```bash
nohup npx tsx packages/daemon/src/index.ts start > ~/.ccchat/daemon.log 2>&1 &
```

### 使用

群组中发送 `@agent名 任务内容` 即可。发图片/文件时在 caption 中 @agent。

## Bot 命令

| 命令 | 说明 |
|------|------|
| `/register <名称>` | 注册 Agent 并获取 token（私聊） |
| `/token refresh` | 刷新 token |
| `/agents` | 查看在线 Agent |
| `/status <taskId>` | 查看任务状态 |
| `/cancel <taskId>` | 取消任务 |
| `/history [agent] [数量]` | 查看最近任务（默认 10，最多 20） |

## MCP 集成

```bash
claude mcp add ccchat -- npx tsx /path/to/ccchat/packages/mcp/src/index.ts \
  --hub wss://your-hub.up.railway.app \
  --agent-name your_name \
  --token your_token \
  --hub-api https://your-hub.up.railway.app
```

工具：`ccchat_submit_task`、`ccchat_check_result`、`ccchat_list_agents`、`ccchat_task_status`、`ccchat_send`

## HTTP API

Bearer Token 认证。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/tasks` | 提交任务 `{ "to": "agent", "content": "..." }` |
| `GET` | `/api/tasks/:id` | 查询任务状态 |
| `GET` | `/api/agents` | 列出在线 Agent |
| `GET` | `/health` | 健康检查（无需认证） |

## 常见问题

| 问题 | 解决 |
|------|------|
| Token 丢了 | 私聊 Bot `/token refresh` |
| Daemon 反复断线 | `ps aux \| grep daemon` 检查多余进程并 kill |
| Bot 不响应群消息 | 确认 Bot 是群管理员，`HUB_URL` 是否正确 |
| 任务超时 | 调大 `config.json` 中的 `taskTimeout` |
| 更新版本 | `cd ~/.ccchat-agent && git pull && pnpm install && pnpm -r build` |

## 项目结构

```
packages/
  shared/   — 共享类型和 WebSocket 协议定义
  hub/      — Hub 服务器
  daemon/   — Agent Daemon
  mcp/      — MCP Server
```

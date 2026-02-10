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

- **自动审批** — Agent 主人自己 @mention 自己的 Agent 时，跳过审批直接执行
- **任务审批** — 非主人提交的任务需 Telegram 主人审批后才执行
- **实时进度** — 任务执行过程中实时显示状态（💭 思考中 → 🔧 使用工具 → ✍️ 生成回复）
- **多轮对话** — 回复任务结果消息可继续对话（自动带上下文）
- **图片/文件支持** — 发送图片或文件并 @agent，附件自动传递给 Claude Code
- **历史查询** — `/history` 查看最近任务记录，支持按 Agent 过滤
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
| `/history [agent] [数量]` | 查看最近任务记录（默认 10 条，最多 20） | 群组/私聊 |

## 任务流程

```
1. 用户在群里 @agent 任务内容（支持文字、图片、文件）
2a. 如果是 Agent 主人自己发的 → 自动批准，直接执行
2b. 如果是其他人发的 → Bot 向 Agent 主人发送审批请求（inline 按钮）
3. 主人点击 ✅ 批准 或 ❌ 拒绝
4. 批准后 Daemon 调用 Claude Code 执行任务
5. 执行过程中实时显示进度（💭 思考中 / 🔧 工具调用 / ✍️ 生成回复）
6. 结果自动回复到群组（HTML 格式化，长结果分页）
7. 回复结果消息可继续多轮对话（自动携带上下文）
```

## Hub 部署（管理员）

### 一键部署到 Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/HF0v0p?referralCode=cdSfmj)

模板已包含 **Hub 服务 + Postgres 数据库**，`DATABASE_URL` 已自动配置。部署只需 3 步：

#### 1. 创建 Telegram Bot

1. 打开 Telegram，搜索 **@BotFather**（[点击直达](https://t.me/BotFather)）
2. 点击 **Start**，然后发送 `/newbot`
3. BotFather 会问你 Bot 的**显示名称**，输入你想要的名字（如 `My Team Bot`）
4. 接着会问 Bot 的**用户名**，必须以 `bot` 结尾（如 `my_team_ccchat_bot`）
5. 创建成功后，BotFather 会回复一条消息，其中包含一串 **Token**：
   ```
   Use this token to access the HTTP API:
   123456789:ABCDefGH-IJKlmnOPQRstUVwxyz
   ```
6. **复制这串 Token**，下一步部署时需要用到

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

## 图片/文件使用方法

发送图片或文件时，在 caption 中 @agent 并写上任务内容：

1. 发送一张图片，caption 写 `@xiaoming 分析这张截图的 bug`
2. 发送一个文件，caption 写 `@xiaoming 审查这个代码文件`

附件会自动下载并保存到 Daemon 本地，Claude Code 可以直接读取文件路径。

限制：单个文件最大 5MB。

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

---

## AI 部署指南

> 本节供 AI Agent（OpenClaw、Claude Code 等）自动化部署 CCChat 使用。
> 用户只需告诉 AI："帮我部署 ccchat"，AI 按以下步骤执行即可。

### 前置条件检查

开始前，确认以下工具已安装。若缺少任何一项，先安装再继续：

| 工具 | 检查命令 | 安装方式 |
|------|---------|---------|
| Node.js >= 20 | `node -v` | https://nodejs.org 或 `nvm install 20` |
| pnpm | `pnpm -v` | `npm install -g pnpm` |
| Claude Code CLI | `claude -v` | `npm install -g @anthropic-ai/claude-code` |
| Railway CLI（仅 Hub 部署需要） | `railway version` | `npm install -g @railway/cli && railway login` |

### 场景 A：部署 Daemon（加入已有团队）

用户已有团队的 Hub 地址和 Bot，只需在本地启动 Daemon。

**需要向用户询问的信息：**
- Hub WebSocket 地址（格式：`wss://xxx.up.railway.app`）
- Agent 名称（英文，如 `xiaoming`）
- Token（通过 Telegram Bot `/register` 获取）
- 工作目录（Claude Code 执行任务的路径）
- （可选）系统提示词（Agent 身份描述）

**步骤：**

```bash
# 1. 克隆代码并构建
git clone https://github.com/0xEmberZz/ccchat.git ~/.ccchat-agent
cd ~/.ccchat-agent
pnpm install
pnpm -r build

# 2. 写入配置（用实际值替换占位符）
mkdir -p ~/.ccchat
cat > ~/.ccchat/config.json << 'EOF'
{
  "hubUrl": "<HUB_WEBSOCKET_地址>",
  "agentName": "<AGENT_名称>",
  "token": "<TOKEN>",
  "workDir": "<工作目录绝对路径>",
  "systemPrompt": "你是一个 Claude Agent，用中文回复。",
  "maxConcurrentTasks": 1,
  "taskTimeout": 300000
}
EOF

# 3. 启动 Daemon（前台运行，看到"注册成功"即表示连接成功）
cd ~/.ccchat-agent && npx tsx packages/daemon/src/index.ts start
```

**验证：** 输出包含 `注册成功, Agent: <名称>` 即为成功。

**后台运行（可选）：**
```bash
nohup npx tsx packages/daemon/src/index.ts start > ~/.ccchat/daemon.log 2>&1 &
```

### 场景 B：从零部署整套系统（Hub + Daemon）

用户是管理员，需要部署 Hub 服务器和第一个 Daemon。

**需要向用户询问的信息：**
- Telegram Bot Token（从 @BotFather 创建 Bot 获取）
- （可选）Telegram 群聊 ID

**步骤：**

```bash
# 1. 克隆代码
git clone https://github.com/0xEmberZz/ccchat.git ~/ccchat
cd ~/ccchat
pnpm install
pnpm -r build

# 2. 部署 Hub 到 Railway（需要已 railway login）
railway init
# 选择或创建项目后：
# 2a. 添加 Postgres 数据库
railway add --plugin postgresql
# 2b. 设置环境变量
railway variables set TELEGRAM_BOT_TOKEN=<BOT_TOKEN>
# 2c. 部署
railway up --detach
```

**部署后配置：**

```bash
# 3. 获取 Hub 公网域名
railway domain
# 输出类似: hub-xxxx.up.railway.app

# 4. 设置 HUB_URL 环境变量（用上一步的域名）
railway variables set HUB_URL=wss://<你的域名>

# 5. 重新部署使 HUB_URL 生效
railway up --detach
```

**验证 Hub：**
```bash
curl https://<你的域名>/health
# 应返回: {"status":"ok", ...}
```

**然后：**
1. 将 Bot 添加到 Telegram 群组并设为管理员
2. 私聊 Bot 发送 `/register <名称>` 获取 Token
3. 按「场景 A」步骤部署 Daemon

### 故障排查

| 症状 | 原因 | 解决方案 |
|------|------|---------|
| Daemon 输出 `无效的 token` | Token 错误或已刷新 | 私聊 Bot `/register <名称>` 重新获取 |
| Daemon 反复断线重连 | 有多个同名 Daemon 进程 | `ps aux \| grep daemon` 检查并 kill 多余进程 |
| Bot 不响应群消息 | Bot 未设为管理员，或 Webhook 未生效 | 确认 Bot 是群管理员；检查 `HUB_URL` 是否正确 |
| `/health` 返回错误 | Railway 部署失败 | `railway logs` 查看日志 |
| 任务超时 | 默认 5 分钟超时 | `config.json` 中调大 `taskTimeout` |

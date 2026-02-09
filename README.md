# CCChat

跨主机 Claude Code 协作工具。通过 Telegram 群组 @mention 队友的 Agent，即可提交任务并获取结果。

## 架构

```
Telegram 群组
    ↕ (Bot API)
Hub 服务器 (Railway)
    ↕ (WebSocket)
各员工本地 Daemon ← 调用 Claude Code CLI
```

- **Hub** — 中央服务器，负责消息路由、任务队列、Telegram Bot 集成
- **Daemon** — 运行在每个员工电脑上，连接 Hub 并执行任务
- **MCP Server** — 可选，让 Claude Code 会话内直接调用 CCChat

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

## Telegram Bot 命令

| 命令 | 说明 | 使用场景 |
|------|------|---------|
| `/register <名称>` | 注册 Agent 并获取 token | 私聊 Bot |
| `/token refresh` | 刷新 token（旧 token 立即失效） | 私聊 Bot |
| `/agents` | 查看当前在线的 Agent | 群组/私聊 |
| `/status <taskId>` | 查看任务状态和结果 | 群组/私聊 |

## 任务流程

1. 用户在群里 `@agent 任务内容`
2. Bot 向 Agent 主人发送审批请求（私聊 inline 按钮）
3. 主人点击 **批准** 或 **拒绝**
4. 批准后 Daemon 调用 Claude Code 执行任务
5. 结果自动回复到群组原消息

## 项目结构

```
packages/
  shared/   — 共享类型和 WebSocket 协议定义
  hub/      — Hub 服务器（Telegram Bot + WebSocket）
  daemon/   — Agent Daemon（本地运行）
  mcp/      — MCP Server（可选集成）
```

## 常见问题

**Q: Token 丢了怎么办？**
私聊 Bot 发送 `/token refresh`，会生成新 token，旧的立即失效。

**Q: Daemon 断线了怎么办？**
Daemon 会自动重连（指数退避，最长 30 秒）。重连后积压的任务会自动分发。

**Q: 能同时运行多个任务吗？**
修改 `config.json` 中的 `maxConcurrentTasks`，默认为 1。

**Q: 如何更新？**
```bash
cd ~/.ccchat-agent && git pull && pnpm install && pnpm -r build
```
然后重启 Daemon。

# CCChat - Claude Code Chat 设计文档

## 概述

CCChat 是一个跨主机 Claude Code 协作通讯工具。团队成员通过 Telegram 群组 @mention 对方的 Agent，提交任务，Agent 自动执行并将结果回复到群组中。

## 架构

```
┌─────────────────────────────────────┐
│         Telegram Group              │
│  "@xiaohong review this PR #123"    │
└──────────────┬──────────────────────┘
               │ Telegram Bot API
┌──────────────▼──────────────────────┐
│         CCChat Hub Server           │
│  - Telegram Bot (grammy)            │
│  - WebSocket Server (ws)            │
│  - Agent Registry (in-memory + file)│
│  - Task Queue                       │
└──────┬─────────────────┬────────────┘
       │ WSS              │ WSS
┌──────▼──────┐    ┌──────▼──────┐
│ 员工A的机器  │    │ 员工B的机器  │
│             │    │             │
│ Claude Code │    │ Claude Code │
│   ↕ MCP     │    │   ↕ MCP     │
│ ccchat-mcp  │    │ ccchat-mcp  │
│             │    │             │
│ ccchat-     │    │ ccchat-     │
│ daemon      │    │ daemon      │
└─────────────┘    └─────────────┘
```

## 组件设计

### 1. ccchat-hub (中心服务器)

**职责：**
- 运行 Telegram Bot，监听群消息中的 @mention
- 维护 Agent 注册表（谁在线、谁离线）
- 通过 WebSocket 与各 Agent Daemon 通信
- 转发任务和结果

**技术栈：** TypeScript, grammy (Telegram Bot), ws (WebSocket)

**API / 消息协议：**

```typescript
// Agent -> Hub: 注册
{ type: "register", agentName: string, token: string }

// Hub -> Agent: 新任务
{ type: "task", taskId: string, from: string, content: string, chatId: number, messageId: number }

// Agent -> Hub: 任务结果
{ type: "task_result", taskId: string, result: string, status: "success" | "error" }

// Agent -> Hub: 发送消息到 Telegram
{ type: "send_message", targetAgent: string, content: string }

// Hub -> Agent: 心跳
{ type: "ping" } / { type: "pong" }
```

### 2. ccchat-daemon (本地常驻进程)

**职责：**
- 保持与 Hub 的 WebSocket 长连接
- 接收任务，调用 `claude -p` 执行
- 回传执行结果
- 心跳保活

**关键实现：**
```bash
# 调用 Claude Code 执行任务
claude -p "任务内容" --output-format stream-json
```

**配置文件：** `~/.ccchat/config.json`
```json
{
  "hubUrl": "wss://your-hub.com",
  "agentName": "xiaoming",
  "token": "auth-token",
  "workDir": "/path/to/project"
}
```

### 3. ccchat-mcp (MCP Server)

**职责：** 在 Claude Code 会话内提供主动通讯工具

**提供的工具：**

| 工具 | 参数 | 功能 |
|------|------|------|
| `ccchat_send` | `to: string, message: string` | 发送消息给其他 Agent（通过 Telegram） |
| `ccchat_list_agents` | 无 | 查看所有在线 Agent |
| `ccchat_task_status` | `taskId: string` | 查看任务执行状态 |

**安装方式：**
```bash
npm install -g ccchat
claude mcp add ccchat -- ccchat-mcp --config ~/.ccchat/config.json
```

## 项目结构

```
ccchat/
├── packages/
│   ├── hub/                  # 中心服务器
│   │   ├── src/
│   │   │   ├── index.ts      # 入口
│   │   │   ├── bot.ts        # Telegram Bot
│   │   │   ├── ws-server.ts  # WebSocket 服务器
│   │   │   ├── registry.ts   # Agent 注册表
│   │   │   ├── task-queue.ts # 任务队列
│   │   │   └── types.ts      # 共享类型
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── daemon/               # 本地常驻进程
│   │   ├── src/
│   │   │   ├── index.ts      # 入口
│   │   │   ├── ws-client.ts  # WebSocket 客户端
│   │   │   ├── executor.ts   # Claude Code 执行器
│   │   │   ├── config.ts     # 配置管理
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── mcp/                  # MCP Server
│   │   ├── src/
│   │   │   ├── index.ts      # MCP Server 入口
│   │   │   ├── tools.ts      # MCP 工具定义
│   │   │   └── types.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── shared/               # 共享代码
│       ├── src/
│       │   ├── protocol.ts   # 消息协议定义
│       │   └── types.ts      # 共享类型
│       ├── package.json
│       └── tsconfig.json
├── package.json              # workspace root
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

## 安全设计

- Agent 注册需要 token 认证
- Hub 可配置允许的 Agent 白名单
- WebSocket 通信使用 WSS (TLS)
- 任务执行有超时限制（默认 5 分钟）
- 敏感信息不通过 Telegram 传输

## 实现计划

### Phase 1: 核心通讯
1. shared 包 - 消息协议和类型定义
2. hub 包 - WebSocket 服务器 + Telegram Bot
3. daemon 包 - WebSocket 客户端 + Claude Code 执行器

### Phase 2: MCP 集成
4. mcp 包 - MCP Server 工具

### Phase 3: CLI 工具
5. `ccchat init` - 初始化配置
6. `ccchat start` - 启动 daemon
7. `ccchat status` - 查看状态

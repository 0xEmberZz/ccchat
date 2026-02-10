# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
# Install dependencies
pnpm install

# Build all packages (shared must build first, handled by pnpm -r)
pnpm -r build

# Dev mode (with watch)
pnpm dev:hub                    # Hub server
pnpm dev:daemon                 # Daemon (note: needs "start" subcommand, see below)

# Start daemon correctly (dev script doesn't pass subcommand)
cd packages/daemon && npx tsx --watch src/index.ts start

# Production start
pnpm hub                       # Hub server
pnpm daemon                    # Daemon
```

No test framework or linter is configured yet.

## Architecture

CCChat is a distributed task execution system connecting Telegram to local Claude Code CLIs.

```
Telegram Group ←→ Hub (Railway) ←→ Daemon (local) → claude CLI
                    ↑
              MCP Server (optional, in Claude Code sessions)
```

### Packages (pnpm monorepo)

| Package | Purpose | Runtime |
|---------|---------|---------|
| `shared` | Types + WebSocket protocol definitions | Library only |
| `hub` | Central server: Telegram Bot (grammY), WebSocket server, HTTP API, Postgres | Railway |
| `daemon` | Local agent: connects to Hub, executes tasks via `claude` CLI | Local machine |
| `mcp` | MCP server for Claude Code sessions to submit tasks | Local (stdio) |

**Dependency chain**: `shared` ← `hub`, `daemon`, `mcp` (always build shared first)

### Hub Internals (`packages/hub/src/`)

- **`index.ts`** — Startup orchestration: creates HTTP+WS server, initializes Bot in webhook mode, wires callbacks between modules
- **`bot.ts`** — Telegram Bot (grammY webhook mode). Commands, inline mode, auto-approval, approval buttons, multi-turn conversation, real-time progress display, photo/document handlers. Largest file (~1000 lines)
- **`ws-server.ts`** — WebSocket connection management. Handles agent registration, heartbeat (30s ping), backlog task dispatch on reconnect
- **`registry.ts`** — Agent credential management (token generation, validation). Persists to Postgres or falls back to JSON file
- **`task-queue.ts`** — Task lifecycle: pending → awaiting_approval → approved → running → completed/failed/cancelled
- **`api.ts`** — REST API endpoints (`/api/tasks`, `/api/agents`, `/health`). Bearer token auth
- **`agent-status-store.ts`** — In-memory runtime status (resets on deploy)
- **`status-panel.ts`** — Maintains a live-updating Telegram message showing online agents
- **`db/`** — Postgres connection pool, migrations, repository pattern (CredentialRepo, TaskRepo)

### Daemon Internals (`packages/daemon/src/`)

- **`index.ts`** — CLI entry point with subcommands: `start`, `init`, `status`, `help`
- **`config.ts`** — Reads/writes `~/.ccchat/config.json`
- **`ws-client.ts`** — WebSocket client with exponential backoff reconnect (1s base, 30s max)
- **`executor.ts`** — Spawns `claude -p <prompt> --output-format stream-json`, parses NDJSON stream for real-time progress (thinking/tool_use/responding), handles timeout (SIGTERM→5s→SIGKILL), output truncation (4000 chars)

### MCP Server (`packages/mcp/src/`)

- **`hub-client.ts`** — WebSocket client with request-response correlation (requestId, 15s timeout)
- **`http-client.ts`** — HTTP client for task submission (Bearer token auth)
- **`tools.ts`** — 5 MCP tools: `ccchat_list_agents`, `ccchat_task_status`, `ccchat_send`, `ccchat_submit_task`, `ccchat_check_result`

## WebSocket Protocol

All messages are JSON. Types defined in `packages/shared/src/protocol.ts`.

**Agent → Hub**: `register`, `pong`, `task_result`, `task_cancelled`, `status_report`, `task_progress`, `list_agents`, `task_status`, `send_message`

**Hub → Agent**: `register_ack`, `ping`, `task` (dispatch), `cancel_task`, `list_agents_response`, `task_status_response`

Key flow: Agent sends `register` with token → Hub validates → sends `register_ack` → dispatches any backlogged approved tasks.

## Task Lifecycle

`pending` → `awaiting_approval` (Bot sends approval buttons) → `approved` (user approves) → `running` (dispatched to agent) → `completed`/`failed`/`cancelled`

Auto-approval: if the sender's Telegram ID matches the agent owner's ID, the task skips `awaiting_approval` and goes directly to `approved` → `running`.

Multi-turn: user replies to a result message → Claude native session resume via `--resume` flag → creates new task with `conversationId` and `parentTaskId`.

Real-time progress: during `running` state, daemon sends `task_progress` messages (thinking/tool_use/responding) → Hub forwards to Bot → Bot edits a progress message in Telegram (3s debounce) → deleted when task completes.

## Key Technical Decisions

- **grammY webhook mode** (NOT long polling): use `bot.init()` + `bot.api.setWebhook()`, never `bot.start()`. These modes are mutually exclusive
- **Same-name reconnect**: Hub auto-disconnects old WebSocket when same agent name re-registers (prevents ghost connections)
- **No webhook deletion on shutdown**: new instance's `setWebhook` auto-overrides, avoids race condition during rolling deploys
- **Status panel is in-memory**: `panels` Map resets on deploy, sends new message instead of editing old one
- **Online notification debounce**: 5s (status panel has its own 2s debounce; 60s was too aggressive)
- **Auto-approval**: `senderId === ownerTelegramId` check — agent owner's tasks skip approval buttons entirely
- **stream-json executor**: daemon uses `--output-format stream-json` for NDJSON streaming, extracts status from `assistant` events (content block types: `tool_use` → tool name, `text` → responding, empty → thinking), final result from `type: "result"` event
- **Progress message lifecycle**: init on dispatch → 3s debounce edits → delete on complete/cancel/agent-offline
- **Attachments are in-memory only**: stored in `Map<taskId, TaskAttachment[]>`, cleaned up on terminal task status or successful dispatch — not persisted to DB
- **File download 5MB limit**: Telegram files downloaded via Bot API `getFile` + direct URL fetch, filenames sanitized with `basename()` to prevent path traversal

## Tech Stack

- TypeScript 5.7+ (strict, ES2022, ESM)
- grammY (Telegram Bot framework, webhook mode)
- ws (WebSocket, both server and client)
- pg (PostgreSQL client)
- @modelcontextprotocol/sdk + zod 4 (MCP server)
- No frontend — pure backend/CLI

## Database

Single migration in `packages/hub/src/db/migrations.ts`:
- `credentials` — agent_name (PK), token (unique), telegram_user_id
- `tasks` — full task state with conversation tracking (conversation_id, parent_task_id, result_message_id)
- `pending_tasks` — backlog queue per agent (agent_name + task_id, ordered by position)
- `status_panels` — persisted status panel message IDs per chat (chat_id PK, message_id)

TaskRepo also provides `findRecent()` for `/history` command queries.

## Environment Variables (Hub)

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `DATABASE_URL` | Recommended | PostgreSQL connection string |
| `HUB_URL` | Recommended | WebSocket URL shown in `/register` replies |
| `TELEGRAM_CHAT_ID` | Optional | Default group chat for API-submitted tasks |
| `PORT` | Auto | HTTP server port (default 9900) |

## Deployment

- Hub deploys to Railway via `Dockerfile` (multi-stage Node 20-slim build)
- `railway up --service hub --detach` for manual deploy
- Daemon runs locally, config at `~/.ccchat/config.json`

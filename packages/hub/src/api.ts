import type { IncomingMessage, ServerResponse } from "node:http"
import type { Registry } from "./registry.js"
import type { TaskQueue } from "./task-queue.js"

interface ApiDeps {
  readonly registry: Registry
  readonly taskQueue: TaskQueue
}

interface JsonBody {
  readonly [key: string]: unknown
}

const MAX_BODY_SIZE = 1_048_576 // 1 MB

/** 读取请求 body（限制大小防止 DoS） */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalSize = 0
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy()
        reject(new Error("Request body too large"))
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString()))
    req.on("error", reject)
  })
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(data))
}

/** 从 Authorization header 验证 token，返回 agent 名称 */
function authenticate(req: IncomingMessage, registry: Registry): string | undefined {
  const auth = req.headers.authorization
  if (!auth?.startsWith("Bearer ")) return undefined
  const token = auth.slice(7)
  return registry.getAgentByToken(token)
}

/** 创建 HTTP API 请求处理器 */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { registry, taskQueue } = deps

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    const path = url.pathname
    const method = req.method ?? "GET"

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

    if (method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    // 所有 API 路由需要认证
    if (path.startsWith("/api/")) {
      const agentName = authenticate(req, registry)
      if (!agentName) {
        sendJson(res, 401, { error: "未认证，请提供有效的 Bearer token" })
        return
      }

      try {
        await routeApi(method, path, req, res, agentName, deps)
      } catch (err) {
        process.stderr.write(`API error: ${err}\n`)
        sendJson(res, 500, { error: "内部错误" })
      }
      return
    }

    // 健康检查
    if (path === "/health") {
      sendJson(res, 200, { status: "ok" })
      return
    }
  }
}

/** 路由 API 请求 */
async function routeApi(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  fromAgent: string,
  deps: ApiDeps,
): Promise<void> {
  const { registry, taskQueue } = deps

  // POST /api/tasks — 提交任务
  if (method === "POST" && path === "/api/tasks") {
    const raw = await readBody(req)
    let body: JsonBody
    try {
      body = JSON.parse(raw) as JsonBody
    } catch {
      sendJson(res, 400, { error: "无效的 JSON" })
      return
    }

    const to = body.to as string | undefined
    const content = body.content as string | undefined

    if (!to || !content) {
      sendJson(res, 400, { error: "缺少 to 或 content 字段" })
      return
    }

    // 检查目标 agent 是否已注册
    const targetCredential = registry.getCredential(to)
    if (!targetCredential) {
      sendJson(res, 404, { error: `Agent "${to}" 未注册` })
      return
    }

    // 创建任务（chatId 由 bot 回调填充）
    const task = taskQueue.createTask({
      from: fromAgent,
      to,
      content,
      chatId: 0,
      messageId: 0,
    })
    taskQueue.updateStatus(task.taskId, "awaiting_approval")

    // 向目标 Agent 的主人发送 TG 审批请求
    const ownerTelegramId = registry.getTelegramUserId(to)
    if (ownerTelegramId) {
      // 通过事件通知 bot 发送审批（通过 onApiTaskCreated 回调）
      apiTaskCallback?.({
        taskId: task.taskId,
        from: fromAgent,
        to,
        content,
        ownerTelegramId,
      })
    }

    sendJson(res, 201, {
      taskId: task.taskId,
      status: task.status,
      message: ownerTelegramId
        ? "任务已创建，等待 TG 审批"
        : "任务已创建，但目标 Agent 未绑定 Telegram，无法审批",
    })
    return
  }

  // GET /api/tasks/:id — 查询任务状态
  const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/)
  if (method === "GET" && taskMatch) {
    const taskId = taskMatch[1]
    const task = taskQueue.getTask(taskId)
    if (!task) {
      sendJson(res, 404, { error: "任务不存在" })
      return
    }
    sendJson(res, 200, task)
    return
  }

  // GET /api/agents — 列出在线 Agent
  if (method === "GET" && path === "/api/agents") {
    const agents = registry.listAgents()
    sendJson(res, 200, { agents })
    return
  }

  sendJson(res, 404, { error: "未找到路由" })
}

// API 任务创建回调（由 bot 注册）
export interface ApiTaskEvent {
  readonly taskId: string
  readonly from: string
  readonly to: string
  readonly content: string
  readonly ownerTelegramId: number
}

export type ApiTaskCallback = (event: ApiTaskEvent) => void

let apiTaskCallback: ApiTaskCallback | undefined

export function onApiTaskCreated(callback: ApiTaskCallback): void {
  apiTaskCallback = callback
}

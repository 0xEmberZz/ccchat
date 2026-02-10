import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import type { Server as HttpServer } from "node:http"
import {
  parseAgentMessage,
  serialize,
  type AgentToHubMessage,
  type HubToAgentMessage,
  type TaskMessage,
  type CancelTaskMessage,
} from "@ccchat/shared"
import type { Registry } from "./registry.js"
import type { TaskQueue } from "./task-queue.js"
import type { AgentStatusStore } from "./agent-status-store.js"

// 心跳间隔 30 秒
const HEARTBEAT_INTERVAL = 30_000

// 回调类型
export type TaskResultCallback = (
  taskId: string,
  result: string,
  status: "success" | "error",
  chatId: number,
  messageId: number,
) => void

export type AgentStatusCallback = (agentName: string) => void

export type TaskCancelledCallback = (taskId: string, agentName: string) => void

// WsServer 对外 API
export interface WsServer {
  readonly sendToAgent: (agentName: string, msg: HubToAgentMessage) => boolean
  readonly cancelTask: (agentName: string, taskId: string) => boolean
  readonly onTaskResult: (callback: TaskResultCallback) => void
  readonly onTaskCancelled: (callback: TaskCancelledCallback) => void
  readonly onAgentOnline: (callback: AgentStatusCallback) => void
  readonly onAgentOffline: (callback: AgentStatusCallback) => void
  readonly close: () => void
}

// 创建 WebSocket 服务器
export function createWsServer(
  httpServer: HttpServer,
  registry: Registry,
  taskQueue: TaskQueue,
  agentStatusStore?: AgentStatusStore,
): WsServer {
  const wss = new WebSocketServer({ server: httpServer })
  let taskResultCallback: TaskResultCallback | undefined
  let taskCancelledCallback: TaskCancelledCallback | undefined
  let agentOnlineCallback: AgentStatusCallback | undefined
  let agentOfflineCallback: AgentStatusCallback | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const lastOnlineNotify = new Map<string, number>()
  const ONLINE_NOTIFY_DEBOUNCE = 5_000 // 5 秒内不重复通知（状态面板自带 2s 防抖）

  // 发送消息给指定 Agent
  function sendToAgent(agentName: string, msg: HubToAgentMessage): boolean {
    const conn = registry.getConnection(agentName)
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false
    conn.ws.send(serialize(msg))
    return true
  }

  // 处理注册消息
  function handleRegister(
    ws: WebSocket,
    agentName: string,
    token: string,
  ): void {
    if (!registry.validateAgentToken(agentName, token)) {
      ws.send(serialize({ type: "register_ack", success: false, error: "无效的 token" }))
      ws.close()
      return
    }
    // 如果已有同名连接，先断开旧连接
    const existing = registry.getConnection(agentName)
    if (existing) {
      existing.ws.close()
      registry.unregister(agentName)
    }
    registry.register(agentName, ws)
    ws.send(serialize({ type: "register_ack", success: true }))
    const now = Date.now()
    const lastNotify = lastOnlineNotify.get(agentName) ?? 0
    if (now - lastNotify > ONLINE_NOTIFY_DEBOUNCE) {
      lastOnlineNotify.set(agentName, now)
      agentOnlineCallback?.(agentName)
    }
    // 发送离线期间积累的待处理任务
    deliverPendingTasks(agentName)
  }

  // 发送积压的待处理任务（仅分发已审批的任务）
  function deliverPendingTasks(agentName: string): void {
    const pending = taskQueue.getPendingTasks(agentName)
    for (const task of pending) {
      // 跳过已取消/已拒绝的任务
      if (task.status === "cancelled" || task.status === "rejected" || task.status === "completed" || task.status === "failed") {
        taskQueue.removePending(agentName, task.taskId)
        continue
      }
      // 只分发已审批的任务，未审批的留在队列中等待
      if (task.status !== "approved") {
        continue
      }
      const msg: TaskMessage = {
        type: "task",
        taskId: task.taskId,
        from: task.from,
        content: task.content,
        chatId: task.chatId,
        messageId: task.messageId,
      }
      const sent = sendToAgent(agentName, msg)
      if (sent) {
        taskQueue.removePending(agentName, task.taskId)
        taskQueue.updateStatus(task.taskId, "running")
      }
    }
  }

  // 处理任务结果
  function handleTaskResult(
    agentName: string,
    taskId: string,
    result: string,
    status: "success" | "error",
  ): void {
    const task = taskQueue.getTask(taskId)
    if (!task) return
    const finalStatus = status === "success" ? "completed" : "failed"
    taskQueue.updateStatus(taskId, finalStatus, result)
    agentStatusStore?.incrementCompleted(agentName)
    taskResultCallback?.(taskId, result, status, task.chatId, task.messageId)
  }

  // 发送取消指令给 Agent
  function cancelTask(agentName: string, taskId: string): boolean {
    const msg: CancelTaskMessage = { type: "cancel_task", taskId }
    return sendToAgent(agentName, msg)
  }

  // 处理列出 Agent 请求
  function handleListAgents(ws: WebSocket, requestId: string): void {
    const agents = registry.listAgents()
    ws.send(serialize({ type: "list_agents_response", requestId, agents }))
  }

  // 处理任务状态查询
  function handleTaskStatus(
    ws: WebSocket,
    requestId: string,
    taskId: string,
  ): void {
    const task = taskQueue.getTask(taskId) ?? null
    ws.send(serialize({ type: "task_status_response", requestId, task }))
  }

  // 路由消息
  function routeMessage(ws: WebSocket, msg: AgentToHubMessage): void {
    const agentName = registry.getAgentByWs(ws)

    switch (msg.type) {
      case "register":
        handleRegister(ws, msg.agentName, msg.token)
        return
      case "pong":
        if (agentName) registry.updateLastSeen(agentName)
        return
      case "task_result":
        if (agentName) handleTaskResult(agentName, msg.taskId, msg.result, msg.status)
        return
      case "list_agents":
        if (agentName) handleListAgents(ws, msg.requestId)
        return
      case "task_status":
        if (agentName) handleTaskStatus(ws, msg.requestId, msg.taskId)
        return
      case "task_cancelled":
        if (agentName) {
          taskQueue.updateStatus(msg.taskId, "cancelled")
          agentStatusStore?.incrementCompleted(agentName)
          taskCancelledCallback?.(msg.taskId, agentName)
        }
        return
      case "status_report":
        if (agentName && agentStatusStore) {
          agentStatusStore.update(agentName, {
            runningTasks: msg.runningTasks,
            currentTaskId: msg.currentTaskId,
            idleSince: msg.idleSince,
          })
        }
        return
      case "send_message":
        // Agent 间消息传递（暂不处理，预留扩展）
        return
    }
  }

  // 处理新连接
  function handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    ws.on("message", (data: Buffer) => {
      let msg: AgentToHubMessage
      try {
        msg = parseAgentMessage(data.toString())
      } catch {
        return // 忽略格式错误的消息
      }
      try {
        routeMessage(ws, msg)
      } catch (err) {
        process.stderr.write(`Message routing error: ${err}\n`)
      }
    })

    ws.on("close", () => {
      const agentName = registry.getAgentByWs(ws)
      if (agentName) {
        registry.unregister(agentName)
        agentOfflineCallback?.(agentName)
      }
    })

    ws.on("error", () => {
      const agentName = registry.getAgentByWs(ws)
      if (agentName) {
        registry.unregister(agentName)
        agentOfflineCallback?.(agentName)
      }
    })
  }

  // 心跳检测：定时向所有连接发送 ping
  function startHeartbeat(): void {
    heartbeatTimer = setInterval(() => {
      const agents = registry.listAgents()
      for (const agent of agents) {
        sendToAgent(agent.name, { type: "ping" })
      }
    }, HEARTBEAT_INTERVAL)
  }

  // 初始化
  wss.on("connection", handleConnection)
  startHeartbeat()

  return {
    sendToAgent,
    cancelTask,
    onTaskResult: (callback: TaskResultCallback) => {
      taskResultCallback = callback
    },
    onTaskCancelled: (callback: TaskCancelledCallback) => {
      taskCancelledCallback = callback
    },
    onAgentOnline: (callback: AgentStatusCallback) => {
      agentOnlineCallback = callback
    },
    onAgentOffline: (callback: AgentStatusCallback) => {
      agentOfflineCallback = callback
    },
    close: () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      wss.close()
    },
  }
}

import { WebSocketServer, WebSocket } from "ws"
import type { IncomingMessage } from "node:http"
import type { Server as HttpServer } from "node:http"
import {
  parseAgentMessage,
  serialize,
  type AgentToHubMessage,
  type HubToAgentMessage,
  type TaskMessage,
} from "@ccchat/shared"
import type { Registry } from "./registry.js"
import type { TaskQueue } from "./task-queue.js"

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

// WsServer 对外 API
export interface WsServer {
  readonly sendToAgent: (agentName: string, msg: HubToAgentMessage) => boolean
  readonly dispatchTask: (task: TaskMessage) => boolean
  readonly onTaskResult: (callback: TaskResultCallback) => void
  readonly onAgentOnline: (callback: AgentStatusCallback) => void
  readonly onAgentOffline: (callback: AgentStatusCallback) => void
  readonly close: () => void
}

// 创建 WebSocket 服务器
export function createWsServer(
  httpServer: HttpServer,
  registry: Registry,
  taskQueue: TaskQueue,
): WsServer {
  const wss = new WebSocketServer({ server: httpServer })
  let taskResultCallback: TaskResultCallback | undefined
  let agentOnlineCallback: AgentStatusCallback | undefined
  let agentOfflineCallback: AgentStatusCallback | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined

  // 发送消息给指定 Agent
  function sendToAgent(agentName: string, msg: HubToAgentMessage): boolean {
    const conn = registry.getConnection(agentName)
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false
    conn.ws.send(serialize(msg))
    return true
  }

  // 分发任务给 Agent
  function dispatchTask(task: TaskMessage): boolean {
    return sendToAgent(task.from, task) // 注意：task 发送给 to 对应的 agent
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
    agentOnlineCallback?.(agentName)
    // 发送离线期间积累的待处理任务
    deliverPendingTasks(agentName)
  }

  // 发送积压的待处理任务
  function deliverPendingTasks(agentName: string): void {
    const pending = taskQueue.getPendingTasks(agentName)
    for (const task of pending) {
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
    taskResultCallback?.(taskId, result, status, task.chatId, task.messageId)
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
        handleListAgents(ws, msg.requestId)
        return
      case "task_status":
        handleTaskStatus(ws, msg.requestId, msg.taskId)
        return
      case "send_message":
        // Agent 间消息传递（暂不处理，预留扩展）
        return
    }
  }

  // 处理新连接
  function handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    ws.on("message", (data: Buffer) => {
      try {
        const msg = parseAgentMessage(data.toString())
        routeMessage(ws, msg)
      } catch {
        // 忽略格式错误的消息
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
    dispatchTask: (task: TaskMessage) => {
      // task.from 是发起者，这里要发给目标 Agent（根据 task 关联的 to）
      const taskInfo = taskQueue.getTask(task.taskId)
      if (!taskInfo) return false
      return sendToAgent(taskInfo.to, task)
    },
    onTaskResult: (callback: TaskResultCallback) => {
      taskResultCallback = callback
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

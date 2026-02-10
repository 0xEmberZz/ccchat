import type { AgentInfo, TaskInfo } from "./types.js"

// ─── Agent -> Hub Messages ───

export interface RegisterMessage {
  readonly type: "register"
  readonly agentName: string
  readonly token: string
}

export interface PongMessage {
  readonly type: "pong"
}

export interface TaskResultMessage {
  readonly type: "task_result"
  readonly taskId: string
  readonly result: string
  readonly status: "success" | "error"
}

export interface SendChatMessage {
  readonly type: "send_message"
  readonly targetAgent: string
  readonly content: string
}

export interface ListAgentsRequest {
  readonly type: "list_agents"
  readonly requestId: string
}

export interface TaskStatusRequest {
  readonly type: "task_status"
  readonly requestId: string
  readonly taskId: string
}

export interface TaskCancelledMessage {
  readonly type: "task_cancelled"
  readonly taskId: string
}

export interface StatusReportMessage {
  readonly type: "status_report"
  readonly runningTasks: number
  readonly currentTaskId?: string
  readonly idleSince?: string
}

export interface TaskProgressMessage {
  readonly type: "task_progress"
  readonly taskId: string
  readonly status: string
  readonly detail?: string
  readonly elapsedMs: number
}

export type AgentToHubMessage =
  | RegisterMessage
  | PongMessage
  | TaskResultMessage
  | SendChatMessage
  | ListAgentsRequest
  | TaskStatusRequest
  | TaskCancelledMessage
  | StatusReportMessage
  | TaskProgressMessage

// ─── Hub -> Agent Messages ───

export interface RegisterAckMessage {
  readonly type: "register_ack"
  readonly success: boolean
  readonly error?: string
}

export interface PingMessage {
  readonly type: "ping"
}

export interface TaskMessage {
  readonly type: "task"
  readonly taskId: string
  readonly from: string
  readonly content: string
  readonly chatId: number
  readonly messageId: number
  readonly conversationId?: string
  readonly parentTaskId?: string
  readonly attachments?: ReadonlyArray<import("./types.js").TaskAttachment>
}

export interface ListAgentsResponse {
  readonly type: "list_agents_response"
  readonly requestId: string
  readonly agents: ReadonlyArray<AgentInfo>
}

export interface TaskStatusResponse {
  readonly type: "task_status_response"
  readonly requestId: string
  readonly task: TaskInfo | null
}

export interface CancelTaskMessage {
  readonly type: "cancel_task"
  readonly taskId: string
}

export type HubToAgentMessage =
  | RegisterAckMessage
  | PingMessage
  | TaskMessage
  | ListAgentsResponse
  | TaskStatusResponse
  | CancelTaskMessage

// ─── Helpers ───

export function serialize(msg: AgentToHubMessage | HubToAgentMessage): string {
  return JSON.stringify(msg)
}

/** 合法的 Agent→Hub 消息类型 */
const VALID_AGENT_MESSAGE_TYPES = new Set([
  "register", "pong", "task_result", "send_message",
  "list_agents", "task_status", "task_cancelled",
  "status_report", "task_progress",
])

/** 验证并解析 Agent→Hub 消息，返回 undefined 表示无效消息 */
export function parseAgentMessage(raw: string): AgentToHubMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== "string" || !VALID_AGENT_MESSAGE_TYPES.has(msg.type)) return undefined

  // 按类型校验必要字段
  switch (msg.type) {
    case "register":
      if (typeof msg.agentName !== "string" || typeof msg.token !== "string") return undefined
      break
    case "task_result":
      if (typeof msg.taskId !== "string" || typeof msg.result !== "string") return undefined
      if (msg.status !== "success" && msg.status !== "error") return undefined
      break
    case "task_cancelled":
      if (typeof msg.taskId !== "string") return undefined
      break
    case "list_agents":
      if (typeof msg.requestId !== "string") return undefined
      break
    case "task_status":
      if (typeof msg.requestId !== "string" || typeof msg.taskId !== "string") return undefined
      break
    case "task_progress":
      if (typeof msg.taskId !== "string" || typeof msg.status !== "string") return undefined
      if (typeof msg.elapsedMs !== "number") return undefined
      break
    case "status_report":
      if (typeof msg.runningTasks !== "number") return undefined
      break
    case "send_message":
      if (typeof msg.targetAgent !== "string" || typeof msg.content !== "string") return undefined
      break
    // pong 无额外字段
  }

  return parsed as AgentToHubMessage
}

/** 合法的 Hub→Agent 消息类型 */
const VALID_HUB_MESSAGE_TYPES = new Set([
  "register_ack", "ping", "task",
  "list_agents_response", "task_status_response", "cancel_task",
])

/** 验证并解析 Hub→Agent 消息，返回 undefined 表示无效消息 */
export function parseHubMessage(raw: string): HubToAgentMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== "string" || !VALID_HUB_MESSAGE_TYPES.has(msg.type)) return undefined

  switch (msg.type) {
    case "register_ack":
      if (typeof msg.success !== "boolean") return undefined
      break
    case "task":
      if (typeof msg.taskId !== "string" || typeof msg.content !== "string") return undefined
      if (typeof msg.from !== "string") return undefined
      break
    case "list_agents_response":
      if (typeof msg.requestId !== "string" || !Array.isArray(msg.agents)) return undefined
      break
    case "task_status_response":
      if (typeof msg.requestId !== "string") return undefined
      break
    case "cancel_task":
      if (typeof msg.taskId !== "string") return undefined
      break
    // ping 无额外字段
  }

  return parsed as HubToAgentMessage
}

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

export function parseAgentMessage(raw: string): AgentToHubMessage {
  return JSON.parse(raw) as AgentToHubMessage
}

export function parseHubMessage(raw: string): HubToAgentMessage {
  return JSON.parse(raw) as HubToAgentMessage
}

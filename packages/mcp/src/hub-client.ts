/**
 * Hub WebSocket 客户端（轻量版，用于 MCP Server）
 * 不含自动重连，适合短生命周期场景
 */
import WebSocket from "ws"
import type {
  AgentToHubMessage,
  HubToAgentMessage,
  ListAgentsResponse,
  TaskStatusResponse,
  RegisterAckMessage,
} from "@ccchat/shared"
import { serialize, parseHubMessage } from "@ccchat/shared"

/** 配置项 */
export interface HubClientConfig {
  readonly hubUrl: string
  readonly agentName: string
  readonly token: string
}

/** 等待中的请求 */
interface PendingRequest<T> {
  readonly resolve: (value: T) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 15_000

/** 生成唯一请求 ID */
function createRequestId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export class HubClient {
  private ws: WebSocket | null = null
  private readonly config: HubClientConfig
  private readonly pendingRequests: Map<string, PendingRequest<HubToAgentMessage>> = new Map()
  private connected = false

  constructor(config: HubClientConfig) {
    this.config = config
  }

  /** 连接到 Hub 并完成注册 */
  async connect(): Promise<void> {
    if (this.connected) return

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.hubUrl)

      ws.on("open", () => {
        this.ws = ws
        const registerMsg: AgentToHubMessage = {
          type: "register",
          agentName: this.config.agentName,
          token: this.config.token,
        }
        ws.send(serialize(registerMsg))
      })

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(String(data), resolve, reject)
      })

      ws.on("error", (err: Error) => {
        if (!this.connected) {
          reject(new Error(`Hub 连接失败: ${err.message}`))
        }
      })

      ws.on("close", () => {
        this.connected = false
        this.rejectAllPending("连接已关闭")
      })
    })
  }

  /** 处理收到的消息 */
  private handleMessage(
    raw: string,
    onRegisterOk: () => void,
    onRegisterFail: (err: Error) => void,
  ): void {
    const msg = parseHubMessage(raw)

    // 注册确认
    if (msg.type === "register_ack") {
      const ack = msg as RegisterAckMessage
      if (ack.success) {
        this.connected = true
        onRegisterOk()
      } else {
        onRegisterFail(new Error(`注册失败: ${ack.error ?? "未知错误"}`))
      }
      return
    }

    // 心跳响应
    if (msg.type === "ping") {
      const pong: AgentToHubMessage = { type: "pong" }
      this.ws?.send(serialize(pong))
      return
    }

    // 带 requestId 的响应消息
    if ("requestId" in msg) {
      const requestId = (msg as ListAgentsResponse | TaskStatusResponse).requestId
      const pending = this.pendingRequests.get(requestId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingRequests.delete(requestId)
        pending.resolve(msg)
      }
    }
  }

  /** 发送聊天消息（fire-and-forget） */
  sendMessage(targetAgent: string, content: string): void {
    this.ensureConnected()
    const msg: AgentToHubMessage = {
      type: "send_message",
      targetAgent,
      content,
    }
    this.ws!.send(serialize(msg))
  }

  /** 请求在线 Agent 列表 */
  async listAgents(): Promise<ListAgentsResponse> {
    this.ensureConnected()
    const requestId = createRequestId()
    const msg: AgentToHubMessage = { type: "list_agents", requestId }
    this.ws!.send(serialize(msg))
    const resp = await this.waitForResponse(requestId)
    return resp as ListAgentsResponse
  }

  /** 请求任务状态 */
  async getTaskStatus(taskId: string): Promise<TaskStatusResponse> {
    this.ensureConnected()
    const requestId = createRequestId()
    const msg: AgentToHubMessage = { type: "task_status", requestId, taskId }
    this.ws!.send(serialize(msg))
    const resp = await this.waitForResponse(requestId)
    return resp as TaskStatusResponse
  }

  /** 等待指定 requestId 的响应 */
  private waitForResponse(requestId: string): Promise<HubToAgentMessage> {
    return new Promise<HubToAgentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error(`请求超时: ${requestId}`))
      }, REQUEST_TIMEOUT_MS)

      this.pendingRequests.set(requestId, { resolve, reject, timer })
    })
  }

  /** 断言已连接 */
  private ensureConnected(): void {
    if (!this.connected || !this.ws) {
      throw new Error("未连接到 Hub")
    }
  }

  /** 拒绝所有等待中的请求 */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pendingRequests.clear()
  }

  /** 关闭连接 */
  close(): void {
    this.ws?.close()
    this.ws = null
    this.connected = false
    this.rejectAllPending("客户端主动关闭")
  }
}

import WebSocket from "ws"
import type {
  AgentToHubMessage,
  HubToAgentMessage,
  DaemonConfig,
} from "@ccchat/shared"
import { serialize, parseHubMessage } from "@ccchat/shared"

// 重连参数
const BASE_RETRY_MS = 1_000
const MAX_RETRY_MS = 30_000

export type MessageHandler = (msg: HubToAgentMessage) => void
export type ConnectionHandler = () => void

interface WsClientCallbacks {
  readonly onMessage: MessageHandler
  readonly onConnected?: ConnectionHandler
  readonly onDisconnected?: ConnectionHandler
}

interface WsClientState {
  readonly ws: WebSocket | null
  readonly retryCount: number
  readonly stopped: boolean
  readonly registered: boolean
}

/** 创建初始状态 */
function createInitialState(): WsClientState {
  return { ws: null, retryCount: 0, stopped: false, registered: false }
}

/** 计算重连延迟（指数退避） */
function calcRetryDelay(retryCount: number): number {
  const delay = BASE_RETRY_MS * Math.pow(2, retryCount)
  return Math.min(delay, MAX_RETRY_MS)
}

export interface WsClient {
  readonly connect: () => void
  readonly send: (msg: AgentToHubMessage) => void
  readonly close: () => void
  readonly isConnected: () => boolean
}

/** 创建 WebSocket 客户端 */
export function createWsClient(
  config: DaemonConfig,
  callbacks: WsClientCallbacks,
): WsClient {
  let state = createInitialState()

  /** 建立连接 */
  function connect(): void {
    if (state.stopped) return

    const ws = new WebSocket(config.hubUrl)

    ws.on("open", () => {
      state = { ...state, ws, retryCount: 0, registered: false }
      console.log(`已连接到 Hub: ${config.hubUrl}`)

      // 发送注册消息
      const registerMsg: AgentToHubMessage = {
        type: "register",
        agentName: config.agentName,
        token: config.token,
      }
      ws.send(serialize(registerMsg))
      callbacks.onConnected?.()
    })

    ws.on("message", (data) => {
      handleRawMessage(data)
    })

    ws.on("close", () => {
      const wasRegistered = state.registered
      state = { ...state, ws: null, registered: false }
      if (wasRegistered) {
        console.log("与 Hub 断开连接")
      }
      callbacks.onDisconnected?.()
      scheduleReconnect()
    })

    ws.on("error", (err) => {
      console.error("WebSocket 错误:", err.message)
    })
  }

  /** 处理原始消息 */
  function handleRawMessage(data: WebSocket.RawData): void {
    try {
      const msg = parseHubMessage(data.toString())
      handleMessage(msg)
    } catch (err) {
      console.error("消息解析失败:", err)
    }
  }

  /** 处理已解析的消息 */
  function handleMessage(msg: HubToAgentMessage): void {
    // 处理心跳
    if (msg.type === "ping") {
      sendRaw({ type: "pong" })
      return
    }

    // 处理注册确认
    if (msg.type === "register_ack") {
      if (msg.success) {
        state = { ...state, registered: true }
        console.log(`注册成功, Agent: ${config.agentName}`)
      } else {
        console.error(`注册失败: ${msg.error ?? "未知错误"}`)
      }
      return
    }

    // 其余消息交给外部处理
    callbacks.onMessage(msg)
  }

  /** 安排重连 */
  function scheduleReconnect(): void {
    if (state.stopped) return
    const delay = calcRetryDelay(state.retryCount)
    state = { ...state, retryCount: state.retryCount + 1 }
    console.log(`${delay}ms 后重连 (第 ${state.retryCount} 次)...`)
    setTimeout(connect, delay)
  }

  /** 发送原始消息 */
  function sendRaw(msg: AgentToHubMessage): void {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(serialize(msg))
    }
  }

  return {
    connect,
    send: sendRaw,
    close(): void {
      state = { ...state, stopped: true }
      state.ws?.close()
    },
    isConnected(): boolean {
      return state.ws?.readyState === WebSocket.OPEN && state.registered
    },
  }
}

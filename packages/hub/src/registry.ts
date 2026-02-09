import { randomBytes } from "node:crypto"
import type { WebSocket } from "ws"
import type { AgentInfo } from "@ccchat/shared"

// Agent 连接记录
interface AgentConnection {
  readonly ws: WebSocket
  readonly info: AgentInfo
}

// 已注册的 Agent 凭证（不一定在线）
interface AgentCredential {
  readonly agentName: string
  readonly token: string
  readonly telegramUserId: number
  readonly createdAt: string
}

// 注册表状态
interface RegistryState {
  readonly connections: ReadonlyMap<string, AgentConnection>
  readonly credentials: ReadonlyMap<string, AgentCredential>
  readonly tokenIndex: ReadonlyMap<string, string>
}

// 生成安全 token
function generateToken(): string {
  return `agt_${randomBytes(24).toString("base64url")}`
}

// 注册表 API
export interface Registry {
  // 凭证管理
  readonly issueToken: (agentName: string, telegramUserId: number) => string
  readonly refreshToken: (agentName: string, telegramUserId: number) => string | null
  readonly revokeToken: (agentName: string) => void
  readonly validateAgentToken: (agentName: string, token: string) => boolean
  readonly getCredential: (agentName: string) => AgentCredential | undefined

  // 连接管理
  readonly register: (agentName: string, ws: WebSocket) => AgentInfo
  readonly unregister: (agentName: string) => void
  readonly getConnection: (agentName: string) => AgentConnection | undefined
  readonly getAgentByWs: (ws: WebSocket) => string | undefined
  readonly listAgents: () => ReadonlyArray<AgentInfo>
  readonly updateLastSeen: (agentName: string) => void
  readonly isOnline: (agentName: string) => boolean

  // Telegram 绑定（从 credential 读取）
  readonly getTelegramUserId: (agentName: string) => number | undefined
}

export function createRegistry(): Registry {
  let state: RegistryState = {
    connections: new Map(),
    credentials: new Map(),
    tokenIndex: new Map(),
  }

  // 为 Agent 签发 token（首次注册）
  function issueToken(agentName: string, telegramUserId: number): string {
    // 如果已有凭证，先清理旧 token 索引
    const existing = state.credentials.get(agentName)
    if (existing) {
      const newIndex = new Map(state.tokenIndex)
      newIndex.delete(existing.token)
      state = { ...state, tokenIndex: newIndex }
    }

    const token = generateToken()
    const credential: AgentCredential = {
      agentName,
      token,
      telegramUserId,
      createdAt: new Date().toISOString(),
    }

    const newCredentials = new Map(state.credentials)
    newCredentials.set(agentName, credential)
    const newIndex = new Map(state.tokenIndex)
    newIndex.set(token, agentName)
    state = { ...state, credentials: newCredentials, tokenIndex: newIndex }

    return token
  }

  // 刷新 token（必须是本人）
  function refreshToken(agentName: string, telegramUserId: number): string | null {
    const existing = state.credentials.get(agentName)
    if (!existing || existing.telegramUserId !== telegramUserId) return null

    // 断开旧连接
    const conn = state.connections.get(agentName)
    if (conn) {
      conn.ws.close()
      unregister(agentName)
    }

    return issueToken(agentName, telegramUserId)
  }

  // 吊销 token
  function revokeToken(agentName: string): void {
    const existing = state.credentials.get(agentName)
    if (!existing) return

    // 断开连接
    const conn = state.connections.get(agentName)
    if (conn) {
      conn.ws.close()
      unregister(agentName)
    }

    const newCredentials = new Map(state.credentials)
    newCredentials.delete(agentName)
    const newIndex = new Map(state.tokenIndex)
    newIndex.delete(existing.token)
    state = { ...state, credentials: newCredentials, tokenIndex: newIndex }
  }

  // 验证 Agent 的 token
  function validateAgentToken(agentName: string, token: string): boolean {
    const credential = state.credentials.get(agentName)
    if (!credential) return false
    return credential.token === token
  }

  function getCredential(agentName: string): AgentCredential | undefined {
    return state.credentials.get(agentName)
  }

  // 连接管理
  function register(agentName: string, ws: WebSocket): AgentInfo {
    const credential = state.credentials.get(agentName)
    const now = new Date().toISOString()
    const info: AgentInfo = {
      name: agentName,
      status: "online",
      connectedAt: now,
      lastSeen: now,
      telegramUserId: credential?.telegramUserId,
    }
    const newConnections = new Map(state.connections)
    newConnections.set(agentName, { ws, info })
    state = { ...state, connections: newConnections }
    return info
  }

  function unregister(agentName: string): void {
    const newConnections = new Map(state.connections)
    newConnections.delete(agentName)
    state = { ...state, connections: newConnections }
  }

  function getConnection(agentName: string): AgentConnection | undefined {
    return state.connections.get(agentName)
  }

  function getAgentByWs(ws: WebSocket): string | undefined {
    for (const [name, conn] of state.connections) {
      if (conn.ws === ws) return name
    }
    return undefined
  }

  function listAgents(): ReadonlyArray<AgentInfo> {
    return Array.from(state.connections.values()).map((c) => c.info)
  }

  function updateLastSeen(agentName: string): void {
    const conn = state.connections.get(agentName)
    if (!conn) return
    const updatedInfo: AgentInfo = { ...conn.info, lastSeen: new Date().toISOString() }
    const newConnections = new Map(state.connections)
    newConnections.set(agentName, { ...conn, info: updatedInfo })
    state = { ...state, connections: newConnections }
  }

  function isOnline(agentName: string): boolean {
    return state.connections.has(agentName)
  }

  function getTelegramUserId(agentName: string): number | undefined {
    // 优先从 credential 读取（即使不在线也有）
    return state.credentials.get(agentName)?.telegramUserId
  }

  return {
    issueToken,
    refreshToken,
    revokeToken,
    validateAgentToken,
    getCredential,
    register,
    unregister,
    getConnection,
    getAgentByWs,
    listAgents,
    updateLastSeen,
    isOnline,
    getTelegramUserId,
  }
}

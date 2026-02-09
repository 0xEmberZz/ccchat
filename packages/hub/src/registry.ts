import type { WebSocket } from "ws"
import type { AgentInfo } from "@ccchat/shared"

// Agent 连接记录（不可变）
interface AgentConnection {
  readonly ws: WebSocket
  readonly info: AgentInfo
}

// Agent 注册表状态
interface RegistryState {
  readonly connections: ReadonlyMap<string, AgentConnection>
  readonly tokenToName: ReadonlyMap<string, string>
}

// 创建初始状态
function createInitialState(hubSecret: string): RegistryState {
  return {
    connections: new Map(),
    tokenToName: new Map(),
  }
}

// 注册表对外 API
export interface Registry {
  readonly validateToken: (token: string) => boolean
  readonly register: (agentName: string, ws: WebSocket) => AgentInfo
  readonly unregister: (agentName: string) => void
  readonly getConnection: (agentName: string) => AgentConnection | undefined
  readonly getAgentByWs: (ws: WebSocket) => string | undefined
  readonly listAgents: () => ReadonlyArray<AgentInfo>
  readonly updateLastSeen: (agentName: string) => void
  readonly isOnline: (agentName: string) => boolean
  readonly bindTelegramUser: (agentName: string, telegramUserId: number) => void
  readonly getTelegramUserId: (agentName: string) => number | undefined
}

// 创建注册表实例
export function createRegistry(hubSecret: string): Registry {
  let state: RegistryState = createInitialState(hubSecret)

  function validateToken(token: string): boolean {
    return token === hubSecret
  }

  function register(agentName: string, ws: WebSocket): AgentInfo {
    const now = new Date().toISOString()
    const info: AgentInfo = {
      name: agentName,
      status: "online",
      connectedAt: now,
      lastSeen: now,
    }
    const connection: AgentConnection = { ws, info }
    const newConnections = new Map(state.connections)
    newConnections.set(agentName, connection)
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
    const updatedInfo: AgentInfo = {
      ...conn.info,
      lastSeen: new Date().toISOString(),
    }
    const updatedConn: AgentConnection = { ...conn, info: updatedInfo }
    const newConnections = new Map(state.connections)
    newConnections.set(agentName, updatedConn)
    state = { ...state, connections: newConnections }
  }

  function isOnline(agentName: string): boolean {
    return state.connections.has(agentName)
  }

  function bindTelegramUser(agentName: string, telegramUserId: number): void {
    const conn = state.connections.get(agentName)
    if (!conn) return
    const updatedInfo: AgentInfo = { ...conn.info, telegramUserId }
    const updatedConn: AgentConnection = { ...conn, info: updatedInfo }
    const newConnections = new Map(state.connections)
    newConnections.set(agentName, updatedConn)
    state = { ...state, connections: newConnections }
  }

  function getTelegramUserId(agentName: string): number | undefined {
    return state.connections.get(agentName)?.info.telegramUserId
  }

  return {
    validateToken,
    register,
    unregister,
    getConnection,
    getAgentByWs,
    listAgents,
    updateLastSeen,
    isOnline,
    bindTelegramUser,
    getTelegramUserId,
  }
}

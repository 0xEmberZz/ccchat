// Agent 运行时状态（纯内存）
interface AgentStatus {
  readonly runningTasks: number
  readonly totalCompleted: number
  readonly currentTaskId?: string
  readonly idleSince?: string
}

interface StoreState {
  readonly statuses: ReadonlyMap<string, AgentStatus>
}

export interface AgentStatusStore {
  readonly update: (agentName: string, report: {
    readonly runningTasks: number
    readonly currentTaskId?: string
    readonly idleSince?: string
  }) => void
  readonly incrementCompleted: (agentName: string) => void
  readonly get: (agentName: string) => AgentStatus | undefined
  readonly remove: (agentName: string) => void
}

export function createAgentStatusStore(): AgentStatusStore {
  let state: StoreState = { statuses: new Map() }

  return {
    update(agentName, report) {
      const existing = state.statuses.get(agentName)
      const updated: AgentStatus = {
        runningTasks: report.runningTasks,
        totalCompleted: existing?.totalCompleted ?? 0,
        currentTaskId: report.currentTaskId,
        idleSince: report.idleSince,
      }
      const newStatuses = new Map(state.statuses)
      newStatuses.set(agentName, updated)
      state = { statuses: newStatuses }
    },

    incrementCompleted(agentName) {
      const existing = state.statuses.get(agentName)
      if (!existing) return
      const updated: AgentStatus = {
        ...existing,
        totalCompleted: existing.totalCompleted + 1,
      }
      const newStatuses = new Map(state.statuses)
      newStatuses.set(agentName, updated)
      state = { statuses: newStatuses }
    },

    get(agentName) {
      return state.statuses.get(agentName)
    },

    remove(agentName) {
      const newStatuses = new Map(state.statuses)
      newStatuses.delete(agentName)
      state = { statuses: newStatuses }
    },
  }
}

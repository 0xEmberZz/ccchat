import type { TaskInfo } from "@ccchat/shared"
import { randomUUID } from "node:crypto"

// 任务队列状态
interface TaskQueueState {
  readonly tasks: ReadonlyMap<string, TaskInfo>
  readonly pendingByAgent: ReadonlyMap<string, ReadonlyArray<string>>
}

// 创建任务的参数
interface CreateTaskParams {
  readonly from: string
  readonly to: string
  readonly content: string
  readonly chatId: number
  readonly messageId: number
}

// 任务队列对外 API
export interface TaskQueue {
  readonly createTask: (params: CreateTaskParams) => TaskInfo
  readonly getTask: (taskId: string) => TaskInfo | undefined
  readonly updateStatus: (
    taskId: string,
    status: TaskInfo["status"],
    result?: string,
  ) => TaskInfo | undefined
  readonly getPendingTasks: (agentName: string) => ReadonlyArray<TaskInfo>
  readonly removePending: (agentName: string, taskId: string) => void
}

// 创建任务队列实例
export function createTaskQueue(): TaskQueue {
  let state: TaskQueueState = {
    tasks: new Map(),
    pendingByAgent: new Map(),
  }

  function createTask(params: CreateTaskParams): TaskInfo {
    const taskId = randomUUID()
    const task: TaskInfo = {
      taskId,
      from: params.from,
      to: params.to,
      content: params.content,
      status: "pending",
      createdAt: new Date().toISOString(),
      chatId: params.chatId,
      messageId: params.messageId,
    }
    const newTasks = new Map(state.tasks)
    newTasks.set(taskId, task)
    state = { ...state, tasks: newTasks }
    return task
  }

  function getTask(taskId: string): TaskInfo | undefined {
    return state.tasks.get(taskId)
  }

  function updateStatus(
    taskId: string,
    status: TaskInfo["status"],
    result?: string,
  ): TaskInfo | undefined {
    const existing = state.tasks.get(taskId)
    if (!existing) return undefined

    const isCompleted = status === "completed" || status === "failed"
    const updated: TaskInfo = {
      ...existing,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(isCompleted ? { completedAt: new Date().toISOString() } : {}),
    }
    const newTasks = new Map(state.tasks)
    newTasks.set(taskId, updated)
    state = { ...state, tasks: newTasks }
    return updated
  }

  function addPending(agentName: string, taskId: string): void {
    const existing = state.pendingByAgent.get(agentName) ?? []
    const newPending = new Map(state.pendingByAgent)
    newPending.set(agentName, [...existing, taskId])
    state = { ...state, pendingByAgent: newPending }
  }

  function getPendingTasks(agentName: string): ReadonlyArray<TaskInfo> {
    const taskIds = state.pendingByAgent.get(agentName) ?? []
    return taskIds
      .map((id) => state.tasks.get(id))
      .filter((t): t is TaskInfo => t !== undefined)
  }

  function removePending(agentName: string, taskId: string): void {
    const existing = state.pendingByAgent.get(agentName) ?? []
    const filtered = existing.filter((id) => id !== taskId)
    const newPending = new Map(state.pendingByAgent)
    newPending.set(agentName, filtered)
    state = { ...state, pendingByAgent: newPending }
  }

  return {
    createTask: (params: CreateTaskParams) => {
      const task = createTask(params)
      addPending(params.to, task.taskId)
      return task
    },
    getTask,
    updateStatus,
    getPendingTasks,
    removePending,
  }
}

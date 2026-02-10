import type { TaskInfo, TaskAttachment } from "@ccchat/shared"
import { randomUUID } from "node:crypto"
import type { TaskRepo } from "./db/index.js"

// 任务队列状态
interface TaskQueueState {
  readonly tasks: ReadonlyMap<string, TaskInfo>
  readonly pendingByAgent: ReadonlyMap<string, ReadonlyArray<string>>
  // 对话索引
  readonly tasksByConversation: ReadonlyMap<string, ReadonlyArray<string>>
  readonly taskByResultMessageId: ReadonlyMap<number, string>
}

// 创建任务的参数
interface CreateTaskParams {
  readonly from: string
  readonly to: string
  readonly content: string
  readonly chatId: number
  readonly messageId: number
  readonly conversationId?: string
  readonly parentTaskId?: string
}

// 活跃对话信息
export interface ActiveConversation {
  readonly conversationId: string
  readonly agentName: string
  readonly turnCount: number
  readonly lastActiveAt: string
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
  // 多轮对话
  readonly getTasksByConversation: (conversationId: string) => ReadonlyArray<TaskInfo>
  readonly findTaskByResultMessageId: (messageId: number) => TaskInfo | undefined
  readonly setResultMessageId: (taskId: string, messageId: number) => void
  readonly updateChatInfo: (taskId: string, chatId: number, messageId: number) => void
  // 对话生命周期
  readonly closeConversation: (conversationId: string) => void
  readonly isConversationClosed: (conversationId: string) => boolean
  readonly getActiveConversations: () => ReadonlyArray<ActiveConversation>
  // 历史查询
  readonly getRecentTasks: (options?: {
    readonly agentName?: string
    readonly limit?: number
  }) => Promise<ReadonlyArray<TaskInfo>>
  // 附件
  readonly setAttachments: (taskId: string, attachments: ReadonlyArray<TaskAttachment>) => void
  readonly getAttachments: (taskId: string) => ReadonlyArray<TaskAttachment> | undefined
  readonly clearAttachments: (taskId: string) => void
  // 持久化
  readonly loadFromRepo: () => Promise<void>
  // 清理
  readonly stop: () => void
}

export interface TaskQueueOptions {
  readonly taskRepo?: TaskRepo
  /** 对话超时自动关闭（毫秒），默认 30 分钟 */
  readonly conversationTimeout?: number
  /** 对话超时关闭时的回调 */
  readonly onConversationClosed?: (conversationId: string, lastTask: TaskInfo) => void
}

// 创建任务队列实例
export function createTaskQueue(options?: TaskQueueOptions): TaskQueue {
  const repo = options?.taskRepo
  const conversationTimeout = options?.conversationTimeout ?? 30 * 60 * 1000
  const closedConversations = new Set<string>()
  const lastActivityByConversation = new Map<string, number>()
  const attachments = new Map<string, ReadonlyArray<TaskAttachment>>()

  let state: TaskQueueState = {
    tasks: new Map(),
    pendingByAgent: new Map(),
    tasksByConversation: new Map(),
    taskByResultMessageId: new Map(),
  }

  // 异步持久化（返回 Promise 供需要顺序依赖的场景 await）
  function persistTask(task: TaskInfo): Promise<void> {
    if (!repo) return Promise.resolve()
    return repo.save(task).catch((err) => {
      process.stderr.write(`DB task save failed: ${err}\n`)
    })
  }

  function persistTaskUpdate(task: TaskInfo): void {
    if (!repo) return
    repo.update(task).catch((err) => {
      process.stderr.write(`DB task update failed: ${err}\n`)
    })
  }

  function persistPendingAdd(agentName: string, taskId: string): Promise<void> {
    if (!repo) return Promise.resolve()
    return repo.savePending(agentName, taskId).catch((err) => {
      process.stderr.write(`DB pending save failed: ${err}\n`)
    })
  }

  function persistPendingRemove(agentName: string, taskId: string): void {
    if (!repo) return
    repo.removePending(agentName, taskId).catch((err) => {
      process.stderr.write(`DB pending remove failed: ${err}\n`)
    })
  }

  // 内部索引维护
  function indexConversation(task: TaskInfo): void {
    if (!task.conversationId) return
    const existing = state.tasksByConversation.get(task.conversationId) ?? []
    const newIndex = new Map(state.tasksByConversation)
    newIndex.set(task.conversationId, [...existing, task.taskId])
    state = { ...state, tasksByConversation: newIndex }
    lastActivityByConversation.set(task.conversationId, Date.now())
  }

  function indexResultMessageId(taskId: string, msgId: number): void {
    const newIndex = new Map(state.taskByResultMessageId)
    newIndex.set(msgId, taskId)
    state = { ...state, taskByResultMessageId: newIndex }
  }

  // 从 DB 加载
  async function loadFromRepo(): Promise<void> {
    if (!repo) return
    const { tasks, pending } = await repo.loadAll()

    const newTasks = new Map(state.tasks)
    const newConvIndex = new Map(state.tasksByConversation)
    const newResultMsgIndex = new Map(state.taskByResultMessageId)

    for (const task of tasks) {
      newTasks.set(task.taskId, task)
      if (task.conversationId) {
        const list = newConvIndex.get(task.conversationId) ?? []
        newConvIndex.set(task.conversationId, [...list, task.taskId])
      }
      if (task.resultMessageId) {
        newResultMsgIndex.set(task.resultMessageId, task.taskId)
      }
    }

    const newPending = new Map(state.pendingByAgent)
    for (const [agentName, taskIds] of pending) {
      newPending.set(agentName, taskIds)
    }

    state = {
      tasks: newTasks,
      pendingByAgent: newPending,
      tasksByConversation: newConvIndex,
      taskByResultMessageId: newResultMsgIndex,
    }
    process.stdout.write(`Loaded ${tasks.length} tasks from DB\n`)
  }

  function createTask(params: CreateTaskParams): { readonly task: TaskInfo; readonly persisted: Promise<void> } {
    const taskId = randomUUID()
    const conversationId = params.conversationId ?? randomUUID()
    const task: TaskInfo = {
      taskId,
      from: params.from,
      to: params.to,
      content: params.content,
      status: "pending",
      createdAt: new Date().toISOString(),
      chatId: params.chatId,
      messageId: params.messageId,
      conversationId,
      parentTaskId: params.parentTaskId,
    }
    const newTasks = new Map(state.tasks)
    newTasks.set(taskId, task)
    state = { ...state, tasks: newTasks }
    indexConversation(task)
    const persisted = persistTask(task)
    return { task, persisted }
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

    const isCompleted = status === "completed" || status === "failed" || status === "cancelled"
    const isTerminal = isCompleted || status === "rejected"
    const updated: TaskInfo = {
      ...existing,
      status,
      ...(result !== undefined ? { result } : {}),
      ...(isCompleted ? { completedAt: new Date().toISOString() } : {}),
    }
    const newTasks = new Map(state.tasks)
    newTasks.set(taskId, updated)
    state = { ...state, tasks: newTasks }
    persistTaskUpdate(updated)
    if (isTerminal) {
      attachments.delete(taskId)
    }
    if (isCompleted && existing.conversationId) {
      lastActivityByConversation.set(existing.conversationId, Date.now())
    }
    return updated
  }

  function addPending(agentName: string, taskId: string, afterPersist?: Promise<void>): void {
    const existing = state.pendingByAgent.get(agentName) ?? []
    const newPending = new Map(state.pendingByAgent)
    newPending.set(agentName, [...existing, taskId])
    state = { ...state, pendingByAgent: newPending }
    // 等 task 写入 DB 后再写 pending（外键依赖）
    if (afterPersist) {
      afterPersist.then(() => persistPendingAdd(agentName, taskId))
    } else {
      persistPendingAdd(agentName, taskId)
    }
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
    persistPendingRemove(agentName, taskId)
  }

  function getTasksByConversation(conversationId: string): ReadonlyArray<TaskInfo> {
    const taskIds = state.tasksByConversation.get(conversationId) ?? []
    return taskIds
      .map((id) => state.tasks.get(id))
      .filter((t): t is TaskInfo => t !== undefined)
  }

  function findTaskByResultMessageId(messageId: number): TaskInfo | undefined {
    const taskId = state.taskByResultMessageId.get(messageId)
    if (!taskId) return undefined
    return state.tasks.get(taskId)
  }

  function setResultMessageId(taskId: string, messageId: number): void {
    const task = state.tasks.get(taskId)
    if (!task) return
    const updated: TaskInfo = { ...task, resultMessageId: messageId }
    const newTasks = new Map(state.tasks)
    newTasks.set(taskId, updated)
    state = { ...state, tasks: newTasks }
    indexResultMessageId(taskId, messageId)
    persistTaskUpdate(updated)
  }

  function updateChatInfo(taskId: string, chatId: number, messageId: number): void {
    const task = state.tasks.get(taskId)
    if (!task) return
    const updated: TaskInfo = { ...task, chatId, messageId }
    const newTasks = new Map(state.tasks)
    newTasks.set(taskId, updated)
    state = { ...state, tasks: newTasks }
    persistTaskUpdate(updated)
  }

  function closeConversation(conversationId: string): void {
    closedConversations.add(conversationId)
  }

  function isConversationClosed(conversationId: string): boolean {
    return closedConversations.has(conversationId)
  }

  function getActiveConversations(): ReadonlyArray<ActiveConversation> {
    const convMap = new Map<string, { agentName: string; turnCount: number; lastActiveAt: string }>()

    for (const [convId, taskIds] of state.tasksByConversation) {
      if (closedConversations.has(convId)) continue

      const tasks = taskIds
        .map((id) => state.tasks.get(id))
        .filter((t): t is TaskInfo => t !== undefined)

      if (tasks.length === 0) continue

      const lastTask = tasks.reduce((latest, t) =>
        new Date(t.createdAt).getTime() > new Date(latest.createdAt).getTime() ? t : latest
      )

      convMap.set(convId, {
        agentName: lastTask.to,
        turnCount: tasks.length,
        lastActiveAt: lastTask.createdAt,
      })
    }

    return Array.from(convMap.entries())
      .map(([conversationId, info]) => ({ conversationId, ...info }))
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
  }

  async function getRecentTasks(options?: {
    readonly agentName?: string
    readonly limit?: number
  }): Promise<ReadonlyArray<TaskInfo>> {
    const limit = Math.min(options?.limit ?? 10, 20)
    // If we have a repo, query from DB for full history
    if (repo) {
      return repo.findRecent(options)
    }
    // Otherwise, return from in-memory state
    const allTasks = Array.from(state.tasks.values())
    const filtered = options?.agentName
      ? allTasks.filter((t) => t.to === options.agentName)
      : allTasks
    return filtered
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit)
  }

  function setAttachments(taskId: string, atts: ReadonlyArray<TaskAttachment>): void {
    attachments.set(taskId, atts)
  }

  function getAttachments(taskId: string): ReadonlyArray<TaskAttachment> | undefined {
    return attachments.get(taskId)
  }

  function clearAttachments(taskId: string): void {
    attachments.delete(taskId)
  }

  // 定时扫描超时对话（每分钟检查一次）
  const sweepInterval = setInterval(() => {
    const now = Date.now()
    for (const [convId, lastActive] of lastActivityByConversation) {
      if (closedConversations.has(convId)) {
        lastActivityByConversation.delete(convId)
        continue
      }
      if (now - lastActive >= conversationTimeout) {
        closedConversations.add(convId)
        lastActivityByConversation.delete(convId)
        // 找到对话中最后一个任务，通知回调
        const taskIds = state.tasksByConversation.get(convId) ?? []
        const lastTask = taskIds
          .map((id) => state.tasks.get(id))
          .filter((t): t is TaskInfo => t !== undefined)
          .at(-1)
        if (lastTask && options?.onConversationClosed) {
          options.onConversationClosed(convId, lastTask)
        }
      }
    }
  }, 60_000)
  sweepInterval.unref()

  return {
    createTask: (params: CreateTaskParams) => {
      const { task, persisted } = createTask(params)
      addPending(params.to, task.taskId, persisted)
      return task
    },
    getTask,
    updateStatus,
    getPendingTasks,
    removePending,
    getTasksByConversation,
    findTaskByResultMessageId,
    setResultMessageId,
    updateChatInfo,
    closeConversation,
    isConversationClosed,
    getActiveConversations,
    getRecentTasks,
    setAttachments,
    getAttachments,
    clearAttachments,
    loadFromRepo,
    stop: () => clearInterval(sweepInterval),
  }
}

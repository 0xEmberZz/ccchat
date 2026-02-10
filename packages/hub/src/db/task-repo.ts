import type { TaskInfo } from "@ccchat/shared"
import type { DbPool } from "./connection.js"

export interface TaskRepo {
  readonly save: (task: TaskInfo) => Promise<void>
  readonly findById: (taskId: string) => Promise<TaskInfo | undefined>
  readonly update: (task: TaskInfo) => Promise<void>
  readonly savePending: (agentName: string, taskId: string) => Promise<void>
  readonly removePending: (agentName: string, taskId: string) => Promise<void>
  readonly loadAll: () => Promise<{
    readonly tasks: ReadonlyArray<TaskInfo>
    readonly pending: ReadonlyMap<string, ReadonlyArray<string>>
  }>
  readonly findRecent: (options?: {
    readonly agentName?: string
    readonly limit?: number
  }) => Promise<ReadonlyArray<TaskInfo>>
}

function rowToTask(row: Record<string, unknown>): TaskInfo {
  return {
    taskId: row.task_id as string,
    from: row.from_user as string,
    to: row.to_agent as string,
    content: row.content as string,
    status: row.status as TaskInfo["status"],
    result: (row.result as string) ?? undefined,
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
    chatId: Number(row.chat_id),
    messageId: Number(row.message_id),
    conversationId: (row.conversation_id as string) ?? undefined,
    parentTaskId: (row.parent_task_id as string) ?? undefined,
    resultMessageId: row.result_message_id
      ? Number(row.result_message_id)
      : undefined,
  }
}

export function createTaskRepo(pool: DbPool): TaskRepo {
  return {
    async save(task: TaskInfo): Promise<void> {
      await pool.query(
        `INSERT INTO tasks (task_id, from_user, to_agent, content, status, result, created_at, completed_at, chat_id, message_id, conversation_id, parent_task_id, result_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (task_id) DO UPDATE
         SET status = EXCLUDED.status,
             result = EXCLUDED.result,
             completed_at = EXCLUDED.completed_at,
             result_message_id = EXCLUDED.result_message_id`,
        [
          task.taskId,
          task.from,
          task.to,
          task.content,
          task.status,
          task.result ?? null,
          task.createdAt,
          task.completedAt ?? null,
          task.chatId,
          task.messageId,
          task.conversationId ?? null,
          task.parentTaskId ?? null,
          task.resultMessageId ?? null,
        ],
      )
    },

    async findById(taskId: string): Promise<TaskInfo | undefined> {
      const { rows } = await pool.query(
        "SELECT * FROM tasks WHERE task_id = $1",
        [taskId],
      )
      if (rows.length === 0) return undefined
      return rowToTask(rows[0])
    },

    async update(task: TaskInfo): Promise<void> {
      await pool.query(
        `UPDATE tasks SET status = $2, result = $3, completed_at = $4, result_message_id = $5
         WHERE task_id = $1`,
        [
          task.taskId,
          task.status,
          task.result ?? null,
          task.completedAt ?? null,
          task.resultMessageId ?? null,
        ],
      )
    },

    async savePending(agentName: string, taskId: string): Promise<void> {
      await pool.query(
        `INSERT INTO pending_tasks (agent_name, task_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [agentName, taskId],
      )
    },

    async removePending(agentName: string, taskId: string): Promise<void> {
      await pool.query(
        "DELETE FROM pending_tasks WHERE agent_name = $1 AND task_id = $2",
        [agentName, taskId],
      )
    },

    async loadAll(): Promise<{
      readonly tasks: ReadonlyArray<TaskInfo>
      readonly pending: ReadonlyMap<string, ReadonlyArray<string>>
    }> {
      const { rows: taskRows } = await pool.query(
        "SELECT * FROM tasks WHERE status NOT IN ('completed', 'failed', 'rejected', 'cancelled')",
      )
      const tasks = taskRows.map(rowToTask)

      const { rows: pendingRows } = await pool.query(
        "SELECT agent_name, task_id FROM pending_tasks ORDER BY position",
      )
      const pending = new Map<string, string[]>()
      for (const row of pendingRows) {
        const agentName = row.agent_name as string
        const taskId = row.task_id as string
        const list = pending.get(agentName) ?? []
        list.push(taskId)
        pending.set(agentName, list)
      }

      return { tasks, pending }
    },

    async findRecent(options?: {
      readonly agentName?: string
      readonly limit?: number
    }): Promise<ReadonlyArray<TaskInfo>> {
      const limit = Math.min(options?.limit ?? 10, 20)
      if (options?.agentName) {
        const { rows } = await pool.query(
          "SELECT * FROM tasks WHERE to_agent = $1 ORDER BY created_at DESC LIMIT $2",
          [options.agentName, limit],
        )
        return rows.map(rowToTask)
      }
      const { rows } = await pool.query(
        "SELECT * FROM tasks ORDER BY created_at DESC LIMIT $1",
        [limit],
      )
      return rows.map(rowToTask)
    },
  }
}

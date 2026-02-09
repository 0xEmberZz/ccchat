import type { TaskInfo } from "@ccchat/shared"

const MAX_CONTEXT_CHARS = 8000
const MAX_TURNS = 5

interface ConversationTurn {
  readonly role: "用户" | "助手"
  readonly content: string
}

/** 从对话历史中构建上下文 */
export function buildConversationContext(
  tasks: ReadonlyArray<TaskInfo>,
  newMessage: string,
  maxTurns: number = MAX_TURNS,
): string {
  // 按创建时间排序，取最近 N 轮
  const sorted = [...tasks]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

  const turns: ConversationTurn[] = []
  for (const task of sorted) {
    turns.push({ role: "用户", content: task.content })
    if (task.result) {
      turns.push({ role: "助手", content: task.result })
    }
  }

  // 取最近的轮次
  const recentTurns = turns.slice(-maxTurns * 2)

  // 拼接为上下文字符串
  const contextParts: string[] = []
  let totalChars = 0

  // 从后往前，保证最近的对话完整
  const reversedTurns = [...recentTurns].reverse()
  const keptTurns: ConversationTurn[] = []

  for (const turn of reversedTurns) {
    const turnText = `[${turn.role}] ${turn.content}`
    if (totalChars + turnText.length > MAX_CONTEXT_CHARS) break
    totalChars += turnText.length
    keptTurns.unshift(turn)
  }

  for (const turn of keptTurns) {
    contextParts.push(`[${turn.role}] ${turn.content}`)
  }

  // 添加当前用户消息
  contextParts.push(`[用户] ${newMessage}`)

  return [
    "以下是多轮对话的上下文，请基于之前的对话继续回答：",
    "",
    ...contextParts,
    "",
    "请回答最新的用户消息。",
  ].join("\n")
}

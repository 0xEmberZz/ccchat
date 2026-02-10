export interface AgentInfo {
  readonly name: string
  readonly status: "online" | "offline" | "busy"
  readonly connectedAt: string
  readonly lastSeen: string
  readonly telegramUserId?: number
}

export interface TaskInfo {
  readonly taskId: string
  readonly from: string
  readonly to: string
  readonly content: string
  readonly status: "pending" | "awaiting_approval" | "approved" | "running" | "completed" | "failed" | "rejected" | "cancelled"
  readonly result?: string
  readonly createdAt: string
  readonly completedAt?: string
  readonly chatId: number
  readonly messageId: number
  readonly conversationId?: string
  readonly parentTaskId?: string
  readonly resultMessageId?: number
}

export interface TaskAttachment {
  readonly filename: string
  readonly mimeType: string
  readonly data: string  // base64
  readonly size: number
}

export interface DaemonConfig {
  readonly hubUrl: string
  readonly agentName: string
  readonly token: string
  readonly workDir: string
  readonly systemPrompt?: string
  readonly maxConcurrentTasks?: number
  readonly taskTimeout?: number
}

export interface HubConfig {
  readonly port: number
  readonly telegramBotToken: string
  readonly hubSecret: string
}

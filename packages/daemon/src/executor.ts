import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import type { DaemonConfig } from "@ccchat/shared"

interface ExecutionResult {
  readonly output: string
  readonly status: "success" | "error"
}

export interface ExecuteOptions {
  readonly conversationId?: string
  readonly parentTaskId?: string
  readonly onProgress?: (status: string, detail?: string) => void
}

export interface Executor {
  readonly execute: (taskId: string, taskContent: string, options?: ExecuteOptions) => Promise<ExecutionResult>
  readonly cancel: (taskId: string) => boolean
  readonly getRunningCount: () => number
  readonly getCurrentTaskId: () => string | undefined
  readonly getRunningTaskIds: () => ReadonlyArray<string>
  /** 优雅关闭：向所有运行中的子进程发送 SIGTERM，等待完成或超时后强制 kill */
  readonly shutdown: (timeoutMs?: number) => Promise<void>
}

/** 截取输出结果（限制长度避免 Telegram 消息过长） */
function extractResult(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (trimmed.length <= 4000) return trimmed
  return trimmed.slice(-4000)
}

/** 从 assistant message content blocks 提取可读状态 */
function extractStreamStatus(event: Record<string, unknown>): { status: string; detail?: string } | undefined {
  if (event.type !== "assistant") return undefined
  const message = event.message as Record<string, unknown> | undefined
  if (!message) return undefined
  const content = message.content as ReadonlyArray<Record<string, unknown>> | undefined
  if (!content || content.length === 0) return { status: "thinking" }

  for (const block of content) {
    if (block.type === "tool_use") {
      return { status: "tool_use", detail: block.name as string }
    }
  }
  for (const block of content) {
    if (block.type === "text") {
      return { status: "responding" }
    }
  }
  return { status: "thinking" }
}

/** 执行 Claude Code 命令 */
function runClaude(
  taskContent: string,
  config: DaemonConfig,
  options?: ExecuteOptions,
): { readonly child: ChildProcess; readonly result: Promise<ExecutionResult> } {
  const timeout = config.taskTimeout ?? 300_000
  const prompt = config.systemPrompt
    ? `[系统角色] ${config.systemPrompt}\n\n[任务] ${taskContent}`
    : taskContent
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"]

  // 多轮对话：使用 Claude 原生会话恢复
  if (options?.conversationId) {
    if (options.parentTaskId) {
      args.push("--resume", options.conversationId)
    } else {
      args.push("--session-id", options.conversationId)
    }
  }

  const child = spawn("claude", args, {
    cwd: config.workDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const result = new Promise<ExecutionResult>((resolve) => {
    let resultText = ""
    let fallbackText = ""
    let stderr = ""
    let settled = false

    function settle(res: ExecutionResult): void {
      if (settled) return
      settled = true
      resolve(res)
    }

    // 逐行解析 NDJSON stream
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on("line", (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>
          if (event.type === "result") {
            const raw = event.result
            resultText = typeof raw === "string"
              ? raw
              : raw != null ? JSON.stringify(raw) : ""
          } else if (event.type === "assistant") {
            // 收集 assistant text 作为 fallback
            const message = event.message as Record<string, unknown> | undefined
            const content = message?.content as ReadonlyArray<Record<string, unknown>> | undefined
            if (content) {
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                  fallbackText = block.text
                }
              }
            }
            // 通知进度
            const statusInfo = extractStreamStatus(event)
            if (statusInfo && options?.onProgress) {
              options.onProgress(statusInfo.status, statusInfo.detail)
            }
          }
        } catch {
          // 非 JSON 行忽略
        }
      })
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // 超时控制（使用 settled 标志防止与 close 事件竞态）
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      settle({ output: `任务超时 (${timeout}ms)`, status: "error" })
    }, timeout)

    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        const existing = resultText || fallbackText
        settle({
          output: existing ? `${extractResult(existing)}\n\n(任务被取消)` : "任务已取消",
          status: "error",
        })
      } else if (code === 0) {
        const output = resultText || fallbackText
        settle({
          output: extractResult(output) || "(无输出)",
          status: "success",
        })
      } else {
        settle({
          output: extractResult(stderr || resultText || fallbackText) || `进程退出码: ${code}`,
          status: "error",
        })
      }
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      settle({ output: `执行失败: ${err.message}`, status: "error" })
    })
  })

  return { child, result }
}

/** 创建执行器（含并发控制、取消支持和优雅关闭） */
export function createExecutor(config: DaemonConfig): Executor {
  const maxConcurrent = config.maxConcurrentTasks ?? 1
  const runningTasks = new Map<string, ChildProcess>()
  const executionPromises = new Map<string, Promise<ExecutionResult>>()

  return {
    async execute(taskId: string, taskContent: string, options?: ExecuteOptions): Promise<ExecutionResult> {
      if (runningTasks.size >= maxConcurrent) {
        return {
          output: `并发上限 (${maxConcurrent})，请稍后重试`,
          status: "error",
        }
      }

      if (options?.conversationId) {
        const mode = options.parentTaskId ? "--resume" : "--session-id"
        process.stdout.write(`会话模式: ${mode} ${options.conversationId}\n`)
      }

      const { child, result } = runClaude(taskContent, config, options)
      runningTasks.set(taskId, child)
      executionPromises.set(taskId, result)

      try {
        const execResult = await result
        return execResult
      } finally {
        runningTasks.delete(taskId)
        executionPromises.delete(taskId)
      }
    },

    cancel(taskId: string): boolean {
      const child = runningTasks.get(taskId)
      if (!child) return false

      child.kill("SIGTERM")
      // 5 秒后强制 kill
      setTimeout(() => {
        if (runningTasks.has(taskId)) {
          child.kill("SIGKILL")
        }
      }, 5_000)
      return true
    },

    getRunningCount(): number {
      return runningTasks.size
    },

    getCurrentTaskId(): string | undefined {
      const entries = Array.from(runningTasks.keys())
      return entries[0]
    },

    getRunningTaskIds(): ReadonlyArray<string> {
      return Array.from(runningTasks.keys())
    },

    async shutdown(timeoutMs = 10_000): Promise<void> {
      if (runningTasks.size === 0) return
      process.stdout.write(`等待 ${runningTasks.size} 个运行中的任务完成...\n`)

      // 向所有子进程发送 SIGTERM
      for (const child of runningTasks.values()) {
        child.kill("SIGTERM")
      }

      // 等待所有执行 Promise 完成或超时
      const pending = Array.from(executionPromises.values())
      const timer = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
      await Promise.race([
        Promise.allSettled(pending),
        timer,
      ])

      // 超时后强制 kill 仍在运行的进程
      for (const child of runningTasks.values()) {
        child.kill("SIGKILL")
      }
    },
  }
}

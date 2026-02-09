import { spawn, type ChildProcess } from "node:child_process"
import type { DaemonConfig } from "@ccchat/shared"

interface ExecutionResult {
  readonly output: string
  readonly status: "success" | "error"
}

export interface Executor {
  readonly execute: (taskId: string, taskContent: string) => Promise<ExecutionResult>
  readonly cancel: (taskId: string) => boolean
  readonly getRunningCount: () => number
  readonly getCurrentTaskId: () => string | undefined
  readonly getRunningTaskIds: () => ReadonlyArray<string>
}

/** 截取输出结果（限制长度避免 Telegram 消息过长） */
function extractResult(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (trimmed.length <= 4000) return trimmed
  return trimmed.slice(-4000)
}

/** 执行 Claude Code 命令 */
function runClaude(
  taskContent: string,
  config: DaemonConfig,
): { readonly child: ChildProcess; readonly result: Promise<ExecutionResult> } {
  const timeout = config.taskTimeout ?? 300_000
  // 如果有 systemPrompt，拼接到任务内容前面
  const prompt = config.systemPrompt
    ? `[系统角色] ${config.systemPrompt}\n\n[任务] ${taskContent}`
    : taskContent
  const args = ["-p", prompt, "--output-format", "text"]

  const child = spawn("claude", args, {
    cwd: config.workDir,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  })

  const result = new Promise<ExecutionResult>((resolve) => {
    let stdout = ""
    let stderr = ""

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // 超时控制
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      resolve({
        output: `任务超时 (${timeout}ms)`,
        status: "error",
      })
    }, timeout)

    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        // 可能是取消或超时
        const existing = stdout.trim()
        resolve({
          output: existing ? `${extractResult(existing)}\n\n(任务被取消)` : "任务已取消",
          status: "error",
        })
      } else if (code === 0) {
        resolve({
          output: extractResult(stdout) || "(无输出)",
          status: "success",
        })
      } else {
        resolve({
          output: extractResult(stderr || stdout) || `进程退出码: ${code}`,
          status: "error",
        })
      }
    })

    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({
        output: `执行失败: ${err.message}`,
        status: "error",
      })
    })
  })

  return { child, result }
}

/** 创建执行器（含并发控制和取消支持） */
export function createExecutor(config: DaemonConfig): Executor {
  const maxConcurrent = config.maxConcurrentTasks ?? 1
  const runningTasks = new Map<string, ChildProcess>()

  return {
    async execute(taskId: string, taskContent: string): Promise<ExecutionResult> {
      if (runningTasks.size >= maxConcurrent) {
        return {
          output: `并发上限 (${maxConcurrent})，请稍后重试`,
          status: "error",
        }
      }

      const { child, result } = runClaude(taskContent, config)
      runningTasks.set(taskId, child)

      try {
        const execResult = await result
        return execResult
      } finally {
        runningTasks.delete(taskId)
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
  }
}

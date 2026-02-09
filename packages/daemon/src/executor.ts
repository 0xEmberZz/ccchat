import { spawn } from "node:child_process"
import type { DaemonConfig } from "@ccchat/shared"

interface ExecutionResult {
  readonly output: string
  readonly status: "success" | "error"
}

interface ExecutorState {
  readonly runningCount: number
}

export interface Executor {
  readonly execute: (taskContent: string) => Promise<ExecutionResult>
  readonly getRunningCount: () => number
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
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
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

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on("data", (chunk: Buffer) => {
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

    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
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
}

/** 创建执行器（含并发控制） */
export function createExecutor(config: DaemonConfig): Executor {
  let state: ExecutorState = { runningCount: 0 }
  const maxConcurrent = config.maxConcurrentTasks ?? 1

  return {
    async execute(taskContent: string): Promise<ExecutionResult> {
      if (state.runningCount >= maxConcurrent) {
        return {
          output: `并发上限 (${maxConcurrent})，请稍后重试`,
          status: "error",
        }
      }

      state = { runningCount: state.runningCount + 1 }
      try {
        const result = await runClaude(taskContent, config)
        return result
      } finally {
        state = { runningCount: state.runningCount - 1 }
      }
    },
    getRunningCount(): number {
      return state.runningCount
    },
  }
}

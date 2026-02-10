#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import type { HubToAgentMessage, TaskMessage, DaemonConfig, AgentToHubMessage } from "@ccchat/shared"
import { loadConfig, initConfig, getConfigPath } from "./config.js"
import { createWsClient } from "./ws-client.js"
import { createExecutor, type Executor } from "./executor.js"

/** 处理任务消息 */
async function handleTask(
  task: TaskMessage,
  config: DaemonConfig,
  send: (msg: AgentToHubMessage) => void,
  executor: Executor,
): Promise<void> {
  process.stdout.write(`收到任务 [${task.taskId}] 来自 ${task.from}: ${task.content.slice(0, 80)}\n`)

  const startTime = Date.now()

  // 保存附件到本地
  let content = task.content
  if (task.attachments && task.attachments.length > 0) {
    const attachDir = join(config.workDir, ".ccchat-attachments", task.taskId.slice(0, 8))
    await mkdir(attachDir, { recursive: true })
    const paths: string[] = []
    for (const att of task.attachments) {
      const safeName = basename(att.filename).replace(/[^\w.\-]/g, "_") || "attachment"
      const filePath = join(attachDir, safeName)
      await writeFile(filePath, Buffer.from(att.data, "base64"))
      paths.push(filePath)
      process.stdout.write(`附件已保存: ${filePath} (${att.size} bytes)\n`)
    }
    content = `${content}\n\n[附件文件]\n${paths.map((p) => `- ${p}`).join("\n")}`
  }

  const result = await executor.execute(task.taskId, content, {
    conversationId: task.conversationId,
    parentTaskId: task.parentTaskId,
    onProgress: (status, detail) => {
      send({
        type: "task_progress",
        taskId: task.taskId,
        status,
        detail,
        elapsedMs: Date.now() - startTime,
      })
    },
  })

  send({
    type: "task_result",
    taskId: task.taskId,
    result: result.output,
    status: result.status,
  })

  process.stdout.write(`任务 [${task.taskId}] 完成: ${result.status}\n`)
}

/** 处理取消任务消息 */
function handleCancelTask(
  taskId: string,
  send: (msg: AgentToHubMessage) => void,
  executor: Executor,
): void {
  process.stdout.write(`收到取消请求: ${taskId}\n`)
  const cancelled = executor.cancel(taskId)
  if (cancelled) {
    send({ type: "task_cancelled", taskId })
    process.stdout.write(`任务 [${taskId}] 已取消\n`)
  } else {
    process.stdout.write(`任务 [${taskId}] 未在运行，无法取消\n`)
  }
}

/** 启动 daemon */
async function startDaemon(): Promise<void> {
  const config = loadConfig()
  if (!config) {
    process.stderr.write("未找到配置文件，请先运行: ccchat init\n")
    process.exit(1)
  }

  process.stdout.write(`启动 CCChat Daemon...\n`)
  process.stdout.write(`Agent: ${config.agentName}\n`)
  process.stdout.write(`Hub: ${config.hubUrl}\n`)
  process.stdout.write(`工作目录: ${config.workDir}\n`)

  const executor = createExecutor(config)
  let idleSince: string | undefined = new Date().toISOString()

  const client = createWsClient(config, {
    onMessage(msg: HubToAgentMessage): void {
      if (msg.type === "task") {
        idleSince = undefined
        handleTask(msg, config, client.send, executor)
          .then(() => {
            if (executor.getRunningCount() === 0) {
              idleSince = new Date().toISOString()
            }
          })
          .catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err)
            process.stderr.write(`Task execution failed: ${errMsg}\n`)
          })
      } else if (msg.type === "cancel_task") {
        handleCancelTask(msg.taskId, client.send, executor)
      }
    },
    onPing(): void {
      // 每次收到 ping 时附带发送状态报告
      client.send({
        type: "status_report",
        runningTasks: executor.getRunningCount(),
        currentTaskId: executor.getCurrentTaskId(),
        idleSince,
      })
    },
  })

  // 优雅退出
  function shutdown(): void {
    process.stdout.write("\n正在退出...\n")
    client.close()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  client.connect()
}

/** 显示连接状态 */
function showStatus(): void {
  const config = loadConfig()
  if (!config) {
    process.stdout.write("状态: 未配置\n")
    process.stdout.write(`配置文件: ${getConfigPath()} (不存在)\n`)
    return
  }

  process.stdout.write("--- CCChat 状态 ---\n")
  process.stdout.write(`配置文件: ${getConfigPath()}\n`)
  process.stdout.write(`Agent: ${config.agentName}\n`)
  process.stdout.write(`Hub: ${config.hubUrl}\n`)
  process.stdout.write(`工作目录: ${config.workDir}\n`)
  process.stdout.write(`最大并发: ${config.maxConcurrentTasks ?? 1}\n`)
  process.stdout.write(`任务超时: ${(config.taskTimeout ?? 300_000) / 1000}s\n`)
}

/** 打印帮助信息 */
function printHelp(): void {
  process.stdout.write(`CCChat - 跨主机 Claude Code 协作工具

用法:
  ccchat start    启动 daemon 进程
  ccchat init     初始化配置
  ccchat status   显示当前状态
  ccchat help     显示帮助信息
`)
}

/** 解析命令行并执行 */
async function main(): Promise<void> {
  const command = process.argv[2] ?? "help"

  switch (command) {
    case "start":
      await startDaemon()
      break
    case "init":
      await initConfig()
      break
    case "status":
      showStatus()
      break
    case "help":
    case "--help":
    case "-h":
      printHelp()
      break
    default:
      process.stderr.write(`未知命令: ${command}\n`)
      printHelp()
      process.exit(1)
  }
}

main().catch((err: Error) => {
  process.stderr.write(`致命错误: ${err.message}\n`)
  process.exit(1)
})

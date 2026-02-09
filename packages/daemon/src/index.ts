#!/usr/bin/env node

import type { HubToAgentMessage, TaskMessage, DaemonConfig } from "@ccchat/shared"
import { loadConfig, initConfig, getConfigPath } from "./config.js"
import { createWsClient } from "./ws-client.js"
import { createExecutor } from "./executor.js"

/** 处理任务消息 */
async function handleTask(
  task: TaskMessage,
  config: DaemonConfig,
  send: (msg: import("@ccchat/shared").AgentToHubMessage) => void,
  executor: ReturnType<typeof createExecutor>,
): Promise<void> {
  console.log(`收到任务 [${task.taskId}] 来自 ${task.from}: ${task.content.slice(0, 80)}`)

  const result = await executor.execute(task.content)

  send({
    type: "task_result",
    taskId: task.taskId,
    result: result.output,
    status: result.status,
  })

  console.log(`任务 [${task.taskId}] 完成: ${result.status}`)
}

/** 启动 daemon */
async function startDaemon(): Promise<void> {
  const config = loadConfig()
  if (!config) {
    console.error("未找到配置文件，请先运行: ccchat init")
    process.exit(1)
  }

  console.log(`启动 CCChat Daemon...`)
  console.log(`Agent: ${config.agentName}`)
  console.log(`Hub: ${config.hubUrl}`)
  console.log(`工作目录: ${config.workDir}`)

  const executor = createExecutor(config)

  const client = createWsClient(config, {
    onMessage(msg: HubToAgentMessage): void {
      if (msg.type === "task") {
        handleTask(msg, config, client.send, executor)
      }
    },
  })

  // 优雅退出
  function shutdown(): void {
    console.log("\n正在退出...")
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
    console.log("状态: 未配置")
    console.log(`配置文件: ${getConfigPath()} (不存在)`)
    return
  }

  console.log("--- CCChat 状态 ---")
  console.log(`配置文件: ${getConfigPath()}`)
  console.log(`Agent: ${config.agentName}`)
  console.log(`Hub: ${config.hubUrl}`)
  console.log(`工作目录: ${config.workDir}`)
  console.log(`最大并发: ${config.maxConcurrentTasks ?? 1}`)
  console.log(`任务超时: ${(config.taskTimeout ?? 300_000) / 1000}s`)
}

/** 打印帮助信息 */
function printHelp(): void {
  console.log(`
CCChat - 跨主机 Claude Code 协作工具

用法:
  ccchat start    启动 daemon 进程
  ccchat init     初始化配置
  ccchat status   显示当前状态
  ccchat help     显示帮助信息
`.trim())
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
      console.error(`未知命令: ${command}`)
      printHelp()
      process.exit(1)
  }
}

main().catch((err: Error) => {
  console.error("致命错误:", err.message)
  process.exit(1)
})

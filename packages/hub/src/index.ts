#!/usr/bin/env node

import { createServer } from "node:http"
import { config } from "dotenv"
import { createRegistry } from "./registry.js"
import { createTaskQueue } from "./task-queue.js"
import { createWsServer } from "./ws-server.js"
import { createBot } from "./bot.js"
import {
  createPool,
  runMigrations,
  createCredentialRepo,
  createFileCredentialRepo,
  createTaskRepo,
  type DbPool,
} from "./db/index.js"
import { createAgentStatusStore } from "./agent-status-store.js"
import { createApiHandler, onApiTaskCreated } from "./api.js"

// 加载环境变量
config()

// 从环境变量读取配置
function loadConfig(): { readonly port: number; readonly telegramBotToken: string; readonly hubUrl?: string; readonly databaseUrl?: string; readonly telegramChatId?: number } {
  const port = parseInt(process.env.PORT ?? process.env.HUB_PORT ?? "9900", 10)
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? ""
  const hubUrl = process.env.HUB_URL
  const databaseUrl = process.env.DATABASE_URL
  const telegramChatId = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID, 10) : undefined

  if (!telegramBotToken) {
    throw new Error("环境变量 TELEGRAM_BOT_TOKEN 未设置")
  }

  return { port, telegramBotToken, hubUrl, databaseUrl, telegramChatId }
}

// 全局错误捕获
process.on("uncaughtException", (err) => {
  process.stderr.write(`[FATAL] uncaughtException: ${err.stack ?? err.message}\n`)
})
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[FATAL] unhandledRejection: ${reason}\n`)
})

// 主启动函数
async function main(): Promise<void> {
  const hubConfig = loadConfig()

  // 初始化数据库（可选）
  let pool: DbPool | undefined
  let credentialRepo
  let taskRepo

  if (hubConfig.databaseUrl) {
    process.stdout.write("检测到 DATABASE_URL，启用 Postgres 持久化\n")
    pool = createPool(hubConfig.databaseUrl)
    await runMigrations(pool)
    credentialRepo = createCredentialRepo(pool)
    taskRepo = createTaskRepo(pool)
  } else {
    process.stdout.write("未设置 DATABASE_URL，使用文件备份凭证\n")
    credentialRepo = createFileCredentialRepo()
  }

  // 创建核心模块
  const registry = createRegistry({ credentialRepo })
  const taskQueue = createTaskQueue({ taskRepo })
  const agentStatusStore = createAgentStatusStore()

  // 从持久化层加载数据
  await registry.loadFromRepo()
  if (pool) {
    await taskQueue.loadFromRepo()
  }

  const apiHandler = createApiHandler({ registry, taskQueue })
  let botRef: ReturnType<typeof createBot> | undefined
  const httpServer = createServer((req, res) => {
    const url = req.url ?? "/"
    // Webhook 路由：Telegram POST /webhook
    if (url === "/webhook" && req.method === "POST" && botRef) {
      botRef.handleWebhook(req, res).catch(() => {
        res.writeHead(500)
        res.end()
      })
      return
    }
    apiHandler(req, res)
  })
  const wsServer = createWsServer(httpServer, registry, taskQueue, agentStatusStore)
  const bot = createBot(
    hubConfig.telegramBotToken,
    registry,
    taskQueue,
    wsServer,
    hubConfig.hubUrl,
    agentStatusStore,
    hubConfig.telegramChatId,
    pool,
  )
  botRef = bot

  // 优雅退出
  function shutdown(): void {
    process.stdout.write("正在关闭服务...\n")
    bot.stop()
    wsServer.close()
    httpServer.close(() => {
      if (pool) {
        pool.end().then(() => {
          process.stdout.write("数据库连接已关闭\n")
          process.exit(0)
        })
      } else {
        process.stdout.write("服务已关闭\n")
        process.exit(0)
      }
    })
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // 启动 HTTP + WebSocket 服务器
  httpServer.listen(hubConfig.port, () => {
    process.stdout.write(`Hub WebSocket 服务已启动，端口: ${hubConfig.port}\n`)
  })

  // 初始化 Bot（Webhook 模式，不会阻塞）
  await bot.start()
}

main().catch((err: unknown) => {
  process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})

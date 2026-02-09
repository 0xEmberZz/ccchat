#!/usr/bin/env node

import { createServer } from "node:http"
import { config } from "dotenv"
import { createRegistry } from "./registry.js"
import { createTaskQueue } from "./task-queue.js"
import { createWsServer } from "./ws-server.js"
import { createBot } from "./bot.js"

// 加载环境变量
config()

// 从环境变量读取配置
function loadConfig(): { readonly port: number; readonly telegramBotToken: string } {
  const port = parseInt(process.env.PORT ?? process.env.HUB_PORT ?? "9900", 10)
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? ""

  if (!telegramBotToken) {
    throw new Error("环境变量 TELEGRAM_BOT_TOKEN 未设置")
  }

  return { port, telegramBotToken }
}

// 主启动函数
async function main(): Promise<void> {
  const hubConfig = loadConfig()

  // 创建核心模块
  const registry = createRegistry()
  const taskQueue = createTaskQueue()
  const httpServer = createServer()
  const wsServer = createWsServer(httpServer, registry, taskQueue)
  const bot = createBot(
    hubConfig.telegramBotToken,
    registry,
    taskQueue,
    wsServer,
  )

  // 优雅退出（必须在 bot.start 前注册）
  function shutdown(): void {
    process.stdout.write("正在关闭服务...\n")
    bot.stop()
    wsServer.close()
    httpServer.close(() => {
      process.stdout.write("服务已关闭\n")
      process.exit(0)
    })
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // 启动 HTTP + WebSocket 服务器
  httpServer.listen(hubConfig.port, () => {
    process.stdout.write(`Hub WebSocket 服务已启动，端口: ${hubConfig.port}\n`)
  })

  // 启动 Telegram Bot（带重试，处理滚动部署冲突）
  await startBotWithRetry(bot, 5, 5_000)
}

// Bot 启动重试（处理 409 Conflict）
async function startBotWithRetry(
  bot: { readonly start: () => Promise<void> },
  maxRetries: number,
  delayMs: number,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      process.stdout.write(`Telegram Bot 启动中... (${attempt}/${maxRetries})\n`)
      await bot.start()
      return
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes("409") && attempt < maxRetries) {
        process.stdout.write(`Bot 冲突，${delayMs / 1000}s 后重试...\n`)
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      throw err
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`启动失败: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})

import { Bot, InlineKeyboard } from "grammy"
import type { TaskMessage } from "@ccchat/shared"
import type { Registry } from "./registry.js"
import type { TaskQueue } from "./task-queue.js"
import type { WsServer } from "./ws-server.js"

// 广播通知到所有活跃群组
async function broadcastNotification(
  bot: Bot,
  chatIds: ReadonlySet<number>,
  text: string,
): Promise<void> {
  for (const chatId of chatIds) {
    try {
      await bot.api.sendMessage(chatId, text)
    } catch {
      // 发送失败时静默处理
    }
  }
}

// 解析 @mention 结果
interface MentionParseResult {
  readonly agentName: string
  readonly content: string
}

// Bot 对外 API
export interface TelegramBot {
  readonly start: () => Promise<void>
  readonly stop: () => void
}

// 解析 @agentname 消息
function parseMention(text: string): MentionParseResult | undefined {
  const match = text.match(/^@(\w+)\s+(.+)$/s)
  if (!match) return undefined
  return { agentName: match[1], content: match[2].trim() }
}

// 将任务分发给 Agent
function dispatchTaskToAgent(
  task: { readonly taskId: string; readonly from: string; readonly content: string; readonly chatId: number; readonly messageId: number },
  agentName: string,
  wsServer: WsServer,
  taskQueue: TaskQueue,
): boolean {
  const taskMsg: TaskMessage = {
    type: "task",
    taskId: task.taskId,
    from: task.from,
    content: task.content,
    chatId: task.chatId,
    messageId: task.messageId,
  }
  const sent = wsServer.sendToAgent(agentName, taskMsg)
  if (sent) {
    taskQueue.removePending(agentName, task.taskId)
    taskQueue.updateStatus(task.taskId, "running")
  }
  return sent
}

// 创建 Telegram Bot
export function createBot(
  token: string,
  registry: Registry,
  taskQueue: TaskQueue,
  wsServer: WsServer,
): TelegramBot {
  const bot = new Bot(token)
  const activeChatIds = new Set<number>()

  // /register 命令：注册 Agent 并获取 token（必须私聊）
  bot.command("register", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("请私聊我使用 /register 命令，token 不能在群里暴露。")
      return
    }
    const agentName = ctx.match?.trim()
    if (!agentName || !/^\w+$/.test(agentName)) {
      await ctx.reply("用法: /register <agent名称>\n名称只能包含字母数字下划线\n示例: /register ember")
      return
    }
    const userId = ctx.from?.id
    if (!userId) return

    // 检查是否已被其他人注册
    const existing = registry.getCredential(agentName)
    if (existing && existing.telegramUserId !== userId) {
      await ctx.reply(`Agent "${agentName}" 已被其他人注册。请换一个名称。`)
      return
    }

    const newToken = registry.issueToken(agentName, userId)
    await ctx.reply(
      [
        `✅ Agent "${agentName}" 注册成功！`,
        ``,
        `你的 Token（请妥善保管）:`,
        `\`${newToken}\``,
        ``,
        `写入 ~/.ccchat/config.json:`,
        `\`\`\`json`,
        `{`,
        `  "hubUrl": "wss://<HUB_URL>",`,
        `  "agentName": "${agentName}",`,
        `  "token": "${newToken}",`,
        `  "workDir": "/your/project/dir"`,
        `}`,
        `\`\`\``,
        ``,
        `刷新 Token: /token refresh`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    )
  })

  // /token 命令：刷新 token（必须私聊）
  bot.command("token", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("请私聊我使用 /token 命令。")
      return
    }
    const sub = ctx.match?.trim()
    const userId = ctx.from?.id
    if (!userId) return

    if (sub === "refresh") {
      // 找到该用户拥有的 agent
      const agents = registry.listAgents()
      const credential = agents
        .map((a) => registry.getCredential(a.name))
        .find((c) => c?.telegramUserId === userId)

      if (!credential) {
        await ctx.reply("你还没有注册 Agent。请先使用 /register <名称>")
        return
      }

      const newToken = registry.refreshToken(credential.agentName, userId)
      if (!newToken) {
        await ctx.reply("刷新失败，请重新注册。")
        return
      }

      await ctx.reply(
        [
          `🔄 Token 已刷新！旧 Token 立即失效。`,
          ``,
          `新 Token:`,
          `\`${newToken}\``,
          ``,
          `请更新 ~/.ccchat/config.json 并重启 Daemon。`,
        ].join("\n"),
        { parse_mode: "Markdown" },
      )
    } else {
      await ctx.reply("用法: /token refresh")
    }
  })

  // /agents 命令：列出在线 Agent
  bot.command("agents", async (ctx) => {
    const agents = registry.listAgents()
    if (agents.length === 0) {
      await ctx.reply("当前没有在线的 Agent。")
      return
    }
    const lines = agents.map(
      (a) => `- ${a.name} (${a.status}) ${a.telegramUserId ? "已绑定" : "未绑定"}`,
    )
    await ctx.reply(`在线 Agent:\n${lines.join("\n")}`)
  })

  // /status 命令：查看任务状态
  bot.command("status", async (ctx) => {
    const taskId = ctx.match?.trim()
    if (!taskId) {
      await ctx.reply("用法: /status <taskId>")
      return
    }
    const task = taskQueue.getTask(taskId)
    if (!task) {
      await ctx.reply(`未找到任务: ${taskId}`)
      return
    }
    const lines = [
      `任务: ${task.taskId}`,
      `目标: ${task.to}`,
      `状态: ${task.status}`,
      `创建: ${task.createdAt}`,
      ...(task.result ? [`结果: ${task.result}`] : []),
      ...(task.completedAt ? [`完成: ${task.completedAt}`] : []),
    ]
    await ctx.reply(lines.join("\n"))
  })

  // 监听普通文本消息，解析 @mention
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      activeChatIds.add(ctx.chat.id)
    }
    const text = ctx.message.text
    const mention = parseMention(text)
    if (!mention) return

    const { agentName, content } = mention
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const from = ctx.from?.username ?? ctx.from?.first_name ?? "unknown"

    // 创建任务（状态为 awaiting_approval）
    const task = taskQueue.createTask({
      from,
      to: agentName,
      content,
      chatId,
      messageId,
    })
    taskQueue.updateStatus(task.taskId, "awaiting_approval")

    // 查找 Agent 绑定的 Telegram 用户
    const ownerTelegramId = registry.getTelegramUserId(agentName)

    if (ownerTelegramId) {
      // 有绑定用户 → 私聊发送审批请求
      const keyboard = new InlineKeyboard()
        .text("✅ 批准", `approve:${task.taskId}`)
        .text("❌ 拒绝", `reject:${task.taskId}`)

      const approvalText = [
        `📋 新任务待审批`,
        `来自: ${from}`,
        `内容: ${content.slice(0, 200)}${content.length > 200 ? "..." : ""}`,
        `ID: ${task.taskId}`,
      ].join("\n")

      try {
        await bot.api.sendMessage(ownerTelegramId, approvalText, {
          reply_markup: keyboard,
        })
        await ctx.reply(`任务已提交，等待 ${agentName} 的主人审批。\nID: ${task.taskId}`, {
          reply_to_message_id: messageId,
        })
      } catch {
        // 私聊发送失败（用户未 /start bot），回退到群里发审批
        await sendGroupApproval(ctx, task, agentName, from, content, messageId)
      }
    } else {
      // 未绑定用户 → 在群里发审批按钮
      await sendGroupApproval(ctx, task, agentName, from, content, messageId)
    }
  })

  // 在群里发送审批按钮（未绑定时的回退方案）
  async function sendGroupApproval(
    ctx: { readonly reply: (text: string, opts?: object) => Promise<unknown> },
    task: { readonly taskId: string },
    agentName: string,
    from: string,
    content: string,
    messageId: number,
  ): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("✅ 批准", `approve:${task.taskId}`)
      .text("❌ 拒绝", `reject:${task.taskId}`)

    await ctx.reply(
      `📋 任务待审批 → ${agentName}\n来自: ${from}\n内容: ${content.slice(0, 200)}\n\n${agentName} 的主人请点击按钮:`,
      { reply_to_message_id: messageId, reply_markup: keyboard },
    )
  }

  // 处理审批按钮回调
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data
    const userId = ctx.from.id

    if (data.startsWith("approve:")) {
      const taskId = data.slice("approve:".length)
      const task = taskQueue.getTask(taskId)
      if (!task) {
        await ctx.answerCallbackQuery({ text: "任务不存在" })
        return
      }

      if (task.status !== "awaiting_approval") {
        await ctx.answerCallbackQuery({ text: `任务已处理: ${task.status}` })
        return
      }

      // 验证是否是 Agent 主人（如果已绑定）
      const ownerTelegramId = registry.getTelegramUserId(task.to)
      if (ownerTelegramId && ownerTelegramId !== userId) {
        await ctx.answerCallbackQuery({ text: "只有 Agent 主人可以审批" })
        return
      }

      // 批准任务
      taskQueue.updateStatus(taskId, "approved")
      await ctx.answerCallbackQuery({ text: "✅ 已批准" })
      await ctx.editMessageText(`✅ 任务已批准 (${task.to})\nID: ${taskId}`)

      // 分发任务
      if (registry.isOnline(task.to)) {
        const sent = dispatchTaskToAgent(task, task.to, wsServer, taskQueue)
        if (sent) {
          try {
            await bot.api.sendMessage(task.chatId, `任务开始执行: ${task.to}\nID: ${taskId}`, {
              reply_to_message_id: task.messageId,
            })
          } catch { /* ignore */ }
        }
      }
      return
    }

    if (data.startsWith("reject:")) {
      const taskId = data.slice("reject:".length)
      const task = taskQueue.getTask(taskId)
      if (!task) {
        await ctx.answerCallbackQuery({ text: "任务不存在" })
        return
      }

      if (task.status !== "awaiting_approval") {
        await ctx.answerCallbackQuery({ text: `任务已处理: ${task.status}` })
        return
      }

      const ownerTelegramId = registry.getTelegramUserId(task.to)
      if (ownerTelegramId && ownerTelegramId !== userId) {
        await ctx.answerCallbackQuery({ text: "只有 Agent 主人可以审批" })
        return
      }

      taskQueue.updateStatus(taskId, "rejected")
      await ctx.answerCallbackQuery({ text: "❌ 已拒绝" })
      await ctx.editMessageText(`❌ 任务已拒绝 (${task.to})\nID: ${taskId}`)

      try {
        await bot.api.sendMessage(task.chatId, `任务被 ${task.to} 拒绝。\nID: ${taskId}`, {
          reply_to_message_id: task.messageId,
        })
      } catch { /* ignore */ }
      return
    }
  })

  // 上下线通知
  wsServer.onAgentOnline(async (agentName) => {
    await broadcastNotification(bot, activeChatIds, `[上线] ${agentName} 已连接`)
  })

  wsServer.onAgentOffline(async (agentName) => {
    await broadcastNotification(bot, activeChatIds, `[下线] ${agentName} 已断开`)
  })

  // 任务结果回调 → 回复到 Telegram
  wsServer.onTaskResult(async (taskId, result, status, chatId, messageId) => {
    const task = taskQueue.getTask(taskId)
    const statusLabel = status === "success" ? "完成" : "失败"
    const agentName = task?.to ?? "unknown"
    // 截断过长的结果
    const truncated = result.length > 3500
      ? result.slice(0, 3500) + "\n...(结果已截断)"
      : result
    const text = `[${statusLabel}] ${agentName} 的任务结果:\n\n${truncated}`
    try {
      await bot.api.sendMessage(chatId, text, {
        reply_to_message_id: messageId,
      })
    } catch { /* ignore */ }
  })

  return {
    start: async () => {
      await bot.start()
    },
    stop: () => {
      bot.stop()
    },
  }
}

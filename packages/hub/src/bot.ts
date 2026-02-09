import { Bot, InlineKeyboard } from "grammy"
import type { TaskMessage } from "@ccchat/shared"
import type { Registry } from "./registry.js"
import type { TaskQueue } from "./task-queue.js"
import type { WsServer } from "./ws-server.js"
import type { AgentStatusStore } from "./agent-status-store.js"
import { buildConversationContext } from "./conversation.js"
import { formatResult, formatResultPlain } from "./formatter.js"
import { createPaginator } from "./paginator.js"
import { onApiTaskCreated } from "./api.js"

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
  hubUrl?: string,
  agentStatusStore?: AgentStatusStore,
  defaultChatId?: number,
): TelegramBot {
  const bot = new Bot(token)
  bot.catch((err) => {
    process.stderr.write(`Bot 错误: ${err instanceof Error ? err.message : String(err)}\n`)
  })
  const activeChatIds = new Set<number>(defaultChatId ? [defaultChatId] : [])
  const paginator = createPaginator()

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
    const hubDisplay = hubUrl ?? "(请联系管理员获取 Hub 地址)"
    await ctx.reply(
      [
        `Agent "${agentName}" 注册成功！`,
        ``,
        `Token（请妥善保管）:`,
        newToken,
        ``,
        `写入 ~/.ccchat/config.json:`,
        `{`,
        `  "hubUrl": "${hubDisplay}",`,
        `  "agentName": "${agentName}",`,
        `  "token": "${newToken}",`,
        `  "workDir": "/your/project/dir"`,
        `}`,
        ``,
        `刷新 Token: /token refresh`,
      ].join("\n"),
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
      // 从所有凭证中找到该用户拥有的 agent（不限在线）
      const credential = registry.findCredentialByUserId(userId)

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
          `Token 已刷新！旧 Token 立即失效。`,
          ``,
          `新 Token:`,
          newToken,
          ``,
          `请更新 ~/.ccchat/config.json 并重启 Daemon。`,
        ].join("\n"),
      )
    } else {
      await ctx.reply("用法: /token refresh")
    }
  })

  // /agents 命令：列出在线 Agent（增强版）
  bot.command("agents", async (ctx) => {
    const agents = registry.listAgents()
    if (agents.length === 0) {
      await ctx.reply("当前没有在线的 Agent。")
      return
    }
    const lines = agents.map((a) => {
      const status = agentStatusStore?.get(a.name)
      const parts = [`- ${a.name} (${a.status})`]
      if (status) {
        parts.push(`  任务: ${status.runningTasks} 运行中`)
        parts.push(`  已完成: ${status.totalCompleted}`)
        if (status.idleSince) {
          const idleMs = Date.now() - new Date(status.idleSince).getTime()
          const idleSec = Math.floor(idleMs / 1000)
          if (idleSec > 60) {
            parts.push(`  空闲: ${Math.floor(idleSec / 60)}分钟`)
          } else {
            parts.push(`  空闲: ${idleSec}秒`)
          }
        }
      }
      return parts.join("\n")
    })
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

  // /cancel 命令：取消运行中的任务
  bot.command("cancel", async (ctx) => {
    const taskId = ctx.match?.trim()
    if (!taskId) {
      await ctx.reply("用法: /cancel <taskId>")
      return
    }
    const task = taskQueue.getTask(taskId)
    if (!task) {
      await ctx.reply(`未找到任务: ${taskId}`)
      return
    }
    if (task.status !== "running" && task.status !== "approved" && task.status !== "awaiting_approval") {
      await ctx.reply(`任务状态为 ${task.status}，无法取消。`)
      return
    }

    // 验证权限：只有 Agent 主人可以取消
    const userId = ctx.from?.id
    const ownerTelegramId = registry.getTelegramUserId(task.to)
    if (ownerTelegramId && userId !== ownerTelegramId) {
      await ctx.reply("只有 Agent 主人可以取消任务。")
      return
    }

    if (task.status === "running") {
      // 发送取消指令给 Agent
      const sent = wsServer.cancelTask(task.to, taskId)
      if (sent) {
        await ctx.reply(`已发送取消请求: ${taskId}`)
      } else {
        // Agent 离线，直接标记取消
        taskQueue.updateStatus(taskId, "cancelled")
        await ctx.reply(`Agent 离线，任务已直接取消: ${taskId}`)
      }
    } else {
      // 未开始运行的任务直接取消
      taskQueue.updateStatus(taskId, "cancelled")
      taskQueue.removePending(task.to, taskId)
      await ctx.reply(`任务已取消: ${taskId}`)
    }
  })

  // 监听普通文本消息，解析 @mention 或多轮对话回复
  bot.on("message:text", async (ctx) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      activeChatIds.add(ctx.chat.id)
    }
    const text = ctx.message.text
    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const from = ctx.from?.username ?? ctx.from?.first_name ?? "unknown"

    // 多轮对话：检查是否是回复任务结果消息
    const replyToMsg = ctx.message.reply_to_message
    if (replyToMsg) {
      const parentTask = taskQueue.findTaskByResultMessageId(replyToMsg.message_id)
      if (parentTask && parentTask.conversationId) {
        // 找到对话上下文，创建续轮任务
        const convTasks = taskQueue.getTasksByConversation(parentTask.conversationId)
        const contextContent = buildConversationContext(convTasks, text)

        const task = taskQueue.createTask({
          from,
          to: parentTask.to,
          content: contextContent,
          chatId,
          messageId,
          conversationId: parentTask.conversationId,
          parentTaskId: parentTask.taskId,
        })

        // 多轮对话自动批准（首轮已审批过）
        taskQueue.updateStatus(task.taskId, "approved")

        if (registry.isOnline(parentTask.to)) {
          const sent = dispatchTaskToAgent(task, parentTask.to, wsServer, taskQueue)
          if (sent) {
            await ctx.reply(`继续对话: ${parentTask.to}\nID: ${task.taskId}`, {
              reply_to_message_id: messageId,
            })
          }
        } else {
          await ctx.reply(`${parentTask.to} 离线，任务已排队等待。\nID: ${task.taskId}`, {
            reply_to_message_id: messageId,
          })
        }
        return
      }
    }

    // 普通 @mention 消息
    const mention = parseMention(text)
    if (!mention) return

    const { agentName, content } = mention

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

  // 处理审批按钮和翻页回调
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data
    const userId = ctx.from.id

    // 翻页处理
    if (data.startsWith("page:")) {
      const parts = data.split(":")
      const taskId = parts[1]
      const pageIndex = parseInt(parts[2], 10)
      const totalPages = paginator.getTotalPages(taskId)
      const pageContent = paginator.getPage(taskId, pageIndex)

      if (!pageContent || isNaN(pageIndex)) {
        await ctx.answerCallbackQuery({ text: "页面已过期" })
        return
      }

      const pageInfo = `\n\n📄 第 ${pageIndex + 1}/${totalPages} 页`
      const keyboard = new InlineKeyboard()
      if (pageIndex > 0) {
        keyboard.text("◀ 上一页", `page:${taskId}:${pageIndex - 1}`)
      }
      if (pageIndex < totalPages - 1) {
        keyboard.text("▶ 下一页", `page:${taskId}:${pageIndex + 1}`)
      }

      try {
        await ctx.editMessageText(pageContent + pageInfo, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        })
      } catch {
        // HTML 解析失败时去掉格式
        try {
          await ctx.editMessageText(pageContent + pageInfo, {
            reply_markup: keyboard,
          })
        } catch { /* ignore */ }
      }
      await ctx.answerCallbackQuery()
      return
    }

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
    agentStatusStore?.remove(agentName)
    await broadcastNotification(bot, activeChatIds, `[下线] ${agentName} 已断开`)
  })

  // 发送任务结果到指定 chat（带格式化和分页）
  async function sendTaskResult(
    taskId: string,
    agentName: string,
    result: string,
    status: "success" | "error",
    targetChatId: number,
    replyToMessageId?: number,
  ): Promise<void> {
    const formatted = formatResult(agentName, result, status)
    const pages = paginator.paginate(taskId, formatted)
    const replyOpt = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}

    if (pages.length <= 1) {
      try {
        const sentMsg = await bot.api.sendMessage(targetChatId, pages[0], {
          ...replyOpt,
          parse_mode: "HTML",
        })
        taskQueue.setResultMessageId(taskId, sentMsg.message_id)
      } catch {
        const plainText = formatResultPlain(agentName, result, status)
        const truncated = plainText.length > 4000
          ? plainText.slice(0, 4000) + "\n...(结果已截断)"
          : plainText
        const sentMsg = await bot.api.sendMessage(targetChatId, truncated, replyOpt)
        taskQueue.setResultMessageId(taskId, sentMsg.message_id)
      }
    } else {
      const pageInfo = `\n\n📄 第 1/${pages.length} 页`
      const keyboard = new InlineKeyboard()
        .text("▶ 下一页", `page:${taskId}:1`)

      try {
        const sentMsg = await bot.api.sendMessage(targetChatId, pages[0] + pageInfo, {
          ...replyOpt,
          parse_mode: "HTML",
          reply_markup: keyboard,
        })
        taskQueue.setResultMessageId(taskId, sentMsg.message_id)
      } catch {
        const plainText = formatResultPlain(agentName, result, status)
        const truncated = plainText.length > 4000
          ? plainText.slice(0, 4000) + "\n...(结果已截断)"
          : plainText
        const sentMsg = await bot.api.sendMessage(targetChatId, truncated, replyOpt)
        taskQueue.setResultMessageId(taskId, sentMsg.message_id)
      }
    }
  }

  // 任务结果回调 → 回复到 Telegram（带格式化和分页）
  wsServer.onTaskResult(async (taskId, result, status, chatId, messageId) => {
    const task = taskQueue.getTask(taskId)
    const agentName = task?.to ?? "unknown"

    try {
      if (chatId !== 0) {
        // 正常情况：发送到原聊天
        await sendTaskResult(taskId, agentName, result, status, chatId, messageId)
      } else {
        // chatId=0 说明是 API 提交且 Hub 重启后还没收到群消息
        // fallback: 发给 owner 私聊
        const ownerTelegramId = task ? registry.getTelegramUserId(task.to) : undefined
        if (ownerTelegramId) {
          await sendTaskResult(taskId, agentName, result, status, ownerTelegramId)
        }
        // 同时尝试发到群聊（如果此时已有 activeChatIds）
        const groupChatId = activeChatIds.values().next().value
        if (groupChatId !== undefined && groupChatId !== ownerTelegramId) {
          await sendTaskResult(taskId, agentName, result, status, groupChatId)
        }
      }
    } catch { /* ignore */ }
  })

  // 任务取消回调
  wsServer.onTaskCancelled(async (taskId, agentName) => {
    const task = taskQueue.getTask(taskId)
    if (!task) return
    try {
      await bot.api.sendMessage(task.chatId, `任务已取消: ${agentName}\nID: ${taskId}`, {
        reply_to_message_id: task.messageId,
      })
    } catch { /* ignore */ }
  })

  // API 任务创建 → 群聊通知 + 审批
  onApiTaskCreated(async (event) => {
    const keyboard = new InlineKeyboard()
      .text("✅ 批准", `approve:${event.taskId}`)
      .text("❌ 拒绝", `reject:${event.taskId}`)

    const approvalText = [
      `📋 新任务待审批 (API)`,
      `来自: ${event.from}`,
      `目标: ${event.to}`,
      `内容: ${event.content.slice(0, 200)}${event.content.length > 200 ? "..." : ""}`,
      `ID: ${event.taskId}`,
    ].join("\n")

    // 发送到群聊（取第一个活跃群）并回填 chatId
    const groupChatId = activeChatIds.values().next().value
    if (groupChatId !== undefined) {
      try {
        const sentMsg = await bot.api.sendMessage(groupChatId, approvalText, {
          reply_markup: keyboard,
        })
        taskQueue.updateChatInfo(event.taskId, groupChatId, sentMsg.message_id)
      } catch (err) {
        process.stderr.write(`API task group notification failed: ${err}\n`)
      }
    }

    // 同时私聊通知 Agent 主人
    try {
      await bot.api.sendMessage(event.ownerTelegramId, approvalText, {
        reply_markup: keyboard,
      })
    } catch (err) {
      process.stderr.write(`API task TG notification failed: ${err}\n`)
    }
  })

  return {
    start: async () => {
      await bot.api.setMyCommands([
        { command: "register", description: "注册 Agent 并获取 Token（私聊）" },
        { command: "token", description: "刷新 Token（私聊）" },
        { command: "agents", description: "查看在线 Agent 列表" },
        { command: "status", description: "查看任务状态" },
        { command: "cancel", description: "取消任务" },
      ])
      await bot.start()
    },
    stop: () => {
      bot.stop()
    },
  }
}

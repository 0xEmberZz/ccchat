import { Bot, InlineKeyboard, webhookCallback } from "grammy"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { TaskMessage, TaskAttachment } from "@ccchat/shared"
import type { Registry } from "./registry.js"
import type { TaskQueue } from "./task-queue.js"
import type { WsServer } from "./ws-server.js"
import type { AgentStatusStore } from "./agent-status-store.js"
// conversation.ts 不再使用 — 多轮对话改用 Claude 原生会话恢复
import { formatResult, formatResultPlain } from "./formatter.js"
import { createPaginator } from "./paginator.js"
import { onApiTaskCreated } from "./api.js"
import { createStatusPanel } from "./status-panel.js"
import type { DbPool } from "./db/connection.js"

// 解析 @mention 结果
interface MentionParseResult {
  readonly agentName: string
  readonly content: string
}

// Bot 对外 API
export interface TelegramBot {
  readonly start: () => Promise<void>
  readonly stop: () => void
  readonly handleWebhook: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

// 友好时间格式
function formatTimeAgo(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

// 格式化经过时间
function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return `${min}m${sec % 60}s`
}

// 解析 @agentname 消息（跳过 bot 自身用户名）
function parseMention(text: string, botUsername?: string): MentionParseResult | undefined {
  const match = text.match(/^@(\w+)\s+(.+)$/s)
  if (!match) return undefined
  // 如果第一个 @mention 是 bot 自身，跳过并解析下一个
  if (botUsername && match[1].toLowerCase() === botUsername.toLowerCase()) {
    const rest = match[2].trim()
    // rest 可能是 "agent_name content" 或 "@agent_name content"
    const innerMatch = rest.match(/^@?(\w+)\s+(.+)$/s)
    if (!innerMatch) return undefined
    return { agentName: innerMatch[1], content: innerMatch[2].trim() }
  }
  return { agentName: match[1], content: match[2].trim() }
}

// 将任务分发给 Agent（含附件传递）
function dispatchTaskToAgent(
  task: {
    readonly taskId: string
    readonly from: string
    readonly content: string
    readonly chatId: number
    readonly messageId: number
    readonly conversationId?: string
    readonly parentTaskId?: string
  },
  agentName: string,
  wsServer: WsServer,
  taskQueue: TaskQueue,
): boolean {
  const taskAttachments = taskQueue.getAttachments(task.taskId)
  const taskMsg: TaskMessage = {
    type: "task",
    taskId: task.taskId,
    from: task.from,
    content: task.content,
    chatId: task.chatId,
    messageId: task.messageId,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(taskAttachments ? { attachments: taskAttachments } : {}),
  }
  const sent = wsServer.sendToAgent(agentName, taskMsg)
  if (sent) {
    taskQueue.removePending(agentName, task.taskId)
    taskQueue.updateStatus(task.taskId, "running")
    taskQueue.clearAttachments(task.taskId)
  }
  return sent
}

// 给消息添加 reaction
async function addReaction(bot: Bot, chatId: number, messageId: number, emoji: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji } as any])
  } catch {
    // Reaction API 可能不可用（旧群组或权限不足），静默忽略
  }
}

// 下载 Telegram 文件（5MB 限制）
async function downloadTelegramFile(
  bot: Bot,
  fileId: string,
  botToken: string,
): Promise<{ readonly data: Buffer; readonly filePath: string } | undefined> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return undefined
    const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`
    const resp = await fetch(url)
    if (!resp.ok) return undefined
    const arrayBuf = await resp.arrayBuffer()
    const data = Buffer.from(arrayBuf)
    if (data.length > 5 * 1024 * 1024) return undefined
    return { data, filePath: file.file_path }
  } catch {
    return undefined
  }
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
  pool?: DbPool,
): TelegramBot {
  const bot = new Bot(token)
  bot.catch((err) => {
    process.stderr.write(`Bot 错误: ${err instanceof Error ? err.message : String(err)}\n`)
  })
  const activeChatIds = new Set<number>(defaultChatId ? [defaultChatId] : [])
  const paginator = createPaginator()
  const statusPanel = createStatusPanel(bot, registry, agentStatusStore, pool)

  // 进度消息状态（mutable cache）
  const progressState = new Map<string, {
    chatId: number
    replyToMsgId: number
    progressMsgId?: number
    lastUpdateAt: number
  }>()

  // 初始化进度追踪
  function initProgress(taskId: string, chatId: number, replyToMsgId: number): void {
    progressState.set(taskId, { chatId, replyToMsgId, lastUpdateAt: 0 })
  }

  // 清理进度消息
  async function cleanupProgress(taskId: string): Promise<void> {
    const pState = progressState.get(taskId)
    if (pState?.progressMsgId) {
      try {
        await bot.api.deleteMessage(pState.chatId, pState.progressMsgId)
      } catch {
        // 删除失败（权限不足等），fallback 编辑为完成状态
        try { await bot.api.editMessageText(pState.chatId, pState.progressMsgId, "✅ 完成") } catch { /* ignore */ }
      }
    }
    progressState.delete(taskId)
  }

  // 在群里发送审批按钮
  async function sendGroupApproval(
    chatId: number,
    task: { readonly taskId: string },
    agentName: string,
    from: string,
    content: string,
    messageId: number,
  ): Promise<void> {
    const keyboard = new InlineKeyboard()
      .text("✅ 批准", `approve:${task.taskId}`)
      .text("❌ 拒绝", `reject:${task.taskId}`)

    await bot.api.sendMessage(
      chatId,
      `📋 任务待审批 → ${agentName}\n来自: ${from}\n内容: ${content.slice(0, 200)}\n\n${agentName} 的主人请点击按钮:`,
      { reply_to_message_id: messageId, reply_markup: keyboard },
    )
  }

  // 处理新任务的公共函数（含自动审批逻辑）
  async function handleNewTask(params: {
    readonly agentName: string
    readonly content: string
    readonly chatId: number
    readonly messageId: number
    readonly from: string
    readonly senderId?: number
    readonly attachments?: ReadonlyArray<TaskAttachment>
  }): Promise<void> {
    const { agentName, content, chatId, messageId, from, senderId, attachments } = params

    await addReaction(bot, chatId, messageId, "👀")

    const task = taskQueue.createTask({
      from,
      to: agentName,
      content,
      chatId,
      messageId,
    })

    if (attachments && attachments.length > 0) {
      taskQueue.setAttachments(task.taskId, attachments)
    }

    const ownerTelegramId = registry.getTelegramUserId(agentName)

    // 自动审批：发送者是 Agent 主人
    if (ownerTelegramId && senderId === ownerTelegramId) {
      taskQueue.updateStatus(task.taskId, "approved")
      if (registry.isOnline(agentName)) {
        const sent = dispatchTaskToAgent(task, agentName, wsServer, taskQueue)
        if (sent) {
          await addReaction(bot, chatId, messageId, "🚀")
          initProgress(task.taskId, chatId, messageId)
          return
        }
      }
      try {
        await bot.api.sendMessage(chatId, `${agentName} 离线，任务已自动批准并排队等待。\nID: ${task.taskId}`, {
          reply_to_message_id: messageId,
        })
      } catch { /* ignore */ }
      return
    }

    // 非主人：走审批流程
    taskQueue.updateStatus(task.taskId, "awaiting_approval")

    if (ownerTelegramId) {
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
        await bot.api.sendMessage(chatId, `任务已提交，等待 ${agentName} 的主人审批。\nID: ${task.taskId}`, {
          reply_to_message_id: messageId,
        })
      } catch {
        await sendGroupApproval(chatId, task, agentName, from, content, messageId)
      }
    } else {
      await sendGroupApproval(chatId, task, agentName, from, content, messageId)
    }
  }

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

    const userId = ctx.from?.id
    const ownerTelegramId = registry.getTelegramUserId(task.to)
    if (ownerTelegramId && userId !== ownerTelegramId) {
      await ctx.reply("只有 Agent 主人可以取消任务。")
      return
    }

    if (task.status === "running") {
      const sent = wsServer.cancelTask(task.to, taskId)
      if (sent) {
        await ctx.reply(`已发送取消请求: ${taskId}`)
      } else {
        taskQueue.updateStatus(taskId, "cancelled")
        await ctx.reply(`Agent 离线，任务已直接取消: ${taskId}`)
      }
    } else {
      taskQueue.updateStatus(taskId, "cancelled")
      taskQueue.removePending(task.to, taskId)
      await ctx.reply(`任务已取消: ${taskId}`)
    }
  })

  // /sessions 命令：列出活跃对话
  bot.command("sessions", async (ctx) => {
    const conversations = taskQueue.getActiveConversations()
    if (conversations.length === 0) {
      await ctx.reply("当前没有活跃的对话。")
      return
    }

    const lines = conversations.slice(0, 15).map((conv) => {
      const timeAgo = formatTimeAgo(new Date(conv.lastActiveAt))
      return `- ${conv.agentName}: ${conv.turnCount} 轮 (${timeAgo})`
    })

    await ctx.reply(`活跃对话 (${conversations.length}):\n${lines.join("\n")}`)
  })

  // /history 命令：查看任务历史
  bot.command("history", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/)
    let agentName: string | undefined
    let limit = 10

    for (const arg of args) {
      if (!arg) continue
      const num = parseInt(arg, 10)
      if (!isNaN(num) && num > 0) {
        limit = Math.min(num, 20)
      } else {
        agentName = arg
      }
    }

    const tasks = await taskQueue.getRecentTasks({ agentName, limit })
    if (tasks.length === 0) {
      await ctx.reply(agentName ? `${agentName} 没有任务记录。` : "没有任务记录。")
      return
    }

    const statusEmoji: Record<string, string> = {
      completed: "✅",
      failed: "❌",
      running: "🔄",
      approved: "⏳",
      awaiting_approval: "🔔",
      pending: "📋",
      rejected: "🚫",
      cancelled: "⛔",
    }

    const lines = tasks.map((t) => {
      const emoji = statusEmoji[t.status] ?? "❓"
      const preview = t.content.slice(0, 40) + (t.content.length > 40 ? "..." : "")
      const time = formatTimeAgo(new Date(t.createdAt))
      return `${emoji} ${t.to}: ${preview}\n   ${time} | ${t.taskId.slice(0, 8)}`
    })

    const header = agentName ? `📜 ${agentName} 的任务历史:` : "📜 任务历史:"
    await ctx.reply(`${header}\n\n${lines.join("\n\n")}`)
  })

  // Inline Mode：在任意聊天中 @bot agent_name 任务内容
  bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query.trim()
    const agents = registry.listAgents()

    // 解析：agent名 + 可选任务内容
    const spaceIdx = query.indexOf(" ")
    const agentQuery = query
      ? (spaceIdx >= 0 ? query.slice(0, spaceIdx) : query).replace(/^@/, "")
      : ""
    const taskContent = spaceIdx >= 0 ? query.slice(spaceIdx + 1).trim() : ""
    const matched = agentQuery
      ? agents.filter((a) => a.name.toLowerCase().includes(agentQuery.toLowerCase()))
      : agents

    if (taskContent && matched.length > 0) {
      // 有完整任务内容 → 点击直接发送任务
      const results = matched.slice(0, 10).map((a, i) => ({
        type: "article" as const,
        id: String(i),
        title: `发送给 ${a.name}: ${taskContent.slice(0, 50)}`,
        description: "点击发送任务",
        input_message_content: {
          message_text: `@${a.name} ${taskContent}`,
        },
      }))
      await ctx.answerInlineQuery(results, { cache_time: 10 })
      return
    }

    // 没有任务内容 → 显示 agent 列表供参考，每个 agent 带 inline 按钮跳转
    const agentList = matched.slice(0, 10)
    if (agentList.length === 0) {
      await ctx.answerInlineQuery([{
        type: "article" as const,
        id: "0",
        title: "没有匹配的 Agent",
        description: "当前没有在线的 Agent",
        input_message_content: { message_text: "当前没有在线的 Agent" },
      }], { cache_time: 10 })
      return
    }

    const results = agentList.map((a, i) => ({
      type: "article" as const,
      id: String(i),
      title: `${a.name} (${a.status})`,
      description: `格式: ${a.name} 你的任务内容`,
      input_message_content: {
        message_text: `在线 Agent: ${agentList.map((x) => x.name).join(", ")}\n\n用法: @agent名 任务内容\n示例: @${agentList[0].name} 写一首诗`,
      },
      reply_markup: {
        inline_keyboard: [[{
          text: `📝 给 ${a.name} 发任务`,
          switch_inline_query_current_chat: `${a.name} `,
        }]],
      },
    }))
    await ctx.answerInlineQuery(results, { cache_time: 10 })
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
        // 检查对话是否已结束
        if (taskQueue.isConversationClosed(parentTask.conversationId)) {
          await ctx.reply("该对话已结束，请发新任务开始新对话。", {
            reply_to_message_id: messageId,
          })
          return
        }

        // 直接使用原始用户消息，不再拼接历史上下文
        // Claude 原生会话恢复会保持完整上下文窗口
        const convTasks = taskQueue.getTasksByConversation(parentTask.conversationId)
        const turnCount = convTasks.length + 1

        const task = taskQueue.createTask({
          from,
          to: parentTask.to,
          content: text,
          chatId,
          messageId,
          conversationId: parentTask.conversationId,
          parentTaskId: parentTask.taskId,
        })

        taskQueue.updateStatus(task.taskId, "approved")

        if (registry.isOnline(parentTask.to)) {
          const sent = dispatchTaskToAgent(task, parentTask.to, wsServer, taskQueue)
          if (sent) {
            await addReaction(bot, chatId, messageId, "👀")
            initProgress(task.taskId, chatId, messageId)
            await ctx.reply(`💬 对话 #${turnCount} → ${parentTask.to}\nID: ${task.taskId}`, {
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
    const mention = parseMention(text, bot.botInfo?.username)
    if (!mention) return

    await handleNewTask({
      agentName: mention.agentName,
      content: mention.content,
      chatId,
      messageId,
      from,
      senderId: ctx.from?.id,
    })
  })

  // 监听照片消息，解析 caption @mention
  bot.on("message:photo", async (ctx) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      activeChatIds.add(ctx.chat.id)
    }
    const caption = ctx.message.caption
    if (!caption) return

    const mention = parseMention(caption, bot.botInfo?.username)
    if (!mention) return

    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const from = ctx.from?.username ?? ctx.from?.first_name ?? "unknown"

    // 下载最大尺寸的照片
    const photos = ctx.message.photo
    const largest = photos[photos.length - 1]
    const downloaded = await downloadTelegramFile(bot, largest.file_id, token)
    if (!downloaded) {
      await ctx.reply("无法下载图片，请重试。", { reply_to_message_id: messageId })
      return
    }

    const filename = downloaded.filePath.split("/").pop() ?? "photo.jpg"
    const attachment: TaskAttachment = {
      filename,
      mimeType: "image/jpeg",
      data: downloaded.data.toString("base64"),
      size: downloaded.data.length,
    }

    await handleNewTask({
      agentName: mention.agentName,
      content: mention.content,
      chatId,
      messageId,
      from,
      senderId: ctx.from?.id,
      attachments: [attachment],
    })
  })

  // 监听文档消息，解析 caption @mention
  bot.on("message:document", async (ctx) => {
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
      activeChatIds.add(ctx.chat.id)
    }
    const caption = ctx.message.caption
    if (!caption) return

    const mention = parseMention(caption, bot.botInfo?.username)
    if (!mention) return

    const chatId = ctx.chat.id
    const messageId = ctx.message.message_id
    const from = ctx.from?.username ?? ctx.from?.first_name ?? "unknown"

    const doc = ctx.message.document
    const downloaded = await downloadTelegramFile(bot, doc.file_id, token)
    if (!downloaded) {
      await ctx.reply("无法下载文件，请重试。", { reply_to_message_id: messageId })
      return
    }

    const filename = doc.file_name ?? downloaded.filePath.split("/").pop() ?? "document"
    const attachment: TaskAttachment = {
      filename,
      mimeType: doc.mime_type ?? "application/octet-stream",
      data: downloaded.data.toString("base64"),
      size: downloaded.data.length,
    }

    await handleNewTask({
      agentName: mention.agentName,
      content: mention.content,
      chatId,
      messageId,
      from,
      senderId: ctx.from?.id,
      attachments: [attachment],
    })
  })

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
        await ctx.editMessageText(pageContent.text + pageInfo, {
          entities: pageContent.entities as Parameters<typeof ctx.editMessageText>[1] extends { entities?: infer E } ? E : never,
          reply_markup: keyboard,
        })
      } catch { /* ignore */ }
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

      const ownerTelegramId = registry.getTelegramUserId(task.to)
      if (ownerTelegramId && ownerTelegramId !== userId) {
        await ctx.answerCallbackQuery({ text: "只有 Agent 主人可以审批" })
        return
      }

      taskQueue.updateStatus(taskId, "approved")
      await ctx.answerCallbackQuery({ text: "✅ 已批准" })
      await ctx.editMessageText(`✅ 任务已批准 (${task.to})\nID: ${taskId}`)

      // 给原消息加 reaction
      if (task.chatId !== 0 && task.messageId !== 0) {
        await addReaction(bot, task.chatId, task.messageId, "🚀")
      }

      if (registry.isOnline(task.to)) {
        const sent = dispatchTaskToAgent(task, task.to, wsServer, taskQueue)
        if (sent) {
          initProgress(task.taskId, task.chatId, task.messageId)
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

      // 给原消息加 ❌ reaction
      if (task.chatId !== 0 && task.messageId !== 0) {
        await addReaction(bot, task.chatId, task.messageId, "👎")
      }

      try {
        await bot.api.sendMessage(task.chatId, `任务被 ${task.to} 拒绝。\nID: ${taskId}`, {
          reply_to_message_id: task.messageId,
        })
      } catch { /* ignore */ }
      return
    }

    // 结束对话
    if (data.startsWith("end_conv:")) {
      const conversationId = data.slice("end_conv:".length)
      if (taskQueue.isConversationClosed(conversationId)) {
        await ctx.answerCallbackQuery({ text: "对话已结束" })
        return
      }
      taskQueue.closeConversation(conversationId)
      await ctx.answerCallbackQuery({ text: "✅ 对话已结束" })
      try {
        await ctx.editMessageReplyMarkup({ reply_markup: undefined })
      } catch { /* ignore */ }
      return
    }
  })

  // 上下线 → 更新状态面板
  wsServer.onAgentOnline(() => {
    statusPanel.scheduleUpdate(activeChatIds)
  })

  wsServer.onAgentOffline((agentName) => {
    agentStatusStore?.remove(agentName)
    statusPanel.scheduleUpdate(activeChatIds)
    // 清理该 Agent 所有运行中任务的进度状态
    for (const [taskId, pState] of progressState) {
      const task = taskQueue.getTask(taskId)
      if (task && task.to === agentName) {
        if (pState.progressMsgId) {
          bot.api.deleteMessage(pState.chatId, pState.progressMsgId).catch(() => {})
        }
        progressState.delete(taskId)
      }
    }
  })

  // 实时进度反馈
  wsServer.onTaskProgress(async (taskId, status, detail, elapsedMs) => {
    const pState = progressState.get(taskId)
    if (!pState) return

    // 3 秒防抖
    if (Date.now() - pState.lastUpdateAt < 3000) return

    const elapsed = formatElapsed(elapsedMs)
    const statusMap: Record<string, string> = {
      thinking: "💭 思考中",
      tool_use: `🔧 ${detail ?? "使用工具"}`,
      responding: "✍️ 生成回复",
    }
    const statusText = statusMap[status] ?? `⏳ ${status}`
    const text = `${statusText}... (${elapsed})`

    try {
      if (pState.progressMsgId) {
        await bot.api.editMessageText(pState.chatId, pState.progressMsgId, text)
      } else {
        const sent = await bot.api.sendMessage(pState.chatId, text, {
          reply_to_message_id: pState.replyToMsgId,
        })
        pState.progressMsgId = sent.message_id
      }
      pState.lastUpdateAt = Date.now()
    } catch {
      // 编辑/发送失败静默忽略
    }
  })

  // 构建结果消息的 reply_markup（分页 + 结束对话按钮）
  function buildResultKeyboard(taskId: string, pageIndex: number, totalPages: number, conversationId?: string): InlineKeyboard {
    const keyboard = new InlineKeyboard()
    if (totalPages > 1) {
      if (pageIndex > 0) {
        keyboard.text("◀ 上一页", `page:${taskId}:${pageIndex - 1}`)
      }
      if (pageIndex < totalPages - 1) {
        keyboard.text("▶ 下一页", `page:${taskId}:${pageIndex + 1}`)
      }
    }
    if (conversationId) {
      keyboard.row().text("🔚 结束对话", `end_conv:${conversationId}`)
    }
    return keyboard
  }

  // 追加文本到 page（suffix 在 entities 之后，无需调整 offset）
  function appendToPage(page: { text: string; entities: ReadonlyArray<{ type: string; offset: number; length: number; url?: string; language?: string }> }, suffix: string) {
    return { text: page.text + suffix, entities: page.entities }
  }

  // 发送任务结果到指定 chat（带格式化和分页）
  async function sendTaskResult(
    taskId: string,
    agentName: string,
    result: string,
    status: "success" | "error",
    targetChatId: number,
    replyToMessageId?: number,
  ): Promise<void> {
    const task = taskQueue.getTask(taskId)
    const conversationId = task?.conversationId
    const formatted = formatResult(agentName, result, status)
    const pages = paginator.paginate(taskId, formatted.text, formatted.entities)
    const replyOpt = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}

    // 对话轮次信息
    const turnInfo = conversationId
      ? (() => {
          const convTasks = taskQueue.getTasksByConversation(conversationId)
          return convTasks.length > 1 ? `\n💬 对话 #${convTasks.length}` : ""
        })()
      : ""

    const firstPage = pages[0]
    const keyboard = buildResultKeyboard(taskId, 0, pages.length, conversationId)
    const hasKeyboard = conversationId !== undefined || pages.length > 1
    const suffix = (pages.length > 1 ? `\n\n📄 第 1/${pages.length} 页` : "") + turnInfo
    const msg = appendToPage(firstPage, suffix)

    try {
      const sentMsg = await bot.api.sendMessage(targetChatId, msg.text, {
        ...replyOpt,
        entities: msg.entities as Parameters<typeof bot.api.sendMessage>[2] extends { entities?: infer E } ? E : never,
        ...(hasKeyboard ? { reply_markup: keyboard } : {}),
      })
      taskQueue.setResultMessageId(taskId, sentMsg.message_id)
    } catch {
      // fallback: 纯文本无格式
      const plainText = formatResultPlain(agentName, result, status)
      const truncated = plainText.length > 4000
        ? plainText.slice(0, 4000) + "\n...(结果已截断)"
        : plainText
      const sentMsg = await bot.api.sendMessage(targetChatId, truncated + turnInfo, {
        ...replyOpt,
        ...(hasKeyboard ? { reply_markup: keyboard } : {}),
      })
      taskQueue.setResultMessageId(taskId, sentMsg.message_id)
    }

    // 任务完成后给原消息加 ✅ reaction
    if (replyToMessageId) {
      const emoji = status === "success" ? "✅" : "❌"
      await addReaction(bot, targetChatId, replyToMessageId, emoji)
    }
  }

  // 任务结果回调（含进度清理）
  wsServer.onTaskResult(async (taskId, result, status, chatId, messageId) => {
    await cleanupProgress(taskId)

    const task = taskQueue.getTask(taskId)
    const agentName = task?.to ?? "unknown"

    // 更新状态面板（任务完成）
    statusPanel.scheduleUpdate(activeChatIds)

    try {
      if (chatId !== 0) {
        await sendTaskResult(taskId, agentName, result, status, chatId, messageId)
      } else {
        const ownerTelegramId = task ? registry.getTelegramUserId(task.to) : undefined
        if (ownerTelegramId) {
          await sendTaskResult(taskId, agentName, result, status, ownerTelegramId)
        }
        const groupChatId = activeChatIds.values().next().value
        if (groupChatId !== undefined && groupChatId !== ownerTelegramId) {
          await sendTaskResult(taskId, agentName, result, status, groupChatId)
        }
      }
    } catch { /* ignore */ }
  })

  // 任务取消回调（含进度清理）
  wsServer.onTaskCancelled(async (taskId, agentName) => {
    await cleanupProgress(taskId)

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

    try {
      await bot.api.sendMessage(event.ownerTelegramId, approvalText, {
        reply_markup: keyboard,
      })
    } catch (err) {
      process.stderr.write(`API task TG notification failed: ${err}\n`)
    }
  })

  // Webhook handler（必须在所有 handler 注册之后创建）
  const handleUpdate = webhookCallback(bot, "http")

  return {
    start: async () => {
      // 0. 从数据库恢复 status panel 的 messageId
      await statusPanel.loadFromDb()

      // 1. 初始化 Bot（获取 bot info，注册 handler）
      await bot.init()

      // 2. 设置 Bot 命令菜单
      await bot.api.setMyCommands([
        { command: "register", description: "注册 Agent 并获取 Token（私聊）" },
        { command: "token", description: "刷新 Token（私聊）" },
        { command: "agents", description: "查看在线 Agent 列表" },
        { command: "status", description: "查看任务状态" },
        { command: "cancel", description: "取消任务" },
        { command: "sessions", description: "查看活跃对话" },
        { command: "history", description: "查看任务历史" },
      ])

      // 3. 设置 Bot 描述信息
      try {
        await bot.api.setMyDescription(
          "CCChat - 跨主机 Claude Code 协作工具。通过 Telegram 群组 @mention 给 AI Agent 派任务，支持审批、多轮对话、结果格式化。私聊我 /register 注册你的 Agent。",
        )
        await bot.api.setMyShortDescription(
          "跨主机 Claude Code 协作 | @mention 派任务 | 私聊 /register 注册",
        )
      } catch { /* 非关键操作 */ }

      // 4. 设置 Webhook
      if (!hubUrl) {
        throw new Error("HUB_URL 未设置，Webhook 模式需要公网 HTTPS 地址")
      }
      const webhookUrl = hubUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://") + "/webhook"
      await bot.api.setWebhook(webhookUrl, {
        allowed_updates: [
          "message",
          "callback_query",
          "inline_query",
          "my_chat_member",
        ],
      })
      process.stdout.write(`Telegram Bot Webhook 已设置: ${webhookUrl}\n`)
    },
    stop: () => {
      // Webhook 模式下 stop 不需要额外操作
      // 新实例启动时 setWebhook 会自动覆盖
    },
    handleWebhook: async (req: IncomingMessage, res: ServerResponse) => {
      await handleUpdate(req, res)
    },
  }
}

import type { Bot } from "grammy"
import type { Registry } from "./registry.js"
import type { AgentStatusStore } from "./agent-status-store.js"
import type { DbPool } from "./db/connection.js"

/** 格式化空闲时间 */
function formatIdleTime(idleSince: string): string {
  const ms = Date.now() - new Date(idleSince).getTime()
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟`
  const hr = Math.floor(min / 60)
  return `${hr}小时${min % 60}分钟`
}

/** 生成面板文本 */
function buildPanelText(
  registry: Registry,
  statusStore?: AgentStatusStore,
): string {
  const agents = registry.listAgents()
  const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })

  if (agents.length === 0) {
    return [
      `<b>📊 Agent 状态面板</b>`,
      ``,
      `当前没有在线的 Agent`,
      ``,
      `<i>更新于 ${now}</i>`,
    ].join("\n")
  }

  const lines = agents.map((a) => {
    const status = statusStore?.get(a.name)
    const icon = a.status === "online" ? "🟢" : "⚫"
    const parts = [`${icon} <b>${a.name}</b>`]

    if (status) {
      if (status.runningTasks > 0) {
        parts.push(`   🔧 执行中: ${status.runningTasks} 个任务`)
      } else if (status.idleSince) {
        parts.push(`   💤 空闲 ${formatIdleTime(status.idleSince)}`)
      }
      if (status.totalCompleted > 0) {
        parts.push(`   ✅ 已完成: ${status.totalCompleted}`)
      }
    }

    return parts.join("\n")
  })

  return [
    `<b>📊 Agent 状态面板</b>`,
    ``,
    ...lines,
    ``,
    `<i>更新于 ${now}</i>`,
  ].join("\n")
}

export interface StatusPanel {
  readonly scheduleUpdate: (chatIds: ReadonlySet<number>) => void
  readonly loadFromDb: () => Promise<void>
}

/** 创建状态面板管理器 */
export function createStatusPanel(
  bot: Bot,
  registry: Registry,
  statusStore?: AgentStatusStore,
  pool?: DbPool,
): StatusPanel {
  let panels = new Map<number, number>() // chatId -> messageId
  let debounceTimer: ReturnType<typeof setTimeout> | undefined

  /** 从数据库加载已有的 panel messageId */
  async function loadFromDb(): Promise<void> {
    if (!pool) return
    const { rows } = await pool.query(
      "SELECT chat_id, message_id FROM status_panels",
    )
    const loaded = new Map<number, number>()
    for (const row of rows) {
      loaded.set(Number(row.chat_id), Number(row.message_id))
    }
    panels = loaded
    if (loaded.size > 0) {
      process.stdout.write(`Loaded ${loaded.size} status panel(s) from DB\n`)
    }
  }

  /** 持久化 panel messageId */
  async function persistPanel(chatId: number, messageId: number): Promise<void> {
    if (!pool) return
    try {
      await pool.query(
        `INSERT INTO status_panels (chat_id, message_id, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (chat_id) DO UPDATE
         SET message_id = EXCLUDED.message_id, updated_at = NOW()`,
        [chatId, messageId],
      )
    } catch (err) {
      process.stderr.write(`Failed to persist status panel: ${err}\n`)
    }
  }

  /** 更新或创建面板消息 */
  async function updatePanel(chatId: number): Promise<void> {
    const text = buildPanelText(registry, statusStore)
    const messageId = panels.get(chatId)

    if (messageId) {
      try {
        await bot.api.editMessageText(chatId, messageId, text, {
          parse_mode: "HTML",
        })
        return
      } catch {
        // 消息可能被删除或太旧，重新发送
      }
    }

    // 发送新面板消息并自动 pin
    try {
      const sent = await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
      })
      panels = new Map(panels)
      panels.set(chatId, sent.message_id)
      await persistPanel(chatId, sent.message_id)
      try {
        await bot.api.pinChatMessage(chatId, sent.message_id, {
          disable_notification: true,
        })
      } catch {
        // pin 失败（权限不足等），静默忽略
      }
    } catch {
      // 发送失败静默处理
    }
  }

  /** 触发所有群聊面板更新（带防抖） */
  function scheduleUpdate(chatIds: ReadonlySet<number>): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(async () => {
      for (const chatId of chatIds) {
        await updatePanel(chatId)
      }
    }, 2000) // 2 秒防抖，避免连续上下线时频繁编辑
  }

  return {
    scheduleUpdate,
    loadFromDb,
  }
}

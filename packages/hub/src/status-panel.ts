import type { Bot } from "grammy"
import type { Registry } from "./registry.js"
import type { AgentStatusStore } from "./agent-status-store.js"

/** 每个群聊的面板消息 ID */
interface PanelState {
  readonly panels: ReadonlyMap<number, number> // chatId -> messageId
  readonly debounceTimer?: ReturnType<typeof setTimeout>
}

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

/** 创建状态面板管理器 */
export function createStatusPanel(
  bot: Bot,
  registry: Registry,
  statusStore?: AgentStatusStore,
) {
  let state: PanelState = { panels: new Map() }

  /** 更新或创建面板消息 */
  async function updatePanel(chatId: number): Promise<void> {
    const text = buildPanelText(registry, statusStore)
    const messageId = state.panels.get(chatId)

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

    // 发送新面板消息
    try {
      const sent = await bot.api.sendMessage(chatId, text, {
        parse_mode: "HTML",
      })
      const newPanels = new Map(state.panels)
      newPanels.set(chatId, sent.message_id)
      state = { ...state, panels: newPanels }
    } catch {
      // 发送失败静默处理
    }
  }

  /** 触发所有群聊面板更新（带防抖） */
  function scheduleUpdate(chatIds: ReadonlySet<number>): void {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer)
    }
    const timer = setTimeout(async () => {
      for (const chatId of chatIds) {
        await updatePanel(chatId)
      }
    }, 2000) // 2 秒防抖，避免连续上下线时频繁编辑
    state = { ...state, debounceTimer: timer }
  }

  return {
    scheduleUpdate,
  }
}

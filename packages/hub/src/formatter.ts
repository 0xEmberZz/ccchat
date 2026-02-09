/** HTML 格式化器（Telegram HTML parse_mode） */

// 转义 HTML 特殊字符
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** 格式化任务结果为 Telegram HTML */
export function formatResult(
  agentName: string,
  result: string,
  status: "success" | "error",
): string {
  const statusLabel = status === "success" ? "完成" : "失败"
  const header = `[${statusLabel}] ${escapeHtml(agentName)} 的任务结果:\n\n`

  let formatted = result

  // 1. 提取代码块（```...```）→ 占位符
  const placeholders: string[] = []
  formatted = formatted.replace(
    /```(\w*)\n?([\s\S]*?)```/g,
    (_match, lang, code) => {
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : ""
      const idx = placeholders.length
      placeholders.push(`<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`)
      return `\x00PH_${idx}\x00`
    },
  )

  // 2. 提取行内代码（`...`）→ 占位符
  formatted = formatted.replace(
    /`([^`\n]+)`/g,
    (_match, code) => {
      const idx = placeholders.length
      placeholders.push(`<code>${escapeHtml(code)}</code>`)
      return `\x00PH_${idx}\x00`
    },
  )

  // 3. 提取粗体（**...**）→ 占位符
  formatted = formatted.replace(
    /\*\*(.+?)\*\*/g,
    (_match, content) => {
      const idx = placeholders.length
      placeholders.push(`<b>${escapeHtml(content)}</b>`)
      return `\x00PH_${idx}\x00`
    },
  )

  // 4. 转义剩余文本
  formatted = escapeHtml(formatted)

  // 5. 恢复所有占位符
  for (let i = 0; i < placeholders.length; i++) {
    formatted = formatted.replace(`\x00PH_${i}\x00`, placeholders[i])
  }

  return header + formatted
}

/** 纯文本格式化（用于 fallback） */
export function formatResultPlain(
  agentName: string,
  result: string,
  status: "success" | "error",
): string {
  const statusLabel = status === "success" ? "完成" : "失败"
  return `[${statusLabel}] ${agentName} 的任务结果:\n\n${result}`
}

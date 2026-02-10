/** Markdown → Telegram entities 格式化器 */
import { createRequire } from "node:module"

// CJS 导入（库的 package.json 有 CJS/ESM 兼容问题，已通过 pnpm patch 修复）
const require_ = createRequire(import.meta.url)
const { markdownToTelegramEntities } = require_("@vcc-community/telegramify-markdown") as {
  markdownToTelegramEntities: (text: string) => {
    text: string
    entities: ReadonlyArray<{ _: string; offset: number; length: number; url?: string; language?: string }>
  }
}

// Telegram Bot API entity 格式
export interface TelegramEntity {
  readonly type: string
  readonly offset: number
  readonly length: number
  readonly url?: string
  readonly language?: string
}

// 格式化结果
export interface FormattedResult {
  readonly text: string
  readonly entities: ReadonlyArray<TelegramEntity>
}

// 库 entity 类型 → Telegram Bot API 类型
const ENTITY_TYPE_MAP: Record<string, string> = {
  messageEntityBold: "bold",
  messageEntityItalic: "italic",
  messageEntityStrike: "strikethrough",
  messageEntityCode: "code",
  messageEntityPre: "pre",
  messageEntityTextUrl: "text_link",
  messageEntityBlockquote: "blockquote",
}

// 检测表格行
function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith("|") && trimmed.endsWith("|")
}

function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line.trim())
}

// 去除 Markdown 行内格式（表格内不支持富文本）
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
}

// 将 Markdown 表格块转为 ``` 代码块（库会识别为 messageEntityPre）
function tableToCodeBlock(tableLines: ReadonlyArray<string>): string {
  const dataLines = tableLines.filter((l) => !isTableSeparator(l))
  const rows = dataLines.map((line) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => stripMarkdown(cell.trim()))
  )
  if (rows.length === 0) return ""

  const colCount = Math.max(...rows.map((r) => r.length))
  const colWidths: number[] = []
  for (let c = 0; c < colCount; c++) {
    colWidths.push(Math.max(...rows.map((r) => (r[c] ?? "").length), 1))
  }

  const formatted = rows.map((row) =>
    row.map((cell, i) => cell.padEnd(colWidths[i] ?? 1)).join("  ")
  )

  return "```\n" + formatted.join("\n") + "\n```"
}

// 预处理：Markdown 表格 → ``` 代码块
function preprocessTables(text: string): string {
  const lines = text.split("\n")
  const result: string[] = []
  let tableBuffer: string[] = []

  for (const line of lines) {
    if (isTableLine(line)) {
      tableBuffer.push(line)
    } else {
      if (tableBuffer.length >= 2) {
        result.push(tableToCodeBlock(tableBuffer))
      } else {
        result.push(...tableBuffer)
      }
      tableBuffer = []
      result.push(line)
    }
  }
  if (tableBuffer.length >= 2) {
    result.push(tableToCodeBlock(tableBuffer))
  } else {
    result.push(...tableBuffer)
  }

  return result.join("\n")
}

/** 格式化任务结果（Markdown → text + Telegram entities） */
export function formatResult(
  agentName: string,
  result: string,
  status: "success" | "error",
): FormattedResult {
  const statusLabel = status === "success" ? "完成" : "失败"
  const header = `[${statusLabel}] ${agentName} 的任务结果:\n\n`

  const preprocessed = preprocessTables(result)
  const parsed = markdownToTelegramEntities(preprocessed)

  // header.length = UTF-16 code units（JS string.length 就是 UTF-16）
  const headerLen = header.length
  const entities: TelegramEntity[] = []
  for (const entity of parsed.entities) {
    const type = ENTITY_TYPE_MAP[entity._]
    if (!type) continue
    entities.push({
      type,
      offset: entity.offset + headerLen,
      length: entity.length,
      ...(entity.url ? { url: entity.url } : {}),
      ...(entity.language ? { language: entity.language } : {}),
    })
  }

  return { text: header + parsed.text, entities }
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

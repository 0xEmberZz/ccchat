/** 分页器：长消息按段落分页，支持 Telegram entities 分页 */
import type { TelegramEntity } from "./formatter.js"

const MAX_PAGE_CHARS = 4000
const TTL_MS = 60 * 60 * 1000 // 1 小时

export interface PageContent {
  readonly text: string
  readonly entities: ReadonlyArray<TelegramEntity>
}

interface PagedContent {
  readonly pages: ReadonlyArray<PageContent>
  readonly createdAt: number
}

interface PaginatorState {
  readonly cache: ReadonlyMap<string, PagedContent>
}

export interface Paginator {
  readonly paginate: (id: string, text: string, entities: ReadonlyArray<TelegramEntity>) => ReadonlyArray<PageContent>
  readonly getPage: (id: string, pageIndex: number) => PageContent | undefined
  readonly getTotalPages: (id: string) => number
}

/** 裁剪 entities 到 [start, end) 范围，调整 offset */
function sliceEntities(
  entities: ReadonlyArray<TelegramEntity>,
  start: number,
  end: number,
): ReadonlyArray<TelegramEntity> {
  const result: TelegramEntity[] = []
  for (const e of entities) {
    const eEnd = e.offset + e.length
    if (eEnd <= start || e.offset >= end) continue
    const clippedOffset = Math.max(e.offset, start)
    const clippedEnd = Math.min(eEnd, end)
    result.push({
      ...e,
      offset: clippedOffset - start,
      length: clippedEnd - clippedOffset,
    })
  }
  return result
}

/** 按段落切分文本为多页（含 entities 分页） */
function splitIntoPages(
  text: string,
  entities: ReadonlyArray<TelegramEntity>,
  maxChars: number,
): ReadonlyArray<PageContent> {
  if (text.length <= maxChars) return [{ text, entities: [...entities] }]

  const pages: PageContent[] = []
  let offset = 0

  while (offset < text.length) {
    const remaining = text.length - offset
    if (remaining <= maxChars) {
      pages.push({
        text: text.slice(offset),
        entities: sliceEntities(entities, offset, text.length),
      })
      break
    }

    // 在 maxChars 范围内找最后一个换行符
    let splitAt = text.lastIndexOf("\n", offset + maxChars)
    if (splitAt <= offset || splitAt - offset < maxChars * 0.3) {
      splitAt = offset + maxChars
    }

    pages.push({
      text: text.slice(offset, splitAt),
      entities: sliceEntities(entities, offset, splitAt),
    })

    offset = splitAt
    // 跳过换行符
    if (text[offset] === "\n") offset++
  }

  return pages
}

export function createPaginator(): Paginator {
  let state: PaginatorState = { cache: new Map() }

  // 定期清理过期内容
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    const newCache = new Map<string, PagedContent>()
    for (const [id, content] of state.cache) {
      if (now - content.createdAt < TTL_MS) {
        newCache.set(id, content)
      }
    }
    state = { cache: newCache }
  }, 5 * 60 * 1000)
  cleanupTimer.unref()

  return {
    paginate(id: string, text: string, entities: ReadonlyArray<TelegramEntity>): ReadonlyArray<PageContent> {
      const pages = splitIntoPages(text, entities, MAX_PAGE_CHARS)
      const newCache = new Map(state.cache)
      newCache.set(id, { pages, createdAt: Date.now() })
      state = { cache: newCache }
      return pages
    },

    getPage(id: string, pageIndex: number): PageContent | undefined {
      const content = state.cache.get(id)
      if (!content) return undefined
      return content.pages[pageIndex]
    },

    getTotalPages(id: string): number {
      return state.cache.get(id)?.pages.length ?? 0
    },
  }
}

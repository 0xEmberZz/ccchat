/** 分页器：长消息按段落分页，内存存储 + TTL 自动清理 */

const MAX_PAGE_CHARS = 4000
const TTL_MS = 60 * 60 * 1000 // 1 小时

interface PagedContent {
  readonly pages: ReadonlyArray<string>
  readonly createdAt: number
}

interface PaginatorState {
  readonly cache: ReadonlyMap<string, PagedContent>
}

export interface Paginator {
  readonly paginate: (id: string, text: string) => ReadonlyArray<string>
  readonly getPage: (id: string, pageIndex: number) => string | undefined
  readonly getTotalPages: (id: string) => number
}

/** 按段落切分文本为多页 */
function splitIntoPages(text: string, maxChars: number): ReadonlyArray<string> {
  if (text.length <= maxChars) return [text]

  const pages: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      pages.push(remaining)
      break
    }

    // 在 maxChars 范围内找最后一个换行符
    let splitAt = remaining.lastIndexOf("\n", maxChars)
    if (splitAt <= 0 || splitAt < maxChars * 0.3) {
      // 没有合适的换行位置，直接截断
      splitAt = maxChars
    }

    pages.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, "")
  }

  return pages
}

export function createPaginator(): Paginator {
  let state: PaginatorState = { cache: new Map() }

  // 定期清理过期内容（unref 防止阻止进程退出）
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
    paginate(id: string, text: string): ReadonlyArray<string> {
      const pages = splitIntoPages(text, MAX_PAGE_CHARS)
      const newCache = new Map(state.cache)
      newCache.set(id, { pages, createdAt: Date.now() })
      state = { cache: newCache }
      return pages
    },

    getPage(id: string, pageIndex: number): string | undefined {
      const content = state.cache.get(id)
      if (!content) return undefined
      return content.pages[pageIndex]
    },

    getTotalPages(id: string): number {
      return state.cache.get(id)?.pages.length ?? 0
    },
  }
}

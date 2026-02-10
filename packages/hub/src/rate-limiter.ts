/** 滑动窗口速率限制器 */

interface WindowEntry {
  count: number
  windowStart: number
}

export interface RateLimiter {
  /** 检查是否超限（不消费配额） */
  readonly check: (key: string) => boolean
  /** 消费一次配额，返回是否允许 */
  readonly consume: (key: string) => boolean
  /** 清理资源 */
  readonly destroy: () => void
}

export function createRateLimiter(options: {
  readonly windowMs: number
  readonly maxRequests: number
}): RateLimiter {
  const { windowMs, maxRequests } = options
  const windows = new Map<string, WindowEntry>()

  // 每分钟清理过期 entry
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of windows) {
      if (now - entry.windowStart > windowMs) {
        windows.delete(key)
      }
    }
  }, 60_000)
  cleanupTimer.unref()

  function getOrReset(key: string): WindowEntry {
    const now = Date.now()
    const existing = windows.get(key)
    if (existing && now - existing.windowStart < windowMs) {
      return existing
    }
    const entry: WindowEntry = { count: 0, windowStart: now }
    windows.set(key, entry)
    return entry
  }

  function check(key: string): boolean {
    const entry = getOrReset(key)
    return entry.count < maxRequests
  }

  function consume(key: string): boolean {
    const entry = getOrReset(key)
    if (entry.count >= maxRequests) {
      return false
    }
    entry.count++
    return true
  }

  function destroy(): void {
    clearInterval(cleanupTimer)
    windows.clear()
  }

  return { check, consume, destroy }
}

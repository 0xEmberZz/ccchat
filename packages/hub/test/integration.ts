#!/usr/bin/env tsx
/**
 * 本地集成测试 — 测试 Hub 核心功能链路
 * 不依赖 Telegram Bot，直接测试 HTTP API + WebSocket + 任务流
 *
 * 用法: npx tsx test/integration.ts
 */
import { createServer } from "node:http"
import { WebSocket } from "ws"
import { createRegistry } from "../src/registry.js"
import { createTaskQueue } from "../src/task-queue.js"
import { createWsServer } from "../src/ws-server.js"
import { createAgentStatusStore } from "../src/agent-status-store.js"
import { createApiHandler } from "../src/api.js"
import { buildConversationContext } from "../src/conversation.js"
import { formatResult, formatResultPlain } from "../src/formatter.js"
import { createPaginator } from "../src/paginator.js"
import {
  serialize,
  parseHubMessage,
  type AgentToHubMessage,
  type HubToAgentMessage,
} from "@ccchat/shared"

// ─── 测试工具 ───

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++
    process.stdout.write(`  ✅ ${message}\n`)
  } else {
    failed++
    process.stderr.write(`  ❌ ${message}\n`)
  }
}

function section(name: string): void {
  process.stdout.write(`\n── ${name} ──\n`)
}

async function fetchJson(url: string, options?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await fetch(url, options)
  const body = await resp.json() as Record<string, unknown>
  return { status: resp.status, body }
}

/** 等待条件满足 */
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// ─── 主测试流程 ───

async function main(): Promise<void> {
  process.stdout.write("🔧 CCChat 本地集成测试\n")

  // 创建核心模块（纯内存模式，无 DB）
  const registry = createRegistry()
  const taskQueue = createTaskQueue()
  const agentStatusStore = createAgentStatusStore()

  // 启动 HTTP + WS 服务器
  const apiHandler = createApiHandler({ registry, taskQueue })
  const httpServer = createServer((req, res) => { apiHandler(req, res) })
  const wsServer = createWsServer(httpServer, registry, taskQueue, agentStatusStore)

  // 收集 WS 回调事件
  const events: string[] = []
  wsServer.onAgentOnline((name) => events.push(`online:${name}`))
  wsServer.onAgentOffline((name) => events.push(`offline:${name}`))
  wsServer.onTaskResult((taskId, _result, _status) => events.push(`result:${taskId}`))
  wsServer.onTaskCancelled((taskId) => events.push(`cancelled:${taskId}`))

  const PORT = 19900
  const BASE = `http://localhost:${PORT}`

  await new Promise<void>((resolve) => {
    httpServer.listen(PORT, () => {
      process.stdout.write(`Hub 已在 :${PORT} 启动\n`)
      resolve()
    })
  })

  try {
    // ═══════════════════════════════════════
    section("1. 健康检查")
    // ═══════════════════════════════════════
    {
      const { status, body } = await fetchJson(`${BASE}/health`)
      assert(status === 200, `GET /health → 200 (got ${status})`)
      assert(body.status === "ok", `/health body.status === "ok"`)
    }

    // ═══════════════════════════════════════
    section("2. 凭证注册 + HTTP API 认证")
    // ═══════════════════════════════════════
    const agentToken = registry.issueToken("test-agent", 123456)
    registry.issueToken("helper-agent", 789012)

    assert(typeof agentToken === "string" && agentToken.startsWith("agt_"), "issueToken 返回有效 token")
    assert(registry.validateAgentToken("test-agent", agentToken), "validateAgentToken 验证通过")
    assert(!registry.validateAgentToken("test-agent", "wrong-token"), "validateAgentToken 拒绝错误 token")
    assert(registry.getAgentByToken(agentToken) === "test-agent", "getAgentByToken 反查正确")

    // 无认证请求
    {
      const { status } = await fetchJson(`${BASE}/api/agents`)
      assert(status === 401, `GET /api/agents 无 token → 401 (got ${status})`)
    }

    // 有认证请求（但 agent 未连接 WS）
    {
      const { status, body } = await fetchJson(`${BASE}/api/agents`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      })
      assert(status === 200, `GET /api/agents 有 token → 200 (got ${status})`)
      const agents = body.agents as unknown[]
      assert(Array.isArray(agents) && agents.length === 0, `无在线 Agent (count=${agents.length})`)
    }

    // ═══════════════════════════════════════
    section("3. WebSocket 连接 + Agent 注册")
    // ═══════════════════════════════════════
    const wsMessages: HubToAgentMessage[] = []
    const ws = new WebSocket(`ws://localhost:${PORT}`)

    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve)
      ws.on("error", reject)
    })

    ws.on("message", (data: Buffer) => {
      wsMessages.push(parseHubMessage(data.toString()))
    })

    // 发送注册消息
    const registerMsg: AgentToHubMessage = {
      type: "register",
      agentName: "test-agent",
      token: agentToken,
    }
    ws.send(serialize(registerMsg))

    // 等待 register_ack
    await waitFor(() => wsMessages.length > 0)
    const ack = wsMessages[0]
    assert(ack?.type === "register_ack", `收到 register_ack (got ${ack?.type})`)
    assert(ack?.type === "register_ack" && ack.success === true, "注册成功")

    // 检查在线状态
    await waitFor(() => events.includes("online:test-agent"))
    assert(events.includes("online:test-agent"), "触发 onAgentOnline 事件")

    {
      const { body } = await fetchJson(`${BASE}/api/agents`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      })
      const agents = body.agents as Array<{ name: string }>
      assert(agents.length === 1 && agents[0].name === "test-agent", "API 列出 1 个在线 Agent")
    }

    // ═══════════════════════════════════════
    section("4. 任务队列基本操作")
    // ═══════════════════════════════════════
    {
      const task = taskQueue.createTask({
        from: "user1",
        to: "test-agent",
        content: "测试任务内容",
        chatId: 100,
        messageId: 200,
      })
      assert(typeof task.taskId === "string" && task.taskId.length > 0, "createTask 返回有效 taskId")
      assert(task.status === "pending", `初始状态为 pending (got ${task.status})`)
      assert(task.conversationId !== undefined, "自动生成 conversationId")

      // 更新状态
      const updated = taskQueue.updateStatus(task.taskId, "running")
      assert(updated?.status === "running", "updateStatus → running")

      // 完成任务
      const completed = taskQueue.updateStatus(task.taskId, "completed", "任务结果")
      assert(completed?.status === "completed", "updateStatus → completed")
      assert(completed?.result === "任务结果", "result 已保存")
      assert(completed?.completedAt !== undefined, "completedAt 已设置")

      // 查询任务
      const fetched = taskQueue.getTask(task.taskId)
      assert(fetched?.taskId === task.taskId, "getTask 查询正确")
    }

    // ═══════════════════════════════════════
    section("5. HTTP API 提交任务")
    // ═══════════════════════════════════════
    {
      // 提交任务（从 test-agent 发给 helper-agent）
      const { status, body } = await fetchJson(`${BASE}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agentToken}`,
        },
        body: JSON.stringify({ to: "helper-agent", content: "帮我修个 bug" }),
      })
      assert(status === 201, `POST /api/tasks → 201 (got ${status})`)
      assert(typeof body.taskId === "string", "返回 taskId")

      const taskId = body.taskId as string

      // 查询任务状态
      const { status: s2, body: b2 } = await fetchJson(`${BASE}/api/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${agentToken}` },
      })
      assert(s2 === 200, `GET /api/tasks/:id → 200 (got ${s2})`)
      assert(b2.status === "awaiting_approval", `任务状态为 awaiting_approval (got ${b2.status})`)
      assert(b2.from === "test-agent", `from 为 test-agent (got ${b2.from})`)
      assert(b2.to === "helper-agent", `to 为 helper-agent (got ${b2.to})`)
    }

    // 无效请求
    {
      const { status } = await fetchJson(`${BASE}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agentToken}`,
        },
        body: JSON.stringify({ to: "nonexistent", content: "hello" }),
      })
      assert(status === 404, `提交给未注册 Agent → 404 (got ${status})`)
    }
    {
      const { status } = await fetchJson(`${BASE}/api/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agentToken}`,
        },
        body: JSON.stringify({ to: "helper-agent" }),
      })
      assert(status === 400, `缺少 content → 400 (got ${status})`)
    }

    // ═══════════════════════════════════════
    section("6. WS 任务分发 + 任务结果")
    // ═══════════════════════════════════════
    {
      // 创建一个已批准的任务，模拟分发
      const task = taskQueue.createTask({
        from: "user1",
        to: "test-agent",
        content: "写一个 hello world",
        chatId: 100,
        messageId: 300,
      })
      taskQueue.updateStatus(task.taskId, "approved")

      // 通过 WS dispatchTask 分发
      wsMessages.length = 0
      const taskMsg = {
        type: "task" as const,
        taskId: task.taskId,
        from: "user1",
        content: "写一个 hello world",
        chatId: 100,
        messageId: 300,
      }
      const sent = wsServer.sendToAgent("test-agent", taskMsg)
      assert(sent, "sendToAgent 发送成功")

      // 等待收到任务
      await waitFor(() => wsMessages.some((m) => m.type === "task"))
      const taskReceived = wsMessages.find((m) => m.type === "task")
      assert(taskReceived?.type === "task" && taskReceived.taskId === task.taskId, "Agent 收到任务消息")

      // 模拟 Agent 返回结果
      taskQueue.updateStatus(task.taskId, "running")
      const resultMsg: AgentToHubMessage = {
        type: "task_result",
        taskId: task.taskId,
        result: "```js\nconsole.log('hello world')\n```",
        status: "success",
      }
      ws.send(serialize(resultMsg))

      // 等待回调
      await waitFor(() => events.some((e) => e.startsWith("result:")))
      assert(events.some((e) => e === `result:${task.taskId}`), "触发 onTaskResult 事件")

      const finalTask = taskQueue.getTask(task.taskId)
      assert(finalTask?.status === "completed", `任务状态变为 completed (got ${finalTask?.status})`)
    }

    // ═══════════════════════════════════════
    section("7. 任务取消")
    // ═══════════════════════════════════════
    {
      const task = taskQueue.createTask({
        from: "user1",
        to: "test-agent",
        content: "一个需要取消的任务",
        chatId: 100,
        messageId: 400,
      })
      taskQueue.updateStatus(task.taskId, "running")

      // 发送取消指令
      wsMessages.length = 0
      const cancelSent = wsServer.cancelTask("test-agent", task.taskId)
      assert(cancelSent, "cancelTask 发送成功")

      // 等待 Agent 收到 cancel_task
      await waitFor(() => wsMessages.some((m) => m.type === "cancel_task"))
      const cancelMsg = wsMessages.find((m) => m.type === "cancel_task")
      assert(
        cancelMsg?.type === "cancel_task" && cancelMsg.taskId === task.taskId,
        "Agent 收到 cancel_task",
      )

      // 模拟 Agent 确认取消
      const cancelledMsg: AgentToHubMessage = {
        type: "task_cancelled",
        taskId: task.taskId,
      }
      ws.send(serialize(cancelledMsg))

      await waitFor(() => events.some((e) => e === `cancelled:${task.taskId}`))
      assert(events.some((e) => e === `cancelled:${task.taskId}`), "触发 onTaskCancelled 事件")

      const cancelledTask = taskQueue.getTask(task.taskId)
      assert(cancelledTask?.status === "cancelled", `任务状态变为 cancelled (got ${cancelledTask?.status})`)
    }

    // ═══════════════════════════════════════
    section("8. 多轮对话上下文")
    // ═══════════════════════════════════════
    {
      // 第一轮
      const task1 = taskQueue.createTask({
        from: "user1",
        to: "test-agent",
        content: "介绍一下 TypeScript",
        chatId: 100,
        messageId: 500,
      })
      taskQueue.updateStatus(task1.taskId, "completed", "TypeScript 是微软开发的...")
      taskQueue.setResultMessageId(task1.taskId, 501)

      // 通过 resultMessageId 查找
      const found = taskQueue.findTaskByResultMessageId(501)
      assert(found?.taskId === task1.taskId, "findTaskByResultMessageId 查找成功")

      // 第二轮
      const convTasks = taskQueue.getTasksByConversation(task1.conversationId!)
      assert(convTasks.length >= 1, `对话中有 ${convTasks.length} 个任务`)

      const context = buildConversationContext(convTasks, "和 JavaScript 有什么区别?")
      assert(context.includes("[用户]"), "上下文包含 [用户] 标记")
      assert(context.includes("[助手]"), "上下文包含 [助手] 标记")
      assert(context.includes("和 JavaScript 有什么区别"), "上下文包含新消息")

      // 创建续轮任务
      const task2 = taskQueue.createTask({
        from: "user1",
        to: "test-agent",
        content: context,
        chatId: 100,
        messageId: 502,
        conversationId: task1.conversationId,
        parentTaskId: task1.taskId,
      })
      assert(task2.conversationId === task1.conversationId, "续轮 conversationId 一致")
      assert(task2.parentTaskId === task1.taskId, "parentTaskId 指向首轮")

      const conv2 = taskQueue.getTasksByConversation(task1.conversationId!)
      assert(conv2.length >= 2, `对话中现在有 ${conv2.length} 个任务`)
    }

    // ═══════════════════════════════════════
    section("9. updateChatInfo 回填")
    // ═══════════════════════════════════════
    {
      const task = taskQueue.createTask({
        from: "api-agent",
        to: "test-agent",
        content: "API 提交的任务",
        chatId: 0,
        messageId: 0,
      })
      assert(task.chatId === 0, "初始 chatId 为 0")

      taskQueue.updateChatInfo(task.taskId, 999, 888)
      const updated = taskQueue.getTask(task.taskId)
      assert(updated?.chatId === 999, `chatId 更新为 999 (got ${updated?.chatId})`)
      assert(updated?.messageId === 888, `messageId 更新为 888 (got ${updated?.messageId})`)
    }

    // ═══════════════════════════════════════
    section("10. Agent 状态存储")
    // ═══════════════════════════════════════
    {
      agentStatusStore.update("test-agent", {
        runningTasks: 2,
        currentTaskId: "task-123",
        idleSince: undefined,
      })
      const status = agentStatusStore.get("test-agent")
      assert(status?.runningTasks === 2, "运行中任务数 = 2")
      assert(status?.currentTaskId === "task-123", "当前任务 ID 正确")

      agentStatusStore.incrementCompleted("test-agent")
      const s2 = agentStatusStore.get("test-agent")
      assert(s2?.totalCompleted === 1, "已完成计数 = 1")

      agentStatusStore.remove("test-agent")
      assert(agentStatusStore.get("test-agent") === undefined, "remove 清除状态")
    }

    // ═══════════════════════════════════════
    section("11. 格式化器")
    // ═══════════════════════════════════════
    {
      const result = "这是**加粗**文本\n```js\nconsole.log('hello')\n```\n还有 `内联代码`"
      const html = formatResult("test-agent", result, "success")
      assert(html.includes("<b>"), "HTML 包含 <b> 标签")
      assert(html.includes("<pre><code"), "HTML 包含 <pre><code> 标签")
      assert(html.includes("<code>"), "HTML 包含内联 <code> 标签")
      assert(!html.includes("**"), "已替换 Markdown 加粗语法")

      const plain = formatResultPlain("test-agent", result, "success")
      assert(!plain.includes("<b>"), "纯文本不含 HTML 标签")
      assert(plain.includes("加粗"), "纯文本保留文本内容")
    }

    // ═══════════════════════════════════════
    section("12. 分页器")
    // ═══════════════════════════════════════
    {
      const paginator = createPaginator()
      // 生成一段长文本
      const longText = Array.from({ length: 200 }, (_, i) => `这是第 ${i + 1} 段内容，包含一些文字。`).join("\n\n")
      const pages = paginator.paginate("long-task", longText)
      assert(pages.length > 1, `分页数 > 1 (got ${pages.length})`)
      assert(pages.every((p) => p.length <= 4000), "每页 ≤ 4000 字符")

      const page0 = paginator.getPage("long-task", 0)
      assert(page0 === pages[0], "getPage(0) 返回第一页")

      const total = paginator.getTotalPages("long-task")
      assert(total === pages.length, `getTotalPages = ${pages.length}`)

      const lastPage = paginator.getPage("long-task", total - 1)
      assert(lastPage !== undefined, "最后一页可访问")

      const outOfRange = paginator.getPage("long-task", total)
      assert(outOfRange === undefined, "超出范围返回 undefined")
    }

    // ═══════════════════════════════════════
    section("13. Status Report (via WS ping)")
    // ═══════════════════════════════════════
    {
      // 模拟 Agent 发送 status_report
      const reportMsg: AgentToHubMessage = {
        type: "status_report",
        runningTasks: 1,
        currentTaskId: "some-task",
        idleSince: undefined,
      }
      ws.send(serialize(reportMsg))
      await new Promise((r) => setTimeout(r, 200))

      const status = agentStatusStore.get("test-agent")
      assert(status?.runningTasks === 1, `status_report: runningTasks = 1 (got ${status?.runningTasks})`)
      assert(status?.currentTaskId === "some-task", "status_report: currentTaskId 正确")
    }

    // ═══════════════════════════════════════
    section("14. WS 断开 → 触发 offline")
    // ═══════════════════════════════════════
    {
      events.length = 0
      ws.close()
      await waitFor(() => events.includes("offline:test-agent"))
      assert(events.includes("offline:test-agent"), "触发 onAgentOffline 事件")
      assert(!registry.isOnline("test-agent"), "Agent 已标记为离线")
    }

    // ═══════════════════════════════════════
    // 测试结果
    // ═══════════════════════════════════════
    process.stdout.write(`\n${"═".repeat(40)}\n`)
    process.stdout.write(`结果: ${passed} 通过, ${failed} 失败\n`)

    if (failed > 0) {
      process.stdout.write("❌ 存在失败的测试\n")
    } else {
      process.stdout.write("✅ 全部通过!\n")
    }
  } finally {
    wsServer.close()
    httpServer.close()
  }

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
  process.stderr.write(`测试失败: ${err}\n`)
  process.exit(1)
})

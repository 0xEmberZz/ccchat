/**
 * MCP 工具定义
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { HubClient } from "./hub-client.js"
import type { HubHttpClient } from "./http-client.js"
import type { AgentInfo, TaskInfo } from "@ccchat/shared"

/** 格式化 Agent 信息为可读文本 */
function formatAgent(agent: AgentInfo): string {
  return `- ${agent.name} [${agent.status}] (上线: ${agent.connectedAt})`
}

/** 格式化任务信息为可读文本 */
function formatTask(task: TaskInfo): string {
  const lines: readonly string[] = [
    `任务ID: ${task.taskId}`,
    `状态: ${task.status}`,
    `发起方: ${task.from}`,
    `执行方: ${task.to}`,
    `内容: ${task.content}`,
    `创建时间: ${task.createdAt}`,
    ...(task.result ? [`结果: ${task.result}`] : []),
    ...(task.completedAt ? [`完成时间: ${task.completedAt}`] : []),
  ]
  return lines.join("\n")
}

/** 注册 ccchat_send 工具 */
function registerSendTool(server: McpServer, client: HubClient): void {
  server.tool(
    "ccchat_send",
    "发送消息给其他 Agent",
    {
      to: z.string().describe("目标 Agent 名称"),
      message: z.string().describe("消息内容"),
    },
    async ({ to, message }) => {
      try {
        client.sendMessage(to, message)
        return {
          content: [{ type: "text" as const, text: `消息已发送给 ${to}` }],
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text" as const, text: `发送失败: ${errMsg}` }],
          isError: true,
        }
      }
    },
  )
}

/** 注册 ccchat_list_agents 工具 */
function registerListAgentsTool(server: McpServer, client: HubClient): void {
  server.tool(
    "ccchat_list_agents",
    "查看在线 Agent 列表",
    async () => {
      try {
        const resp = await client.listAgents()
        const text = resp.agents.length > 0
          ? resp.agents.map(formatAgent).join("\n")
          : "当前没有在线的 Agent"
        return {
          content: [{ type: "text" as const, text }],
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text" as const, text: `查询失败: ${errMsg}` }],
          isError: true,
        }
      }
    },
  )
}

/** 注册 ccchat_task_status 工具 */
function registerTaskStatusTool(server: McpServer, client: HubClient): void {
  server.tool(
    "ccchat_task_status",
    "查看任务执行状态",
    {
      taskId: z.string().describe("任务 ID"),
    },
    async ({ taskId }) => {
      try {
        const resp = await client.getTaskStatus(taskId)
        const text = resp.task
          ? formatTask(resp.task)
          : `未找到任务: ${taskId}`
        return {
          content: [{ type: "text" as const, text }],
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text" as const, text: `查询失败: ${errMsg}` }],
          isError: true,
        }
      }
    },
  )
}

/** 注册 ccchat_submit_task 工具（通过 HTTP API 提交任务，走 TG 审批） */
function registerSubmitTaskTool(server: McpServer, httpClient: HubHttpClient): void {
  server.tool(
    "ccchat_submit_task",
    "提交任务给其他 Agent（通过 Telegram 审批流程）。用于请求其他同事的 Claude Code 帮你处理任务，比如修 bug、写代码等。任务会发送到 Telegram 群等待审批后执行。",
    {
      to: z.string().describe("目标 Agent 名称（同事的 agent name）"),
      content: z.string().describe("任务内容（要求对方做什么）"),
    },
    async ({ to, content }) => {
      try {
        const result = await httpClient.submitTask(to, content)
        return {
          content: [{
            type: "text" as const,
            text: [
              `任务已提交！`,
              `ID: ${result.taskId}`,
              `状态: ${result.message}`,
              ``,
              `用 ccchat_task_status 查看进度。`,
            ].join("\n"),
          }],
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text" as const, text: `提交失败: ${errMsg}` }],
          isError: true,
        }
      }
    },
  )
}

/** 注册 ccchat_check_result 工具（通过 HTTP API 查询任务结果） */
function registerCheckResultTool(server: McpServer, httpClient: HubHttpClient): void {
  server.tool(
    "ccchat_check_result",
    "查询通过 ccchat_submit_task 提交的任务结果。可以轮询查看任务是否完成。",
    {
      taskId: z.string().describe("任务 ID（submit_task 返回的 ID）"),
    },
    async ({ taskId }) => {
      try {
        const task = await httpClient.getTaskStatus(taskId)
        const lines = [
          `任务ID: ${task.taskId}`,
          `状态: ${task.status}`,
          `执行方: ${task.to}`,
          ...(task.result ? [``, `结果:`, task.result] : []),
          ...(task.completedAt ? [`完成时间: ${task.completedAt}`] : []),
        ]
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          content: [{ type: "text" as const, text: `查询失败: ${errMsg}` }],
          isError: true,
        }
      }
    },
  )
}

/** 注册所有工具到 MCP Server */
export function registerTools(
  server: McpServer,
  client: HubClient,
  httpClient?: HubHttpClient,
): void {
  registerSendTool(server, client)
  registerListAgentsTool(server, client)
  registerTaskStatusTool(server, client)
  if (httpClient) {
    registerSubmitTaskTool(server, httpClient)
    registerCheckResultTool(server, httpClient)
  }
}

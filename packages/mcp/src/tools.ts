/**
 * MCP 工具定义
 * 提供三个工具: ccchat_send, ccchat_list_agents, ccchat_task_status
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { HubClient } from "./hub-client.js"
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

/** 注册所有工具到 MCP Server */
export function registerTools(server: McpServer, client: HubClient): void {
  registerSendTool(server, client)
  registerListAgentsTool(server, client)
  registerTaskStatusTool(server, client)
}

#!/usr/bin/env node
/**
 * CCChat MCP Server 入口
 *
 * 安装方式:
 * claude mcp add ccchat -- npx ccchat-mcp --hub wss://hub.example.com --agent-name myname --token mytoken
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { HubClient } from "./hub-client.js"
import { HubHttpClient } from "./http-client.js"
import { registerTools } from "./tools.js"

/** 命令行配置 */
interface CliConfig {
  readonly hubUrl: string
  readonly agentName: string
  readonly token: string
  readonly hubApiUrl?: string
}

/** 从命令行参数和环境变量解析配置 */
function parseConfig(args: readonly string[]): CliConfig {
  const flagMap = buildFlagMap(args)

  const hubUrl = flagMap.get("--hub")
    ?? process.env["CCCHAT_HUB_URL"]
    ?? ""
  const agentName = flagMap.get("--agent-name")
    ?? process.env["CCCHAT_AGENT_NAME"]
    ?? ""
  const token = flagMap.get("--token")
    ?? process.env["CCCHAT_TOKEN"]
    ?? ""
  const hubApiUrl = flagMap.get("--hub-api")
    ?? process.env["CCCHAT_HUB_API_URL"]
    ?? undefined

  if (!hubUrl) {
    throw new Error("缺少 --hub 参数或 CCCHAT_HUB_URL 环境变量")
  }
  if (!agentName) {
    throw new Error("缺少 --agent-name 参数或 CCCHAT_AGENT_NAME 环境变量")
  }
  if (!token) {
    throw new Error("缺少 --token 参数或 CCCHAT_TOKEN 环境变量")
  }

  return { hubUrl, agentName, token, hubApiUrl }
}

/** 将命令行参数解析为 flag -> value 映射 */
function buildFlagMap(args: readonly string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg?.startsWith("--") && i + 1 < args.length) {
      map.set(arg, args[i + 1]!)
      i++
    }
  }
  return map
}

/** 启动 MCP Server */
async function main(): Promise<void> {
  const config = parseConfig(process.argv.slice(2))

  // 连接 Hub
  const hubClient = new HubClient({
    hubUrl: config.hubUrl,
    agentName: config.agentName,
    token: config.token,
  })
  await hubClient.connect()

  // 创建 MCP Server
  const server = new McpServer({
    name: "ccchat",
    version: "0.1.0",
  })

  // 创建 HTTP 客户端（可选，用于任务提交）
  const httpClient = config.hubApiUrl
    ? new HubHttpClient({ hubApiUrl: config.hubApiUrl, token: config.token })
    : undefined

  // 注册工具
  registerTools(server, hubClient, httpClient)

  // 启动 stdio 传输
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // 优雅退出
  process.on("SIGINT", () => {
    hubClient.close()
    process.exit(0)
  })
  process.on("SIGTERM", () => {
    hubClient.close()
    process.exit(0)
  })
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`CCChat MCP Server 启动失败: ${msg}\n`)
  process.exit(1)
})

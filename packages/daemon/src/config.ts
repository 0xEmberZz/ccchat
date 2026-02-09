import * as fs from "node:fs"
import * as path from "node:path"
import * as readline from "node:readline"
import type { DaemonConfig } from "@ccchat/shared"

// 配置文件路径
const CONFIG_DIR = path.join(
  process.env["HOME"] ?? "~",
  ".ccchat",
)
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json")

// 默认值
const DEFAULT_MAX_CONCURRENT_TASKS = 1
const DEFAULT_TASK_TIMEOUT = 300_000

/** 从文件读取配置 */
export function loadConfig(): DaemonConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null
  }
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8")
  const parsed = JSON.parse(raw) as DaemonConfig
  return {
    ...parsed,
    maxConcurrentTasks: parsed.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
    taskTimeout: parsed.taskTimeout ?? DEFAULT_TASK_TIMEOUT,
  }
}

/** 保存配置到文件 */
export function saveConfig(config: DaemonConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8")
}

/** 交互式问答工具 */
function ask(
  rl: readline.Interface,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : ""
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "")
    })
  })
}

/** 交互式初始化配置 */
export async function initConfig(): Promise<DaemonConfig> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    process.stdout.write("--- CCChat 配置初始化 ---\n\n")

    const hubUrl = await ask(rl, "Hub 服务器地址", "ws://localhost:9900")
    const agentName = await ask(rl, "Agent 名称")
    const token = await ask(rl, "认证 Token")
    const workDir = await ask(rl, "工作目录", process.cwd())

    const config: DaemonConfig = {
      hubUrl,
      agentName,
      token,
      workDir,
      maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
      taskTimeout: DEFAULT_TASK_TIMEOUT,
    }

    saveConfig(config)
    process.stdout.write(`\n配置已保存到 ${CONFIG_FILE}\n`)
    return config
  } finally {
    rl.close()
  }
}

/** 获取配置路径（用于状态显示） */
export function getConfigPath(): string {
  return CONFIG_FILE
}

/**
 * JSON 文件凭证持久化（无 Postgres 时的轻量备份方案）
 * 数据存储在 data/credentials.json
 */
import * as fs from "node:fs"
import * as path from "node:path"
import type { CredentialRow, CredentialRepo } from "./credential-repo.js"

interface FileData {
  readonly credentials: ReadonlyArray<CredentialRow>
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function readFile(filePath: string): ReadonlyArray<CredentialRow> {
  if (!fs.existsSync(filePath)) return []
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const data = JSON.parse(raw) as FileData
    return data.credentials ?? []
  } catch {
    return []
  }
}

function writeFile(filePath: string, credentials: ReadonlyArray<CredentialRow>): void {
  ensureDir(filePath)
  const data: FileData = { credentials }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 })
}

export function createFileCredentialRepo(dataDir?: string): CredentialRepo {
  const dir = dataDir ?? path.join(process.cwd(), "data")
  const filePath = path.join(dir, "credentials.json")

  return {
    async save(credential: CredentialRow): Promise<void> {
      const existing = readFile(filePath)
      const filtered = existing.filter((c) => c.agentName !== credential.agentName)
      writeFile(filePath, [...filtered, credential])
    },

    async findByName(agentName: string): Promise<CredentialRow | undefined> {
      const all = readFile(filePath)
      return all.find((c) => c.agentName === agentName)
    },

    async delete(agentName: string): Promise<void> {
      const existing = readFile(filePath)
      const filtered = existing.filter((c) => c.agentName !== agentName)
      writeFile(filePath, filtered)
    },

    async loadAll(): Promise<ReadonlyArray<CredentialRow>> {
      return readFile(filePath)
    },
  }
}

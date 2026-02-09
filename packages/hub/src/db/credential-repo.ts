import type { DbPool } from "./connection.js"

export interface CredentialRow {
  readonly agentName: string
  readonly token: string
  readonly telegramUserId: number
  readonly createdAt: string
}

export interface CredentialRepo {
  readonly save: (credential: CredentialRow) => Promise<void>
  readonly findByName: (agentName: string) => Promise<CredentialRow | undefined>
  readonly delete: (agentName: string) => Promise<void>
  readonly loadAll: () => Promise<ReadonlyArray<CredentialRow>>
}

export function createCredentialRepo(pool: DbPool): CredentialRepo {
  return {
    async save(credential: CredentialRow): Promise<void> {
      await pool.query(
        `INSERT INTO credentials (agent_name, token, telegram_user_id, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (agent_name) DO UPDATE
         SET token = EXCLUDED.token,
             telegram_user_id = EXCLUDED.telegram_user_id,
             created_at = EXCLUDED.created_at`,
        [
          credential.agentName,
          credential.token,
          credential.telegramUserId,
          credential.createdAt,
        ],
      )
    },

    async findByName(agentName: string): Promise<CredentialRow | undefined> {
      const { rows } = await pool.query(
        "SELECT agent_name, token, telegram_user_id, created_at FROM credentials WHERE agent_name = $1",
        [agentName],
      )
      if (rows.length === 0) return undefined
      const row = rows[0]
      return {
        agentName: row.agent_name,
        token: row.token,
        telegramUserId: Number(row.telegram_user_id),
        createdAt: row.created_at,
      }
    },

    async delete(agentName: string): Promise<void> {
      await pool.query("DELETE FROM credentials WHERE agent_name = $1", [
        agentName,
      ])
    },

    async loadAll(): Promise<ReadonlyArray<CredentialRow>> {
      const { rows } = await pool.query(
        "SELECT agent_name, token, telegram_user_id, created_at FROM credentials",
      )
      return rows.map((row) => ({
        agentName: row.agent_name,
        token: row.token,
        telegramUserId: Number(row.telegram_user_id),
        createdAt: row.created_at,
      }))
    },
  }
}

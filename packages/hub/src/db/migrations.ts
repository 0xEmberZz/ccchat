import type { DbPool } from "./connection.js"

const MIGRATIONS = [
  {
    name: "001_initial",
    sql: `
      CREATE TABLE IF NOT EXISTS credentials (
        agent_name TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        telegram_user_id BIGINT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        task_id UUID PRIMARY KEY,
        from_user TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        result TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        chat_id BIGINT NOT NULL,
        message_id BIGINT NOT NULL,
        conversation_id UUID,
        parent_task_id UUID,
        result_message_id BIGINT
      );

      CREATE TABLE IF NOT EXISTS pending_tasks (
        agent_name TEXT NOT NULL,
        task_id UUID NOT NULL REFERENCES tasks(task_id),
        position SERIAL,
        PRIMARY KEY (agent_name, task_id)
      );
    `,
  },
]

export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  for (const migration of MIGRATIONS) {
    const { rows } = await pool.query(
      "SELECT 1 FROM _migrations WHERE name = $1",
      [migration.name],
    )
    if (rows.length > 0) continue

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(migration.sql)
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [
        migration.name,
      ])
      await client.query("COMMIT")
      process.stdout.write(`Migration applied: ${migration.name}\n`)
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }
  }
}

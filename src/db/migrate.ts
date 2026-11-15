import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, getDb } from './index.ts'
import { logger } from '../logger.ts'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations')

/** Applies pending *.sql migrations in filename order, each in its own transaction. */
export async function migrate(): Promise<string[]> {
  const db = await getDb()
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
  const applied: string[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue
    const sql = readFileSync(join(dir, file), 'utf8')
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations (name) VALUES ('${file}');\nCOMMIT;`)
    applied.push(file)
    logger.info({ file }, 'migration applied')
  }
  return applied
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\.ts$/, '.ts')) {
  migrate()
    .then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database is up to date.'); return closeDb() })
    .catch((e) => { console.error(e); process.exit(1) })
}

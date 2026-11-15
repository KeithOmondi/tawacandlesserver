import pg from 'pg'
import { config, isProd } from '../config.ts'
import { logger } from '../logger.ts'

export interface QueryResult<T> { rows: T[]; rowCount: number }
export interface Queryable {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<QueryResult<T>>
}
export interface Db extends Queryable {
  /** Run multiple statements (no params) — used by migrations. */
  exec(sql: string): Promise<void>
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  close(): Promise<void>
}

// Return int8 (counts/sums) as JS numbers — all our values are well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v))
pg.types.setTypeParser(1700, (v) => Number(v))

async function createPg(): Promise<Db> {
  const local = /localhost|127\.0\.0\.1|@db[:/]|@postgres[:/]/.test(config.DATABASE_URL)
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    ssl: config.DATABASE_SSL && !local ? { rejectUnauthorized: true } : undefined,
  })
  pool.on('error', (err) => logger.error({ err }, 'postgres pool error'))
  return {
    async query(text, params) {
      const r = await pool.query(text, params as any[])
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    },
    async exec(sql) { await pool.query(sql) },
    async tx(fn) {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const out = await fn({
          async query(text, params) {
            const r = await c.query(text, params as any[])
            return { rows: r.rows, rowCount: r.rowCount ?? 0 }
          },
        })
        await c.query('COMMIT')
        return out
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        c.release()
      }
    },
    close: () => pool.end(),
  }
}

async function createLite(): Promise<Db> {
  if (isProd) throw new Error('Embedded database is not allowed in production')
  const { PGlite } = await import('@electric-sql/pglite')
  type Lite = InstanceType<typeof PGlite>
  const dir = config.NODE_ENV === 'test' ? undefined : config.PGLITE_DIR
  const lite = new PGlite(dir)
  await lite.waitReady
  const wrap = (q: { query: Lite['query'] }): Queryable => ({
    async query(text, params) {
      const r = await q.query(text, params as any[])
      return { rows: r.rows as any[], rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) }
    },
  })
  return {
    ...wrap(lite),
    exec: async (sql) => { await lite.exec(sql) },
    tx: (fn) => lite.transaction((t) => fn(wrap(t as any))),
    close: () => lite.close(),
  }
}

let instance: Promise<Db> | undefined
/** Lazily-created singleton. Uses Postgres when DATABASE_URL is set, otherwise an embedded dev database. */
export function getDb(): Promise<Db> {
  return (instance ??= config.DATABASE_URL ? createPg() : createLite())
}
export async function closeDb() {
  if (instance) { const d = await instance; instance = undefined; await d.close() }
}

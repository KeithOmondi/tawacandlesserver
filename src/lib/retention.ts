import { getDb } from '../db/index.ts'
import { logger } from '../logger.ts'

/** Enforces the retention periods promised in the Privacy Policy. Safe to run repeatedly. */
export async function purgeOldData() {
  const db = await getDb()
  const run = async (label: string, sql: string) => {
    const r = await db.query(sql)
    if (r.rowCount) logger.info({ label, rows: r.rowCount }, 'retention purge')
  }
  await run('sessions', `DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`)
  await run('email_tokens', `DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'`)
  await run('messages', `DELETE FROM messages WHERE created_at < now() - interval '24 months'`)
  await run('audit_log', `DELETE FROM audit_log WHERE at < now() - interval '24 months'`)
  await run('deleted_users', `DELETE FROM users WHERE deleted_at < now() - interval '30 days' AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = users.id)`)
}

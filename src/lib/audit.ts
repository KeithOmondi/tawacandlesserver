import type { Request } from 'express'
import type { Queryable } from '../db/index.ts'
import { getDb } from '../db/index.ts'
import { logger } from '../logger.ts'

export const clientIp = (req: Request) => req.ip ?? req.socket.remoteAddress ?? ''

/** Append-only security/admin audit trail. Never throws. */
export async function audit(
  action: string,
  req: Request | null,
  opts: { actorId?: string | null; actorEmail?: string | null; target?: string; meta?: Record<string, unknown> } = {},
  q?: Queryable,
) {
  try {
    const db = q ?? (await getDb())
    const actor = req?.user
    await db.query(
      'INSERT INTO audit_log (actor_id, actor_email, action, target, ip, meta) VALUES ($1,$2,$3,$4,$5,$6)',
      [opts.actorId ?? actor?.id ?? null, opts.actorEmail ?? actor?.email ?? null, action, opts.target ?? null, req ? clientIp(req) : null, JSON.stringify(opts.meta ?? {})],
    )
  } catch (err) {
    logger.error({ err, action }, 'audit log write failed')
  }
}

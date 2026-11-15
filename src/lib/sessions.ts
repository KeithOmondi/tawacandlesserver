import { randomUUID } from 'node:crypto'
import type { CookieOptions, Request, Response } from 'express'
import { config, isProd } from '../config.ts'
import { getDb } from '../db/index.ts'
import { clientIp } from './audit.ts'
import { randomToken, sha256 } from './crypto.ts'

export const REFRESH_COOKIE = isProd ? '__Host-tawa_rt' : 'tawa_rt'
const maxAgeMs = config.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000

const cookieOpts = (): CookieOptions => ({
  httpOnly: true, secure: isProd, sameSite: 'strict', path: '/', maxAge: maxAgeMs,
})

export function setRefreshCookie(res: Response, token: string) { res.cookie(REFRESH_COOKIE, token, cookieOpts()) }
export function clearRefreshCookie(res: Response) { res.clearCookie(REFRESH_COOKIE, { ...cookieOpts(), maxAge: undefined }) }

export async function createSession(userId: string, req: Request, familyId: string = randomUUID()): Promise<string> {
  const token = randomToken(48)
  const db = await getDb()
  await db.query(
    'INSERT INTO sessions (user_id, family_id, token_hash, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId, familyId, sha256(token), new Date(Date.now() + maxAgeMs), (req.get('user-agent') ?? '').slice(0, 300), clientIp(req)],
  )
  return token
}

export type RotateResult =
  | { ok: true; userId: string; token: string }
  | { ok: false; reason: 'invalid' | 'reuse' | 'expired' }

/**
 * Rotates a refresh token. Presenting an already-used (revoked) token is treated as theft:
 * the whole token family is revoked so both the attacker and the victim must sign in again.
 */
export async function rotateSession(oldToken: string, req: Request): Promise<RotateResult> {
  const db = await getDb()
  const hash = sha256(oldToken)
  const r = await db.query<{ id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null }>(
    'SELECT id, user_id, family_id, expires_at, revoked_at FROM sessions WHERE token_hash = $1', [hash])
  const s = r.rows[0]
  if (!s) return { ok: false, reason: 'invalid' }
  if (s.revoked_at) {
    await db.query('UPDATE sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [s.family_id])
    return { ok: false, reason: 'reuse' }
  }
  if (s.expires_at < new Date()) return { ok: false, reason: 'expired' }
  // Atomic claim: only one concurrent request can revoke this row.
  const claim = await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [s.id])
  if (claim.rowCount === 0) return { ok: false, reason: 'invalid' }
  const token = await createSession(s.user_id, req, s.family_id)
  return { ok: true, userId: s.user_id, token }
}

export async function revokeSessionByToken(token: string) {
  const db = await getDb()
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)])
}
export async function revokeAllSessions(userId: string, exceptToken?: string) {
  const db = await getDb()
  await db.query(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)',
    [userId, exceptToken ? sha256(exceptToken) : null])
}

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { MulterError } from 'multer'
import { ZodError, type ZodType } from 'zod'
import { allowedOrigins, config, isProd, isTest } from '../config.ts'
import { getDb } from '../db/index.ts'
import { HttpError, forbidden, notFound, unauthorized } from '../lib/errors.ts'
import { verifyAccess } from '../lib/tokens.ts'
import { logger } from '../logger.ts'

export interface AuthUser { id: string; email: string; name: string; role: 'customer' | 'admin'; emailVerified: boolean; mfa: boolean; mfaEnabled: boolean }
declare module 'express-serve-static-core' {
  interface Request { user?: AuthUser }
}

// ---------- authentication ----------
async function loadUser(req: Request): Promise<void> {
  const h = req.get('authorization')
  if (!h?.startsWith('Bearer ')) return
  let claims: { id: string; mfa: boolean }
  try { claims = await verifyAccess(h.slice(7)) } catch { throw unauthorized('Session expired. Please sign in again.') }
  const db = await getDb()
  const r = await db.query<{ id: string; email: string; name: string; role: 'customer' | 'admin'; email_verified_at: Date | null; mfa_enabled: boolean; disabled: boolean; deleted_at: Date | null }>(
    'SELECT id, email, name, role, email_verified_at, mfa_enabled, disabled, deleted_at FROM users WHERE id = $1', [claims.id])
  const u = r.rows[0]
  if (!u || u.disabled || u.deleted_at) throw unauthorized('Session expired. Please sign in again.')
  req.user = { id: u.id, email: u.email, name: u.name, role: u.role, emailVerified: !!u.email_verified_at, mfa: claims.mfa, mfaEnabled: u.mfa_enabled }
}

/** Attaches req.user if a valid token is present; invalid tokens are rejected. Anonymous requests pass. */
export const optionalAuth: RequestHandler = async (req, _res, next) => { try { await loadUser(req); next() } catch (e) { next(e) } }
export const requireAuth: RequestHandler = async (req, _res, next) => {
  try { await loadUser(req); if (!req.user) throw unauthorized(); next() } catch (e) { next(e) }
}
export const requireAdmin: RequestHandler = async (req, _res, next) => {
  try {
    await loadUser(req)
    if (!req.user) throw unauthorized()
    // Same response for "not admin" as for unknown routes: do not reveal that an admin API exists.
    if (req.user.role !== 'admin') throw notFound()
    if (config.ADMIN_REQUIRE_MFA && !req.user.mfa) throw new HttpError(403, 'mfa_required', 'Two-factor authentication is required for admin access.')
    next()
  } catch (e) { next(e) }
}
export const requireVerified: RequestHandler = (req, _res, next) => {
  if (!req.user?.emailVerified) return next(forbidden('Please verify your email address first.'))
  next()
}

// ---------- CSRF / origin protection ----------
/** Browsers always send Origin on cross-site unsafe requests. Reject any that isn't ours. */
export const originGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  const origin = req.get('origin')
  if (origin && !allowedOrigins.includes(origin)) return next(forbidden('Cross-origin request blocked.'))
  next()
}
/** Cookie-authenticated endpoints additionally require a custom header (forces a CORS preflight for foreign sites). */
export const requireXhr: RequestHandler = (req, _res, next) => {
  if (req.get('x-requested-with') !== 'tawa') return next(forbidden('Missing required header.'))
  next()
}

// ---------- rate limiting ----------
export function limiter(opts: { windowMs: number; limit: number; message?: string; key?: (req: Request) => string }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs, limit: opts.limit, standardHeaders: 'draft-7', legacyHeaders: false,
    skip: () => isTest,
    keyGenerator: opts.key ?? ((req) => req.ip ?? 'unknown'),
    validate: { keyGeneratorIpFallback: false },
    handler: (_req, res) => { res.status(429).json({ error: { code: 'rate_limited', message: opts.message ?? 'Too many requests. Please slow down and try again shortly.' } }) },
  })
}
export const limits = {
  global: limiter({ windowMs: 60_000, limit: 300 }),
  auth: limiter({ windowMs: 15 * 60_000, limit: 20, message: 'Too many attempts. Please try again in a few minutes.' }),
  login: limiter({ windowMs: 15 * 60_000, limit: 10, message: 'Too many sign-in attempts. Please try again in 15 minutes.' }),
  email: limiter({ windowMs: 60 * 60_000, limit: 5, message: 'Too many requests. Please try again later.' }),
  write: limiter({ windowMs: 60 * 60_000, limit: 20 }),
  lookup: limiter({ windowMs: 15 * 60_000, limit: 15, message: 'Too many lookups. Please try again later.' }),
  admin: limiter({ windowMs: 60_000, limit: 120 }),
}

// ---------- validation ----------
export const parse = <T>(schema: ZodType<T>, data: unknown): T => schema.parse(data)

// ---------- errors ----------
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } })
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return
  const requestId = (req as any).id as string | undefined
  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err, requestId }, 'request failed')
    return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } })
  }
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {}
    for (const i of err.issues) fields[i.path.join('.') || '_'] ??= i.message
    return void res.status(400).json({ error: { code: 'validation_error', message: 'Please check the highlighted fields.', details: fields, requestId } })
  }
  if (err instanceof MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 2 MB).' : 'Invalid file upload.'
    return void res.status(400).json({ error: { code: 'upload_error', message: msg, requestId } })
  }
  const e = err as { type?: string; status?: number }
  if (e?.type === 'entity.too.large') return void res.status(413).json({ error: { code: 'too_large', message: 'Request body too large.', requestId } })
  if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body.', requestId } })
  logger.error({ err, requestId, path: req.path }, 'unhandled error')
  res.status(500).json({ error: { code: 'internal_error', message: isProd ? 'Something went wrong on our side.' : String((err as Error)?.message ?? err), requestId } })
}

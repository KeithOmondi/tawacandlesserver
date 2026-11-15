import { randomBytes } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { PRIVACY_VERSION, TERMS_VERSION, config } from '../config.ts'
import { getDb } from '../db/index.ts'
import { audit } from '../lib/audit.ts'
import {
  decrypt, dummyHash, encrypt, hashPassword, newTotpSecret, passwordProblem, randomToken, sha256, totpUri, verifyPassword, verifyTotp,
} from '../lib/crypto.ts'
import { HttpError, badRequest, unauthorized } from '../lib/errors.ts'
import { link, mail, templates } from '../lib/mailer.ts'
import {
  REFRESH_COOKIE, clearRefreshCookie, createSession, revokeAllSessions, revokeSessionByToken, rotateSession, setRefreshCookie,
} from '../lib/sessions.ts'
import { signAccess, signMfaChallenge, verifyMfaChallenge } from '../lib/tokens.ts'
import { limits, parse, requireAuth, requireXhr } from '../middleware/index.ts'

export const router = Router()

export const emailSchema = z.email().max(254).transform((s) => s.trim().toLowerCase())
const nameSchema = z.string().trim().min(2, 'Please enter your name.').max(100)
const phoneSchema = z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number.')
const passwordField = z.string().min(1).max(256)

interface UserRow {
  id: string; email: string; password_hash: string; name: string; phone: string | null; role: 'customer' | 'admin'
  email_verified_at: Date | null; failed_logins: number; locked_until: Date | null; mfa_enabled: boolean; mfa_secret_enc: string | null
  mfa_last_step: number | null; mfa_recovery: string[]; disabled: boolean; deleted_at: Date | null; marketing_opt_in: boolean; created_at: Date
}

export const publicUser = (u: Pick<UserRow, 'id' | 'email' | 'name' | 'phone' | 'role' | 'email_verified_at' | 'mfa_enabled' | 'marketing_opt_in' | 'created_at'>) => ({
  id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role,
  emailVerified: !!u.email_verified_at, mfaEnabled: u.mfa_enabled, marketingOptIn: u.marketing_opt_in, createdAt: u.created_at,
})

const LOCK_AFTER = 5
const LOCK_MINUTES = 15
const GENERIC_LOGIN_ERROR = 'Incorrect email or password, or the account is temporarily locked.'

async function findByEmail(email: string) {
  const db = await getDb()
  return (await db.query<UserRow>('SELECT * FROM users WHERE lower(email) = $1', [email])).rows[0]
}

async function newEmailToken(userId: string, purpose: 'verify' | 'reset', ttlMinutes: number) {
  const db = await getDb()
  await db.query('UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose])
  const token = randomToken(32)
  await db.query('INSERT INTO email_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)', [userId, purpose, sha256(token), new Date(Date.now() + ttlMinutes * 60_000)])
  return token
}

async function consumeEmailToken(token: string, purpose: 'verify' | 'reset'): Promise<string | null> {
  const db = await getDb()
  // Single atomic statement: the token can only ever be redeemed once.
  const r = await db.query<{ user_id: string }>(
    `UPDATE email_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), purpose])
  return r.rows[0]?.user_id ?? null
}

async function startSession(req: Request, res: Response, u: UserRow, mfa: boolean) {
  const refresh = await createSession(u.id, req)
  setRefreshCookie(res, refresh)
  return { accessToken: await signAccess(u.id, u.role, mfa), user: publicUser(u) }
}

// ---------- registration & email verification ----------
router.post('/register', limits.auth, async (req, res) => {
  const body = parse(z.object({
    name: nameSchema, email: emailSchema, password: passwordField, phone: phoneSchema.optional().or(z.literal('').transform(() => undefined)),
    acceptTerms: z.literal(true, { error: 'You must accept the Terms of Service and Privacy Policy.' }),
    marketing: z.boolean().optional(),
  }), req.body)
  const problem = passwordProblem(body.password, { email: body.email, name: body.name })
  if (problem) throw new HttpError(400, 'validation_error', problem, { password: problem })

  const hash = await hashPassword(body.password) // always hash: equalises timing for new vs existing emails
  const db = await getDb()
  const existing = await findByEmail(body.email)
  if (existing) {
    await mail(existing.email, templates.alreadyRegistered(existing.name, link('/forgot-password')))
    await audit('auth.register.duplicate', req, { actorEmail: body.email })
  } else {
    const r = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, phone, terms_version, privacy_version, consent_at, marketing_opt_in)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7) RETURNING id`,
      [body.email, hash, body.name, body.phone ?? null, TERMS_VERSION, PRIVACY_VERSION, body.marketing ?? false])
    const id = r.rows[0].id
    const token = await newEmailToken(id, 'verify', 24 * 60)
    await mail(body.email, templates.verify(body.name, link(`/verify-email?token=${token}`)))
    await audit('auth.register', req, { actorId: id, actorEmail: body.email })
  }
  // Identical response whether or not the address was already registered (no account enumeration).
  res.status(202).json({ message: 'Check your email to verify your account.' })
})

router.post('/verify-email', limits.auth, async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body)
  const userId = await consumeEmailToken(token, 'verify')
  if (!userId) throw badRequest('This verification link is invalid or has expired.')
  const db = await getDb()
  await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1', [userId])
  await audit('auth.email_verified', req, { actorId: userId })
  res.json({ message: 'Email verified. You can now sign in.' })
})

router.post('/resend-verification', limits.email, async (req, res) => {
  const { email } = parse(z.object({ email: emailSchema }), req.body)
  const u = await findByEmail(email)
  if (u && !u.email_verified_at && !u.disabled && !u.deleted_at) {
    const token = await newEmailToken(u.id, 'verify', 24 * 60)
    await mail(u.email, templates.verify(u.name, link(`/verify-email?token=${token}`)))
  }
  res.status(202).json({ message: 'If that account needs verification, we have sent a new link.' })
})

// ---------- login ----------
router.post('/login', limits.login, async (req, res) => {
  const { email, password } = parse(z.object({ email: emailSchema, password: passwordField }), req.body)
  const db = await getDb()
  const u = await findByEmail(email)

  if (!u) {
    await verifyPassword(password, await dummyHash())
    await audit('auth.login.failed', req, { actorEmail: email, meta: { reason: 'unknown_user' } })
    throw unauthorized(GENERIC_LOGIN_ERROR)
  }
  if (u.locked_until && u.locked_until > new Date()) {
    await audit('auth.login.locked', req, { actorId: u.id, actorEmail: u.email })
    throw unauthorized(GENERIC_LOGIN_ERROR)
  }
  const ok = await verifyPassword(password, u.password_hash)
  if (!ok || u.disabled || u.deleted_at) {
    const fails = u.failed_logins + 1
    const lock = fails >= LOCK_AFTER
    await db.query('UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1', [u.id, lock ? 0 : fails, lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null])
    await audit(lock ? 'auth.account_locked' : 'auth.login.failed', req, { actorId: u.id, actorEmail: u.email, meta: { reason: ok ? 'disabled' : 'bad_password' } })
    throw unauthorized(GENERIC_LOGIN_ERROR)
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id])

  if (u.mfa_enabled) {
    await audit('auth.login.mfa_challenge', req, { actorId: u.id, actorEmail: u.email })
    return void res.json({ mfaRequired: true, mfaToken: await signMfaChallenge(u.id) })
  }
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id])
  await audit('auth.login', req, { actorId: u.id, actorEmail: u.email })
  res.json(await startSession(req, res, u, false))
})

router.post('/mfa/login', limits.login, async (req, res) => {
  const body = parse(z.object({ mfaToken: z.string().min(20), code: z.string().trim().min(6).max(20) }), req.body)
  let userId: string
  try { userId = await verifyMfaChallenge(body.mfaToken) } catch { throw unauthorized('Your sign-in attempt expired. Please start again.') }
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId])).rows[0]
  if (!u || !u.mfa_enabled || !u.mfa_secret_enc || u.disabled || u.deleted_at) throw unauthorized('Invalid code.')
  if (u.locked_until && u.locked_until > new Date()) throw unauthorized('Invalid code.')

  let ok = false
  const step = verifyTotp(decrypt(u.mfa_secret_enc), body.code)
  if (step !== null && (u.mfa_last_step === null || step > u.mfa_last_step)) {
    ok = true
    await db.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1', [u.id, step]) // blocks replay of the same code
  } else {
    const hash = sha256(body.code.replace(/\s/g, '').toLowerCase())
    if (u.mfa_recovery.includes(hash)) {
      ok = true
      await db.query('UPDATE users SET mfa_recovery = $2 WHERE id = $1', [u.id, JSON.stringify(u.mfa_recovery.filter((h) => h !== hash))])
      await audit('auth.mfa.recovery_used', req, { actorId: u.id, actorEmail: u.email })
    }
  }
  if (!ok) {
    const fails = u.failed_logins + 1
    const lock = fails >= LOCK_AFTER
    await db.query('UPDATE users SET failed_logins = $2, locked_until = $3 WHERE id = $1', [u.id, lock ? 0 : fails, lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null])
    await audit('auth.mfa.failed', req, { actorId: u.id, actorEmail: u.email })
    throw unauthorized('Invalid code.')
  }
  await db.query('UPDATE users SET failed_logins = 0, last_login_at = now() WHERE id = $1', [u.id])
  await audit('auth.login', req, { actorId: u.id, actorEmail: u.email, meta: { mfa: true } })
  res.json(await startSession(req, res, u, true))
})

// ---------- session refresh / logout ----------
router.post('/refresh', requireXhr, limits.global, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined
  if (!token) throw unauthorized('Not signed in.')
  const r = await rotateSession(token, req)
  if (!r.ok) {
    clearRefreshCookie(res)
    if (r.reason === 'reuse') await audit('auth.refresh.reuse_detected', req)
    throw unauthorized('Session expired. Please sign in again.')
  }
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [r.userId])).rows[0]
  if (!u || u.disabled || u.deleted_at) { clearRefreshCookie(res); await revokeAllSessions(r.userId); throw unauthorized('Session expired. Please sign in again.') }
  setRefreshCookie(res, r.token)
  // MFA state survives refresh: a session born from an MFA login keeps mfa=true.
  res.json({ accessToken: await signAccess(u.id, u.role, u.mfa_enabled), user: publicUser(u) })
})

router.post('/logout', requireXhr, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined
  if (token) await revokeSessionByToken(token)
  clearRefreshCookie(res)
  res.status(204).end()
})

router.post('/logout-all', requireAuth, async (req, res) => {
  await revokeAllSessions(req.user!.id)
  clearRefreshCookie(res)
  await audit('auth.logout_all', req)
  res.status(204).end()
})

router.get('/me', requireAuth, async (req, res) => {
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])).rows[0]
  res.json({ user: publicUser(u) })
})

// ---------- password reset / change ----------
router.post('/forgot-password', limits.email, async (req, res) => {
  const { email } = parse(z.object({ email: emailSchema }), req.body)
  const u = await findByEmail(email)
  if (u && !u.disabled && !u.deleted_at) {
    const token = await newEmailToken(u.id, 'reset', 60)
    await mail(u.email, templates.reset(u.name, link(`/reset-password?token=${token}`)))
    await audit('auth.password_reset_requested', req, { actorId: u.id, actorEmail: u.email })
  }
  res.status(202).json({ message: 'If an account exists for that email, a reset link is on its way.' })
})

router.post('/reset-password', limits.auth, async (req, res) => {
  const { token, password } = parse(z.object({ token: z.string().min(20).max(200), password: passwordField }), req.body)
  const db = await getDb()
  // Check the password rules before burning the single-use token.
  const peek = await db.query<{ user_id: string }>(`SELECT user_id FROM email_tokens WHERE token_hash = $1 AND purpose = 'reset' AND used_at IS NULL AND expires_at > now()`, [sha256(token)])
  if (!peek.rows[0]) throw badRequest('This reset link is invalid or has expired.')
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [peek.rows[0].user_id])).rows[0]
  const problem = passwordProblem(password, { email: u.email, name: u.name })
  if (problem) throw new HttpError(400, 'validation_error', problem, { password: problem })

  const userId = await consumeEmailToken(token, 'reset')
  if (!userId) throw badRequest('This reset link is invalid or has expired.')
  await db.query(
    `UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1`,
    [userId, await hashPassword(password)])
  await revokeAllSessions(userId) // a reset signs out every device
  await mail(u.email, templates.passwordChanged(u.name))
  await audit('auth.password_reset', req, { actorId: userId, actorEmail: u.email })
  res.json({ message: 'Password updated. Please sign in with your new password.' })
})

router.post('/change-password', requireAuth, limits.auth, async (req, res) => {
  const { currentPassword, newPassword } = parse(z.object({ currentPassword: passwordField, newPassword: passwordField }), req.body)
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])).rows[0]
  if (!(await verifyPassword(currentPassword, u.password_hash))) throw new HttpError(400, 'validation_error', 'Current password is incorrect.', { currentPassword: 'Current password is incorrect.' })
  const problem = passwordProblem(newPassword, { email: u.email, name: u.name })
  if (problem) throw new HttpError(400, 'validation_error', problem, { newPassword: problem })
  await db.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [u.id, await hashPassword(newPassword)])
  const current = req.cookies?.[REFRESH_COOKIE] as string | undefined
  await revokeAllSessions(u.id, current) // keep this device signed in, drop the rest
  await mail(u.email, templates.passwordChanged(u.name))
  await audit('auth.password_changed', req)
  res.json({ message: 'Password changed.' })
})

// ---------- multi-factor authentication (TOTP) ----------
router.post('/mfa/setup', requireAuth, limits.auth, async (req, res) => {
  const { password } = parse(z.object({ password: passwordField }), req.body)
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])).rows[0]
  if (!(await verifyPassword(password, u.password_hash))) throw unauthorized('Incorrect password.')
  if (u.mfa_enabled) throw badRequest('Two-factor authentication is already enabled.')
  const secret = newTotpSecret()
  await db.query('UPDATE users SET mfa_secret_enc = $2 WHERE id = $1', [u.id, encrypt(secret)])
  res.json({ secret, otpauthUri: totpUri(secret, u.email) })
})

router.post('/mfa/enable', requireAuth, limits.auth, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().length(6) }), req.body)
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])).rows[0]
  if (u.mfa_enabled || !u.mfa_secret_enc) throw badRequest('Start setup first.')
  const step = verifyTotp(decrypt(u.mfa_secret_enc), code)
  if (step === null) throw badRequest('That code is not correct. Check your authenticator app and try again.')
  const recovery = Array.from({ length: 8 }, () => { const h = randomBytes(6).toString('hex'); return `${h.slice(0, 6)}-${h.slice(6)}` })
  await db.query('UPDATE users SET mfa_enabled = true, mfa_last_step = $2, mfa_recovery = $3, updated_at = now() WHERE id = $1', [u.id, step, JSON.stringify(recovery.map((c) => sha256(c)))])
  await revokeAllSessions(u.id, req.cookies?.[REFRESH_COOKIE] as string | undefined) // older, pre-MFA sessions must not inherit mfa=true
  await audit('auth.mfa.enabled', req)
  // Upgrade this session: the access token now carries mfa=true.
  res.json({ recoveryCodes: recovery, accessToken: await signAccess(u.id, u.role, true) })
})

router.post('/mfa/disable', requireAuth, limits.auth, async (req, res) => {
  const { password, code } = parse(z.object({ password: passwordField, code: z.string().trim().length(6) }), req.body)
  const db = await getDb()
  const u = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [req.user!.id])).rows[0]
  if (u.role === 'admin' && config.ADMIN_REQUIRE_MFA) throw new HttpError(403, 'forbidden', 'Administrators cannot disable two-factor authentication.')
  if (!u.mfa_enabled || !u.mfa_secret_enc) throw badRequest('Two-factor authentication is not enabled.')
  if (!(await verifyPassword(password, u.password_hash))) throw unauthorized('Incorrect password.')
  if (verifyTotp(decrypt(u.mfa_secret_enc), code) === null) throw badRequest('That code is not correct.')
  await db.query(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL, mfa_recovery = '[]', mfa_last_step = NULL WHERE id = $1`, [u.id])
  await audit('auth.mfa.disabled', req)
  res.json({ message: 'Two-factor authentication disabled.', accessToken: await signAccess(u.id, u.role, false) })
})

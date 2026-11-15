/**
 * Creates (or resets) an administrator account.
 *
 *   npm run admin:create -- owner@example.com "Owner Name"
 *   ADMIN_PASSWORD='…' npm run admin:create -- owner@example.com
 *   npm run admin:create -- owner@example.com --reset-mfa     (only if the admin lost their authenticator AND recovery codes)
 *
 * If ADMIN_PASSWORD is not set a strong random password is generated and printed once.
 */
import { randomBytes } from 'node:crypto'
import { closeDb, getDb } from '../db/index.ts'
import { migrate } from '../db/migrate.ts'
import { hashPassword, passwordProblem } from '../lib/crypto.ts'
import { audit } from '../lib/audit.ts'
import { revokeAllSessions } from '../lib/sessions.ts'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const resetMfa = process.argv.includes('--reset-mfa')
const email = args[0]?.trim().toLowerCase()
const name = args[1]?.trim() || 'Store Admin'
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run admin:create -- <email> ["Full Name"] [--reset-mfa]')
  process.exit(1)
}

const generated = !process.env.ADMIN_PASSWORD
const password = process.env.ADMIN_PASSWORD ?? randomBytes(18).toString('base64url')
const problem = passwordProblem(password, { email, name })
if (problem) { console.error(`Password rejected: ${problem}`); process.exit(1) }

await migrate()
const db = await getDb()
const hash = await hashPassword(password)
const existing = (await db.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0]
if (existing) {
  await db.query(
    `UPDATE users SET role = 'admin', password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()), disabled = false, deleted_at = NULL,
       failed_logins = 0, locked_until = NULL,
       mfa_enabled = CASE WHEN $3::boolean THEN false ELSE mfa_enabled END, mfa_secret_enc = CASE WHEN $3::boolean THEN NULL ELSE mfa_secret_enc END,
       mfa_recovery = CASE WHEN $3::boolean THEN '[]'::jsonb ELSE mfa_recovery END, updated_at = now() WHERE id = $1`,
    [existing.id, hash, resetMfa])
  await revokeAllSessions(existing.id)
  await audit('cli.admin.reset', null, { actorEmail: 'cli', target: email, meta: { resetMfa } })
  console.log(`Updated existing account ${email} → admin${resetMfa ? ' (MFA reset)' : ''}.`)
} else {
  await db.query(
    `INSERT INTO users (email, password_hash, name, role, email_verified_at, terms_version, privacy_version, consent_at) VALUES ($1,$2,$3,'admin',now(),'cli','cli',now())`,
    [email, hash, name])
  await audit('cli.admin.create', null, { actorEmail: 'cli', target: email })
  console.log(`Created admin ${email}.`)
}
if (generated) console.log(`\nGenerated password (shown once — store it in a password manager):\n\n  ${password}\n`)
console.log('Sign in at /login — you will be required to enrol two-factor authentication on first use.')
await closeDb()

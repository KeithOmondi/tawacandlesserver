import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { audit } from '../lib/audit.ts'
import { hashPassword, verifyPassword } from '../lib/crypto.ts'
import { forbidden, notFound, unauthorized } from '../lib/errors.ts'
import { loadOrder, serializeOrder } from '../lib/orders.ts'
import { clearRefreshCookie, revokeAllSessions } from '../lib/sessions.ts'
import { limits, parse, requireAuth } from '../middleware/index.ts'
import { publicUser } from './auth.ts'

export const router = Router()
router.use(requireAuth)

const phone = z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number.')

router.patch('/profile', async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100).optional(),
    phone: phone.nullable().optional().or(z.literal('').transform(() => null)),
    marketingOptIn: z.boolean().optional(),
  }), req.body)
  const db = await getDb()
  const r = await db.query(
    `UPDATE users SET name = COALESCE($2, name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
       marketing_opt_in = COALESCE($5, marketing_opt_in), updated_at = now() WHERE id = $1 RETURNING *`,
    [req.user!.id, b.name ?? null, b.phone !== undefined, b.phone ?? null, b.marketingOptIn ?? null])
  res.json({ user: publicUser(r.rows[0] as any) })
})

// ---------- addresses ----------
const addressSchema = z.object({
  label: z.string().trim().min(1).max(30).default('Home'),
  name: z.string().trim().min(2).max(100), phone,
  line1: z.string().trim().min(3).max(200), line2: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  city: z.string().trim().min(2).max(100), region: z.string().trim().min(2).max(100),
  postcode: z.string().trim().min(2).max(20), country: z.string().trim().min(2).max(60).default('Kenya'),
  isDefault: z.boolean().default(false),
})
const ADDR = `id, label, name, phone, line1, line2, city, region, postcode, country, is_default AS "isDefault"`

router.get('/addresses', async (req, res) => {
  const db = await getDb()
  res.json({ addresses: (await db.query(`SELECT ${ADDR} FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at`, [req.user!.id])).rows })
})
router.post('/addresses', limits.write, async (req, res) => {
  const a = parse(addressSchema, req.body)
  const db = await getDb()
  const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM addresses WHERE user_id = $1', [req.user!.id])).rows[0].n
  if (n >= 10) throw forbidden('You can save up to 10 addresses.')
  const row = await db.tx(async (q) => {
    const makeDefault = a.isDefault || n === 0
    if (makeDefault) await q.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user!.id])
    return (await q.query(`INSERT INTO addresses (user_id,label,name,phone,line1,line2,city,region,postcode,country,is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${ADDR}`,
      [req.user!.id, a.label, a.name, a.phone, a.line1, a.line2 ?? null, a.city, a.region, a.postcode, a.country, makeDefault])).rows[0]
  })
  res.status(201).json({ address: row })
})
router.put('/addresses/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id)
  const a = parse(addressSchema, req.body)
  const db = await getDb()
  const row = await db.tx(async (q) => {
    if (a.isDefault) await q.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user!.id])
    return (await q.query(`UPDATE addresses SET label=$3,name=$4,phone=$5,line1=$6,line2=$7,city=$8,region=$9,postcode=$10,country=$11,is_default=$12 WHERE id=$1 AND user_id=$2 RETURNING ${ADDR}`,
      [id, req.user!.id, a.label, a.name, a.phone, a.line1, a.line2 ?? null, a.city, a.region, a.postcode, a.country, a.isDefault])).rows[0]
  })
  if (!row) throw notFound('Address not found')
  res.json({ address: row })
})
router.delete('/addresses/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id)
  const db = await getDb()
  const r = await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [id, req.user!.id])
  if (!r.rowCount) throw notFound('Address not found')
  res.status(204).end()
})

// ---------- orders ----------
router.get('/orders', async (req, res) => {
  const db = await getDb()
  // Verified accounts also see guest orders placed with the same email address.
  const ids = (await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE user_id = $1 OR ($3::boolean AND lower(email) = lower($2)) ORDER BY created_at DESC LIMIT 100`,
    [req.user!.id, req.user!.email, req.user!.emailVerified])).rows
  const out = []
  for (const { id } of ids) { const l = (await loadOrder(id))!; out.push(serializeOrder(l.row, l.items)) }
  res.json({ orders: out })
})

// ---------- data rights: export & erasure ----------
router.get('/export', limits.lookup, async (req, res) => {
  const db = await getDb()
  const u = (await db.query('SELECT id,email,name,phone,role,email_verified_at,marketing_opt_in,terms_version,privacy_version,consent_at,created_at,last_login_at FROM users WHERE id = $1', [req.user!.id])).rows[0]
  const addresses = (await db.query(`SELECT ${ADDR} FROM addresses WHERE user_id = $1`, [req.user!.id])).rows
  const ids = (await db.query<{ id: string }>('SELECT id FROM orders WHERE user_id = $1 OR lower(email) = lower($2)', [req.user!.id, req.user!.email])).rows
  const orders = []
  for (const { id } of ids) { const l = (await loadOrder(id))!; orders.push(serializeOrder(l.row, l.items)) }
  const reviews = (await db.query('SELECT product_id, rating, title, body, status, created_at FROM reviews WHERE user_id = $1', [req.user!.id])).rows
  const messages = (await db.query('SELECT subject, body, created_at FROM messages WHERE lower(email) = lower($1)', [req.user!.email])).rows
  const custom = (await db.query('SELECT id, vessel, size, color, scent, label, occasion, quantity, status, created_at FROM custom_requests WHERE user_id = $1 OR lower(email) = lower($2)', [req.user!.id, req.user!.email])).rows
  await audit('account.export', req)
  res.set('Content-Disposition', 'attachment; filename="tawa-my-data.json"').json({ exportedAt: new Date(), account: u, addresses, orders, reviews, messages, customRequests: custom })
})

router.post('/delete', limits.auth, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(256) }), req.body)
  if (req.user!.role === 'admin') throw forbidden('Administrator accounts cannot be self-deleted.')
  const db = await getDb()
  const u = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [req.user!.id])).rows[0]
  if (!(await verifyPassword(password, u.password_hash))) throw unauthorized('Incorrect password.')
  const id = req.user!.id, email = req.user!.email
  await db.tx(async (q) => {
    // Orders are kept (tax/accounting retention) but detached from the account.
    await q.query('UPDATE orders SET user_id = NULL WHERE user_id = $1', [id])
    await q.query('DELETE FROM addresses WHERE user_id = $1', [id])
    await q.query('DELETE FROM wishlist WHERE user_id = $1', [id])
    await q.query('DELETE FROM subscribers WHERE lower(email) = lower($1)', [email])
    await q.query(`UPDATE reviews SET name = 'Former customer', user_id = NULL WHERE user_id = $1`, [id])
    await q.query(
      `UPDATE users SET email = $2, name = 'Deleted user', phone = NULL, password_hash = $3, mfa_enabled = false, mfa_secret_enc = NULL,
         mfa_recovery = '[]', disabled = true, marketing_opt_in = false, deleted_at = now(), updated_at = now() WHERE id = $1`,
      [id, `deleted-${id}@deleted.invalid`, await hashPassword(randomBytes(32).toString('hex'))])
  })
  await revokeAllSessions(id)
  clearRefreshCookie(res)
  await audit('account.deleted', req, { actorId: id, actorEmail: email })
  res.status(204).end()
})

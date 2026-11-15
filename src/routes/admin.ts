import { createReadStream } from 'node:fs'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { deleteProductImage, uploadProductImage } from '../lib/r2.ts'
import { getDb } from '../db/index.ts'
import { audit } from '../lib/audit.ts'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts'
import { link, mail, templates } from '../lib/mailer.ts'
import { ORDER_STATUSES, cancelOrder, loadOrder, serializeOrder } from '../lib/orders.ts'
import { money } from '../lib/pricing.ts'
import { revokeAllSessions } from '../lib/sessions.ts'
import { mimeFor, uploadPath } from '../lib/uploads.ts'
import { limits, parse, requireAdmin } from '../middleware/index.ts'
import { PRODUCT_SELECT } from './catalog.ts'

export const router = Router()
router.use(limits.admin, requireAdmin)

const page = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) })
const like = (s: string) => `%${s.replace(/[\\%_]/g, '\\$&')}%`
const id = (v: unknown) => parse(z.uuid(), v)

// ---------- dashboard ----------
router.get('/stats', async (_req, res) => {
  const db = await getDb()
  const one = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n
  res.json({
    orders: await one(`SELECT count(*) AS n FROM orders`),
    openOrders: await one(`SELECT count(*) AS n FROM orders WHERE status IN ('Processing','Packed')`),
    awaitingPayment: await one(`SELECT count(*) AS n FROM orders WHERE status = 'Pending payment'`),
    revenue: await one(`SELECT COALESCE(sum(total),0) AS n FROM orders WHERE payment_status = 'paid' AND status <> 'Cancelled'`),
    revenue30d: await one(`SELECT COALESCE(sum(total),0) AS n FROM orders WHERE payment_status = 'paid' AND status <> 'Cancelled' AND created_at > now() - interval '30 days'`),
    unreadMessages: await one(`SELECT count(*) AS n FROM messages WHERE NOT read`),
    newCustomRequests: await one(`SELECT count(*) AS n FROM custom_requests WHERE status = 'New'`),
    subscribers: await one(`SELECT count(*) AS n FROM subscribers`),
    customers: await one(`SELECT count(*) AS n FROM users WHERE role = 'customer' AND deleted_at IS NULL`),
    lowStock: (await db.query(`SELECT id, name, stock FROM products WHERE active AND stock <= 10 ORDER BY stock LIMIT 10`)).rows,
    pendingReviews: await one(`SELECT count(*) AS n FROM reviews WHERE status = 'pending'`),
  })
})

// ---------- orders ----------
router.get('/orders', async (req, res) => {
  const q = parse(page.extend({ status: z.enum(ORDER_STATUSES).optional(), q: z.string().trim().max(100).optional() }), req.query)
  const db = await getDb()
  const where = ['($1::text IS NULL OR status = $1)', `($2::text IS NULL OR id ILIKE $2 ESCAPE '\\' OR email ILIKE $2 ESCAPE '\\' OR name ILIKE $2 ESCAPE '\\')`]
  const args = [q.status ?? null, q.q ? like(q.q) : null]
  const total = (await db.query<{ n: number }>(`SELECT count(*) AS n FROM orders WHERE ${where.join(' AND ')}`, args)).rows[0].n
  const rows = (await db.query<{ id: string }>(`SELECT id FROM orders WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $3 OFFSET $4`, [...args, q.limit, (q.page - 1) * q.limit])).rows
  const orders = []
  for (const r of rows) { const l = (await loadOrder(r.id))!; orders.push(serializeOrder(l.row, l.items)) }
  res.json({ orders, total, page: q.page, limit: q.limit })
})

router.patch('/orders/:orderId', async (req, res) => {
  const orderId = parse(z.string().min(3).max(30), req.params.orderId).toUpperCase()
  const b = parse(z.object({
    status: z.enum(ORDER_STATUSES).optional(),
    paymentStatus: z.enum(['pending', 'paid', 'failed', 'refunded']).optional(),
    trackingRef: z.string().trim().max(100).nullable().optional(),
  }), req.body)
  const l = await loadOrder(orderId)
  if (!l) throw notFound('Order not found')
  const o = l.row
  const db = await getDb()

  if (b.status && b.status !== o.status) {
    if (o.status === 'Cancelled') throw conflict('Cancelled orders cannot be reopened. Ask the customer to place a new order.')
    if (b.status === 'Cancelled') await cancelOrder(orderId, req, 'admin')
    else {
      await db.query(
        `UPDATE orders SET status = $2, payment_status = CASE WHEN $2 = 'Delivered' AND payment_method = 'cod' THEN 'paid' ELSE payment_status END, updated_at = now() WHERE id = $1`,
        [orderId, b.status])
    }
  }
  if (b.paymentStatus) await db.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [orderId, b.paymentStatus])
  if (b.trackingRef !== undefined) await db.query('UPDATE orders SET tracking_ref = $2, updated_at = now() WHERE id = $1', [orderId, b.trackingRef])

  const fresh = (await loadOrder(orderId))!
  await audit('admin.order.update', req, { target: orderId, meta: b })
  if (b.status && b.status !== o.status && ['Shipped', 'Delivered', 'Cancelled', 'Packed'].includes(b.status)) {
    await mail(fresh.row.email, templates.orderStatus({ id: orderId, name: fresh.row.name, status: fresh.row.status, tracking: fresh.row.tracking_ref }, link(`/account?order=${orderId}`)))
  }
  res.json({ order: serializeOrder(fresh.row, fresh.items) })
})

// ---------- products ----------
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const sizeSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9]{1,10}$/).optional(), label: z.string().trim().min(1).max(60),
  weight: z.string().trim().max(30).default(''), burn: z.string().trim().max(30).default(''), price: z.number().int().min(0).max(10_000_000),
})
const productSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(100).optional(),
  tagline: z.string().trim().max(160).default(''),
  category: z.enum(['Jar Candles', 'Tin Candles', 'Pillars', 'Gift Sets']),
  vessel: z.enum(['jar', 'tin', 'tumbler', 'pillar']),
  wax: hex.default('#f1d9a8'), accent: hex.default('#c98a3c'),
  scentFamily: z.string().trim().max(60).default(''),
  notes: z.object({ top: z.string().max(200).default(''), heart: z.string().max(200).default(''), base: z.string().max(200).default('') }).default({ top: '', heart: '', base: '' }),
  description: z.string().trim().max(3000).default(''),
  badge: z.string().trim().max(30).nullable().optional(),
  compareAt: z.number().int().min(0).nullable().optional(),
  stock: z.number().int().min(0).max(1_000_000),
  featured: z.boolean().default(false), active: z.boolean().default(true),
  sizes: z.array(sizeSchema).min(1).max(8),
})
const slugify = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

router.get('/products', async (_req, res) => {
  const db = await getDb()
  res.json({ products: (await db.query(`${PRODUCT_SELECT} ORDER BY p.sort, p.name`)).rows })
})

async function saveProduct(productId: string | null, p: z.infer<typeof productSchema>) {
  const db = await getDb()
  return db.tx(async (q) => {
    const slug = p.slug ?? slugify(p.name)
    const dup = await q.query('SELECT 1 FROM products WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)', [slug, productId])
    if (dup.rowCount) throw conflict('A product with that URL slug already exists.')
    const vals = [slug, p.name, p.tagline, p.category, p.vessel, p.wax, p.accent, p.scentFamily, JSON.stringify(p.notes), p.description, p.badge ?? null, p.compareAt ?? null, p.stock, p.featured, p.active]
    let pid = productId
    if (pid) {
      const r = await q.query(`UPDATE products SET slug=$2,name=$3,tagline=$4,category=$5,vessel=$6,wax=$7,accent=$8,scent_family=$9,notes=$10,description=$11,badge=$12,compare_at=$13,stock=$14,featured=$15,active=$16,updated_at=now() WHERE id=$1`, [pid, ...vals])
      if (!r.rowCount) throw notFound('Product not found')
      await q.query('DELETE FROM product_sizes WHERE product_id = $1', [pid])
    } else {
      pid = (await q.query<{ id: string }>(`INSERT INTO products (slug,name,tagline,category,vessel,wax,accent,scent_family,notes,description,badge,compare_at,stock,featured,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`, vals)).rows[0].id
    }
    // Size codes are internal IDs (carts reference them). Existing sizes keep theirs; new ones get one generated.
    const codes = new Set<string>()
    for (const s of p.sizes) if (s.code) { if (codes.has(s.code)) throw badRequest('Duplicate size.'); codes.add(s.code) }
    let n = 0
    for (const s of p.sizes) {
      let code = s.code
      if (!code) { do { n++ } while (codes.has(`s${n}`)); code = `s${n}`; codes.add(code) }
      await q.query('INSERT INTO product_sizes (product_id,code,label,weight,burn,price) VALUES ($1,$2,$3,$4,$5,$6)', [pid, code, s.label, s.weight, s.burn, s.price])
    }
    return pid!
  })
}

router.post('/products', async (req, res) => {
  const pid = await saveProduct(null, parse(productSchema, req.body))
  await audit('admin.product.create', req, { target: pid })
  const db = await getDb()
  res.status(201).json({ product: (await db.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [pid])).rows[0] })
})
router.put('/products/:id', async (req, res) => {
  const pid = id(req.params.id)
  await saveProduct(pid, parse(productSchema, req.body))
  await audit('admin.product.update', req, { target: pid })
  const db = await getDb()
  res.json({ product: (await db.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [pid])).rows[0] })
})
const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } })
router.post('/products/:id/image', imageUpload.single('image'), async (req, res) => {
  const pid = id(req.params.id)
  if (!req.file) throw badRequest('Choose an image to upload.')
  const db = await getDb()
  const old = (await db.query<{ image: string | null }>('SELECT image FROM products WHERE id = $1', [pid])).rows[0]
  if (!old) throw notFound('Product not found')
  const url = await uploadProductImage(req.file.buffer)
  await db.query('UPDATE products SET image = $2, updated_at = now() WHERE id = $1', [pid, url])
  await deleteProductImage(old.image)
  await audit('admin.product.image', req, { target: pid })
  res.json({ product: (await db.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [pid])).rows[0] })
})
router.delete('/products/:id/image', async (req, res) => {
  const pid = id(req.params.id)
  const db = await getDb()
  const old = (await db.query<{ image: string | null }>('SELECT image FROM products WHERE id = $1', [pid])).rows[0]
  if (!old) throw notFound('Product not found')
  await db.query('UPDATE products SET image = NULL, updated_at = now() WHERE id = $1', [pid])
  await deleteProductImage(old.image)
  await audit('admin.product.image.remove', req, { target: pid })
  res.json({ product: (await db.query(`${PRODUCT_SELECT} WHERE p.id = $1`, [pid])).rows[0] })
})
router.patch('/products/:id/stock', async (req, res) => {
  const pid = id(req.params.id)
  const { stock } = parse(z.object({ stock: z.number().int().min(0).max(1_000_000) }), req.body)
  const db = await getDb()
  const r = await db.query('UPDATE products SET stock = $2, updated_at = now() WHERE id = $1', [pid, stock])
  if (!r.rowCount) throw notFound('Product not found')
  await audit('admin.product.stock', req, { target: pid, meta: { stock } })
  res.json({ ok: true })
})
router.delete('/products/:id', async (req, res) => {
  const pid = id(req.params.id)
  const db = await getDb()
  // Soft delete: keeps order history intact.
  const r = await db.query('UPDATE products SET active = false, updated_at = now() WHERE id = $1', [pid])
  if (!r.rowCount) throw notFound('Product not found')
  await audit('admin.product.archive', req, { target: pid })
  res.status(204).end()
})

// ---------- messages ----------
router.get('/messages', async (req, res) => {
  const q = parse(page, req.query)
  const db = await getDb()
  const total = (await db.query<{ n: number }>('SELECT count(*) AS n FROM messages')).rows[0].n
  const rows = (await db.query(`SELECT id, name, email, phone, subject, body, read, created_at AS "createdAt" FROM messages ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [q.limit, (q.page - 1) * q.limit])).rows
  res.json({ messages: rows, total })
})
router.patch('/messages/:id', async (req, res) => {
  const mid = id(req.params.id)
  const { read } = parse(z.object({ read: z.boolean() }), req.body)
  const db = await getDb()
  const r = await db.query('UPDATE messages SET read = $2 WHERE id = $1', [mid, read])
  if (!r.rowCount) throw notFound()
  res.json({ ok: true })
})
router.delete('/messages/:id', async (req, res) => {
  const mid = id(req.params.id)
  const db = await getDb()
  await db.query('DELETE FROM messages WHERE id = $1', [mid])
  await audit('admin.message.delete', req, { target: mid })
  res.status(204).end()
})

// ---------- custom candle requests ----------
const CUSTOM_STATUSES = ['New', 'Quoted', 'Approved', 'In production', 'Completed', 'Declined'] as const
const CUSTOM_SELECT = `SELECT id, name, email, phone, vessel, size, color, scent, label, occasion, quantity, needed_by AS "neededBy", budget, notes,
  (reference_file IS NOT NULL) AS "hasReference", estimate, quoted_amount AS "quotedAmount", admin_notes AS "adminNotes", status, created_at AS "createdAt" FROM custom_requests`
router.get('/custom-requests', async (req, res) => {
  const q = parse(page.extend({ status: z.enum(CUSTOM_STATUSES).optional() }), req.query)
  const db = await getDb()
  const rows = (await db.query(`${CUSTOM_SELECT} WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q.status ?? null, q.limit, (q.page - 1) * q.limit])).rows
  res.json({ requests: rows })
})
router.patch('/custom-requests/:rid', async (req, res) => {
  const rid = parse(z.string().regex(/^CUS-[A-Z0-9]{4,8}$/), req.params.rid)
  const b = parse(z.object({
    status: z.enum(CUSTOM_STATUSES).optional(), quotedAmount: z.number().int().min(0).max(100_000_000).nullable().optional(),
    adminNotes: z.string().trim().max(3000).nullable().optional(), notifyCustomer: z.boolean().default(true),
  }), req.body)
  const db = await getDb()
  const cur = (await db.query<{ name: string; email: string; status: string; quoted_amount: number | null }>('SELECT name, email, status, quoted_amount FROM custom_requests WHERE id = $1', [rid])).rows[0]
  if (!cur) throw notFound()
  await db.query(
    `UPDATE custom_requests SET status = COALESCE($2, status), quoted_amount = CASE WHEN $3::boolean THEN $4 ELSE quoted_amount END,
       admin_notes = CASE WHEN $5::boolean THEN $6 ELSE admin_notes END, updated_at = now() WHERE id = $1`,
    [rid, b.status ?? null, b.quotedAmount !== undefined, b.quotedAmount ?? null, b.adminNotes !== undefined, b.adminNotes ?? null])
  const after = (await db.query<{ quoted_amount: number | null; admin_notes: string | null }>('SELECT quoted_amount, admin_notes FROM custom_requests WHERE id = $1', [rid])).rows[0]
  if (b.status === 'Quoted' && b.notifyCustomer && after.quoted_amount) await mail(cur.email, templates.customQuote(cur.name, rid, after.quoted_amount, after.admin_notes, money))
  await audit('admin.custom.update', req, { target: rid, meta: { status: b.status, quotedAmount: b.quotedAmount } })
  res.json({ request: (await db.query(`${CUSTOM_SELECT} WHERE id = $1`, [rid])).rows[0] })
})
router.get('/custom-requests/:rid/reference', async (req, res) => {
  const rid = parse(z.string().regex(/^CUS-[A-Z0-9]{4,8}$/), req.params.rid)
  const db = await getDb()
  const f = (await db.query<{ reference_file: string | null }>('SELECT reference_file FROM custom_requests WHERE id = $1', [rid])).rows[0]?.reference_file
  const path = f ? uploadPath(f) : null
  if (!f || !path) throw notFound()
  res.set({ 'Content-Type': mimeFor(f), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, no-store' })
  createReadStream(path).on('error', () => res.status(404).end()).pipe(res)
})

// ---------- subscribers ----------
router.get('/subscribers', async (_req, res) => {
  const db = await getDb()
  res.json({ subscribers: (await db.query('SELECT email, created_at AS "createdAt" FROM subscribers ORDER BY created_at DESC LIMIT 5000')).rows })
})
router.get('/subscribers.csv', async (req, res) => {
  const db = await getDb()
  const rows = (await db.query<{ email: string; created_at: Date }>('SELECT email, created_at FROM subscribers ORDER BY created_at DESC')).rows
  const cell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? "'" + v : v).replace(/"/g, '""')}"` // neutralise spreadsheet formula injection
  await audit('admin.subscribers.export', req)
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="subscribers.csv"' })
    .send(['email,subscribed_at', ...rows.map((r) => `${cell(r.email)},${r.created_at.toISOString()}`)].join('\n'))
})

// ---------- promo codes ----------
const promoSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/),
  type: z.enum(['percent', 'fixed']), value: z.number().int().min(1).max(1_000_000),
  minSubtotal: z.number().int().min(0).default(0), label: z.string().trim().max(100).default(''),
  active: z.boolean().default(true), expiresAt: z.iso.datetime().nullable().optional(), maxUses: z.number().int().min(1).nullable().optional(),
}).refine((p) => p.type !== 'percent' || p.value <= 100, { message: 'Percent discounts cannot exceed 100.', path: ['value'] })
const PROMO = `SELECT code, type, value, min_subtotal AS "minSubtotal", label, active, expires_at AS "expiresAt", max_uses AS "maxUses", used_count AS "usedCount" FROM promo_codes`
router.get('/promo-codes', async (_req, res) => { const db = await getDb(); res.json({ promoCodes: (await db.query(`${PROMO} ORDER BY created_at DESC`)).rows }) })
router.post('/promo-codes', async (req, res) => {
  const p = parse(promoSchema, req.body)
  const db = await getDb()
  const r = await db.query('INSERT INTO promo_codes (code,type,value,min_subtotal,label,active,expires_at,max_uses) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', [p.code, p.type, p.value, p.minSubtotal, p.label, p.active, p.expiresAt ?? null, p.maxUses ?? null])
  if (!r.rowCount) throw conflict('That code already exists.')
  await audit('admin.promo.create', req, { target: p.code })
  res.status(201).json({ ok: true })
})
router.patch('/promo-codes/:code', async (req, res) => {
  const code = parse(z.string().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/), req.params.code)
  const b = parse(z.object({ active: z.boolean() }), req.body)
  const db = await getDb()
  const r = await db.query('UPDATE promo_codes SET active = $2 WHERE code = $1', [code, b.active])
  if (!r.rowCount) throw notFound()
  await audit('admin.promo.update', req, { target: code, meta: b })
  res.json({ ok: true })
})
router.delete('/promo-codes/:code', async (req, res) => {
  const code = parse(z.string().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/), req.params.code)
  const db = await getDb()
  await db.query('DELETE FROM promo_codes WHERE code = $1', [code])
  await audit('admin.promo.delete', req, { target: code })
  res.status(204).end()
})

// ---------- reviews moderation ----------
router.get('/reviews', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['pending', 'published', 'rejected']).default('pending') }), req.query)
  const db = await getDb()
  res.json({ reviews: (await db.query(`SELECT r.id, r.name, r.rating, r.title, r.body, r.status, r.created_at AS "createdAt", p.name AS product FROM reviews r JOIN products p ON p.id = r.product_id WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 200`, [status])).rows })
})
router.patch('/reviews/:id', async (req, res) => {
  const rid = id(req.params.id)
  const { status } = parse(z.object({ status: z.enum(['published', 'rejected']) }), req.body)
  const db = await getDb()
  const r = await db.query('UPDATE reviews SET status = $2 WHERE id = $1', [rid, status])
  if (!r.rowCount) throw notFound()
  await audit('admin.review.moderate', req, { target: rid, meta: { status } })
  res.json({ ok: true })
})

// ---------- customers ----------
router.get('/users', async (req, res) => {
  const q = parse(page.extend({ q: z.string().trim().max(100).optional() }), req.query)
  const db = await getDb()
  const rows = (await db.query(
    `SELECT id, email, name, phone, role, email_verified_at IS NOT NULL AS "emailVerified", mfa_enabled AS "mfaEnabled", disabled, created_at AS "createdAt", last_login_at AS "lastLoginAt"
     FROM users WHERE deleted_at IS NULL AND ($1::text IS NULL OR email ILIKE $1 ESCAPE '\\' OR name ILIKE $1 ESCAPE '\\') ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [q.q ? like(q.q) : null, q.limit, (q.page - 1) * q.limit])).rows
  res.json({ users: rows })
})
router.patch('/users/:id', async (req, res) => {
  const uid = id(req.params.id)
  const { disabled } = parse(z.object({ disabled: z.boolean() }), req.body)
  if (uid === req.user!.id) throw forbidden('You cannot disable your own account.')
  const db = await getDb()
  const r = await db.query('UPDATE users SET disabled = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL', [uid, disabled])
  if (!r.rowCount) throw notFound()
  if (disabled) await revokeAllSessions(uid)
  await audit(disabled ? 'admin.user.disable' : 'admin.user.enable', req, { target: uid })
  res.json({ ok: true })
})

// ---------- audit trail ----------
router.get('/audit', async (req, res) => {
  const q = parse(page.extend({ action: z.string().trim().max(60).optional() }), req.query)
  const db = await getDb()
  const rows = (await db.query(
    `SELECT id, at, actor_email AS "actorEmail", action, target, ip, meta FROM audit_log WHERE ($1::text IS NULL OR action LIKE $1) ORDER BY id DESC LIMIT $2 OFFSET $3`,
    [q.action ? q.action.replace(/[%_]/g, '') + '%' : null, q.limit, (q.page - 1) * q.limit])).rows
  res.json({ entries: rows })
})

import { Router } from 'express'
import { z } from 'zod'
import { PRIVACY_VERSION, TERMS_VERSION } from '../config.ts'
import { getDb } from '../db/index.ts'
import { audit } from '../lib/audit.ts'
import { badRequest, conflict, notFound } from '../lib/errors.ts'
import { authorizeOrder, cancelOrder, loadOrder, sendConfirmation, serializeOrder } from '../lib/orders.ts'
import { priceCart, shippingFor } from '../lib/pricing.ts'
import { signOrderToken } from '../lib/tokens.ts'
import { limits, optionalAuth, parse } from '../middleware/index.ts'
import { emailSchema } from './auth.ts'

export const router = Router()
router.use(optionalAuth)

const cartSchema = z.object({
  items: z.array(z.object({ productId: z.uuid(), sizeCode: z.string().min(1).max(10), qty: z.number().int().min(1).max(20) })).min(1).max(50),
  promo: z.string().trim().max(40).optional().nullable(),
})

router.post('/quote', limits.global, async (req, res) => {
  const body = parse(cartSchema, req.body)
  const db = await getDb()
  const q = await priceCart(db, body.items, body.promo || null)
  res.json({ ...q, lines: q.lines.map(({ stock: _s, ...l }) => l) })
})

const phone = z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number.')
const orderSchema = cartSchema.extend({
  contact: z.object({ email: emailSchema, name: z.string().trim().min(2).max(100), phone }),
  address: z.object({
    line1: z.string().trim().min(3).max(200), line2: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
    city: z.string().trim().min(2).max(100), region: z.string().trim().min(2).max(100),
    postcode: z.string().trim().min(2).max(20), country: z.string().trim().min(2).max(60),
  }),
  delivery: z.enum(['standard', 'express']),
  paymentMethod: z.enum(['mpesa', 'cod']),
  giftNote: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  acceptTerms: z.literal(true, { error: 'You must accept the Terms of Service and Privacy Policy.' }),
})

router.post('/', limits.write, async (req, res) => {
  const b = parse(orderSchema, req.body)
  const db = await getDb()
  const created = await db.tx(async (q) => {
    const quote = await priceCart(q, b.items, b.promo || null, { lock: true })
    const after = quote.subtotal - quote.discount
    const shipping = shippingFor(b.delivery, after)
    const total = after + shipping
    for (const l of quote.lines) {
      const upd = await q.query('UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1 AND stock >= $2', [l.productId, l.qty])
      if (upd.rowCount === 0) throw conflict(`${l.name} just sold out. Please update your bag.`)
    }
    if (quote.promo) {
      const p = await q.query('UPDATE promo_codes SET used_count = used_count + 1 WHERE code = $1 AND (max_uses IS NULL OR used_count < max_uses)', [quote.promo])
      if (p.rowCount === 0) throw badRequest('That promo code has just been used up.')
    }
    const status = b.paymentMethod === 'cod' ? 'Processing' : 'Pending payment'
    const o = await q.query<{ id: string }>(
      `INSERT INTO orders (id, user_id, email, name, phone, address, delivery, payment_method, status, subtotal, discount, shipping, total, promo_code, gift_note)
       VALUES ('TAWA-' || nextval('order_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [req.user?.id ?? null, b.contact.email, b.contact.name, b.contact.phone, JSON.stringify(b.address), b.delivery, b.paymentMethod, status,
        quote.subtotal, quote.discount, shipping, total, quote.promo, b.giftNote ?? null])
    const id = o.rows[0].id
    for (const l of quote.lines) {
      await q.query('INSERT INTO order_items (order_id, product_id, name, size_code, size_label, price, qty) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, l.productId, l.name, l.sizeCode, l.sizeLabel, l.price, l.qty])
    }
    return id
  })
  await audit('order.created', req, { target: created, meta: { terms: TERMS_VERSION, privacy: PRIVACY_VERSION, method: b.paymentMethod } })
  if (b.paymentMethod === 'cod') void sendConfirmation(created)
  const l = (await loadOrder(created))!
  res.status(201).json({ order: serializeOrder(l.row, l.items), orderToken: await signOrderToken(created) })
})

/** Guest tracking: order number + email. Same 404 for a wrong id and a wrong email. */
router.get('/track', limits.lookup, async (req, res) => {
  const { id, email } = parse(z.object({ id: z.string().trim().min(3).max(30), email: emailSchema }), req.query)
  const l = await loadOrder(id.toUpperCase())
  if (!l || l.row.email.toLowerCase() !== email) throw notFound('We couldn’t find an order matching those details.')
  res.json({ order: serializeOrder(l.row, l.items), orderToken: await signOrderToken(l.row.id) })
})

router.get('/:id', async (req, res) => {
  const l = await authorizeOrder(req, String(req.params.id).toUpperCase())
  res.json({ order: serializeOrder(l.row, l.items) })
})

router.post('/:id/cancel', limits.write, async (req, res) => {
  const l = await authorizeOrder(req, String(req.params.id).toUpperCase())
  const o = l.row
  const cancellable = o.status === 'Pending payment' || (o.payment_method === 'cod' && o.status === 'Processing')
  if (!cancellable) throw conflict('This order can no longer be cancelled online. Please contact us.')
  if (!(await cancelOrder(o.id, req, 'customer_request'))) throw conflict('This order can no longer be cancelled.')
  const fresh = (await loadOrder(o.id))!
  res.json({ order: serializeOrder(fresh.row, fresh.items) })
})

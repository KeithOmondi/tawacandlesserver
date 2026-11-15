import { Router } from 'express'
import { z } from 'zod'
import { getDb } from '../db/index.ts'
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts'
import { limits, parse, requireAuth, requireVerified } from '../middleware/index.ts'

export const router = Router()

export const PRODUCT_SELECT = `
  SELECT p.id, p.slug, p.name, p.tagline, p.category, p.vessel, p.wax, p.accent, p.scent_family AS "scentFamily", p.notes,
         p.description, p.image, p.badge, p.compare_at AS "compareAt", p.stock, p.featured, p.active, p.sort,
         COALESCE((SELECT json_agg(json_build_object('id', s.code, 'label', s.label, 'weight', s.weight, 'burn', s.burn, 'price', s.price) ORDER BY s.price)
                   FROM product_sizes s WHERE s.product_id = p.id), '[]'::json) AS sizes,
         COALESCE((SELECT round(avg(r.rating)::numeric, 1)::float8 FROM reviews r WHERE r.product_id = p.id AND r.status = 'published'), 0) AS rating,
         (SELECT count(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published') AS "reviewCount"
  FROM products p`

router.get('/products', async (_req, res) => {
  const db = await getDb()
  const r = await db.query(`${PRODUCT_SELECT} WHERE p.active ORDER BY p.sort, p.name`)
  res.set('Cache-Control', 'public, max-age=30')
  res.json({ products: r.rows.map(({ active: _a, sort: _s, ...p }) => p) })
})

router.get('/products/:slug', async (req, res) => {
  const slug = parse(z.string().regex(/^[a-z0-9-]{1,100}$/), req.params.slug)
  const db = await getDb()
  const p = (await db.query(`${PRODUCT_SELECT} WHERE p.slug = $1 AND p.active`, [slug])).rows[0]
  if (!p) throw notFound('Product not found')
  const reviews = (await db.query(
    `SELECT id, name, rating, title, body, created_at AS date FROM reviews WHERE product_id = $1 AND status = 'published' ORDER BY created_at DESC LIMIT 100`, [p.id])).rows
  const { active: _a, sort: _s, ...rest } = p
  res.json({ product: rest, reviews })
})

router.post('/products/:id/reviews', requireAuth, requireVerified, limits.write, async (req, res) => {
  const id = parse(z.uuid(), req.params.id)
  const body = parse(z.object({
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(120).default(''),
    body: z.string().trim().min(5, 'Please write a few words.').max(2000),
  }), req.body)
  const db = await getDb()
  const p = (await db.query('SELECT id FROM products WHERE id = $1 AND active', [id])).rows[0]
  if (!p) throw notFound('Product not found')
  const dup = await db.query('SELECT 1 FROM reviews WHERE product_id = $1 AND user_id = $2', [id, req.user!.id])
  if (dup.rowCount) throw conflict('You have already reviewed this product.')
  // Verified purchasers (delivered order) publish immediately; everyone else is moderated.
  const bought = await db.query(
    `SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id
     WHERE i.product_id = $1 AND o.status = 'Delivered' AND (o.user_id = $2 OR lower(o.email) = lower($3)) LIMIT 1`, [id, req.user!.id, req.user!.email])
  const status = bought.rowCount ? 'published' : 'pending'
  await db.query('INSERT INTO reviews (product_id, user_id, name, rating, title, body, status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, req.user!.id, req.user!.name.split(' ')[0] + (req.user!.name.split(' ')[1] ? ' ' + req.user!.name.split(' ')[1][0] + '.' : ''), body.rating, body.title, body.body, status])
  res.status(201).json({ status, message: status === 'published' ? 'Thanks for your review!' : 'Thanks! Your review will appear once it has been approved.' })
})

// ---------- wishlist (signed-in customers) ----------
router.get('/wishlist', requireAuth, async (req, res) => {
  const db = await getDb()
  const r = await db.query<{ product_id: string }>('SELECT product_id FROM wishlist WHERE user_id = $1', [req.user!.id])
  res.json({ productIds: r.rows.map((x) => x.product_id) })
})
router.put('/wishlist/:productId', requireAuth, async (req, res) => {
  const id = parse(z.uuid(), req.params.productId)
  const db = await getDb()
  const count = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wishlist WHERE user_id = $1', [req.user!.id])).rows[0].n
  if (count >= 200) throw forbidden('Wishlist is full.')
  const exists = await db.query('SELECT 1 FROM products WHERE id = $1', [id])
  if (!exists.rowCount) throw badRequest('Unknown product.')
  await db.query('INSERT INTO wishlist (user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user!.id, id])
  res.status(204).end()
})
router.delete('/wishlist/:productId', requireAuth, async (req, res) => {
  const id = parse(z.uuid(), req.params.productId)
  const db = await getDb()
  await db.query('DELETE FROM wishlist WHERE user_id = $1 AND product_id = $2', [req.user!.id, id])
  res.status(204).end()
})

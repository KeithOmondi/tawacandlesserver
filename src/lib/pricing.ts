import type { Queryable } from '../db/index.ts'
import { badRequest } from './errors.ts'

export const FREE_SHIPPING_OVER = 8000
export const STANDARD_SHIPPING = 400
export const EXPRESS_SHIPPING = 900
export const MAX_QTY_PER_LINE = 20

export interface CartInput { productId: string; sizeCode: string; qty: number }
export interface PricedLine {
  productId: string; name: string; sizeCode: string; sizeLabel: string; price: number; qty: number; stock: number
}
export interface Quote {
  lines: PricedLine[]; subtotal: number; discount: number; promo: string | null; promoLabel: string | null
  shipping: { standard: number; express: number }
}

export const shippingFor = (method: 'standard' | 'express', subtotalAfterDiscount: number) =>
  method === 'express' ? EXPRESS_SHIPPING : subtotalAfterDiscount >= FREE_SHIPPING_OVER ? 0 : STANDARD_SHIPPING

/**
 * Prices a cart entirely from the database. Client-supplied prices are never accepted.
 * Throws a 400 for unknown/inactive items, insufficient stock or invalid promo codes.
 */
export async function priceCart(q: Queryable, items: CartInput[], promoCode?: string | null, opts: { lock?: boolean } = {}): Promise<Quote> {
  if (items.length === 0) throw badRequest('Your bag is empty.')
  // Merge duplicate lines.
  const merged = new Map<string, CartInput>()
  for (const i of items) {
    const k = `${i.productId}:${i.sizeCode}`
    const prev = merged.get(k)
    merged.set(k, { ...i, qty: (prev?.qty ?? 0) + i.qty })
  }
  const lines: PricedLine[] = []
  const stockUse = new Map<string, number>()
  for (const i of merged.values()) {
    if (i.qty < 1 || i.qty > MAX_QTY_PER_LINE) throw badRequest(`Quantity must be between 1 and ${MAX_QTY_PER_LINE}.`)
    const r = await q.query<{ id: string; name: string; stock: number; label: string; price: number }>(
      `SELECT p.id, p.name, p.stock, s.label, s.price FROM products p JOIN product_sizes s ON s.product_id = p.id
       WHERE p.id = $1 AND s.code = $2 AND p.active ${opts.lock ? 'FOR UPDATE OF p' : ''}`,
      [i.productId, i.sizeCode],
    )
    const row = r.rows[0]
    if (!row) throw badRequest('One of the items in your bag is no longer available.')
    stockUse.set(row.id, (stockUse.get(row.id) ?? 0) + i.qty)
    if (stockUse.get(row.id)! > row.stock) throw badRequest(row.stock === 0 ? `${row.name} is sold out.` : `Only ${row.stock} of ${row.name} left in stock.`)
    lines.push({ productId: row.id, name: row.name, sizeCode: i.sizeCode, sizeLabel: row.label, price: row.price, qty: i.qty, stock: row.stock })
  }
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0)

  let discount = 0, promo: string | null = null, promoLabel: string | null = null
  if (promoCode) {
    const code = promoCode.trim().toUpperCase()
    const r = await q.query<{ type: string; value: number; min_subtotal: number; label: string; active: boolean; expires_at: Date | null; max_uses: number | null; used_count: number }>(
      'SELECT * FROM promo_codes WHERE code = $1', [code])
    const p = r.rows[0]
    if (!p || !p.active || (p.expires_at && p.expires_at < new Date()) || (p.max_uses !== null && p.used_count >= p.max_uses)) throw badRequest('That promo code is not valid.')
    if (subtotal < p.min_subtotal) throw badRequest(`This code needs a minimum order of KSh ${p.min_subtotal.toLocaleString('en-KE')}.`)
    discount = Math.min(subtotal, p.type === 'percent' ? Math.round((subtotal * p.value) / 100) : p.value)
    promo = code
    promoLabel = p.label
  }
  const after = subtotal - discount
  return { lines, subtotal, discount, promo, promoLabel, shipping: { standard: shippingFor('standard', after), express: shippingFor('express', after) } }
}

export const money = (n: number) => 'KSh ' + new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 }).format(n)

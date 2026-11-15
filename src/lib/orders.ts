import type { Request } from 'express'
import { getDb, type Queryable } from '../db/index.ts'
import { audit } from './audit.ts'
import { forbidden, notFound } from './errors.ts'
import { link, mail, templates } from './mailer.ts'
import { money } from './pricing.ts'
import { verifyOrderToken } from './tokens.ts'
import { logger } from '../logger.ts'
import { config } from '../config.ts'

export const ORDER_STATUSES = ['Pending payment', 'Processing', 'Packed', 'Shipped', 'Delivered', 'Cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

interface OrderRow {
  id: string; user_id: string | null; email: string; name: string; phone: string; address: any; delivery: string
  payment_method: string; payment_status: string; status: OrderStatus; subtotal: number; discount: number; shipping: number
  total: number; promo_code: string | null; gift_note: string | null; tracking_ref: string | null; stock_released: boolean; created_at: Date
}

export async function loadOrder(id: string, q?: Queryable) {
  const db = q ?? (await getDb())
  const o = (await db.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id])).rows[0]
  if (!o) return null
  const items = (await db.query<{ product_id: string | null; name: string; size_code: string; size_label: string; price: number; qty: number }>(
    'SELECT product_id, name, size_code, size_label, price, qty FROM order_items WHERE order_id = $1 ORDER BY name', [id])).rows
  return { row: o, items }
}

export function serializeOrder(o: OrderRow, items: { product_id: string | null; name: string; size_code: string; size_label: string; price: number; qty: number }[]) {
  return {
    id: o.id, createdAt: o.created_at, status: o.status, paymentStatus: o.payment_status, paymentMethod: o.payment_method,
    email: o.email, name: o.name, phone: o.phone, address: o.address, delivery: o.delivery, giftNote: o.gift_note,
    trackingRef: o.tracking_ref,
    items: items.map((i) => ({ productId: i.product_id, name: i.name, sizeId: i.size_code, sizeLabel: i.size_label, price: i.price, qty: i.qty })),
    subtotal: o.subtotal, discount: o.discount, shipping: o.shipping, total: o.total, promo: o.promo_code,
  }
}

/**
 * Who may see/act on an order? Its owner, an admin, or the holder of the order token
 * issued at checkout. Everyone else gets a 404 (never confirm an order id exists).
 */
export async function authorizeOrder(req: Request, orderId: string) {
  const loaded = await loadOrder(orderId)
  if (!loaded) throw notFound('Order not found')
  const u = req.user
  if (u && (u.role === 'admin' || loaded.row.user_id === u.id)) return loaded
  const token = req.get('x-order-token')
  if (token) {
    try { if ((await verifyOrderToken(token)) === orderId) return loaded } catch { /* fall through */ }
  }
  throw notFound('Order not found')
}

export async function restock(q: Queryable, orderId: string) {
  const claimed = await q.query('UPDATE orders SET stock_released = true WHERE id = $1 AND stock_released = false RETURNING id', [orderId])
  if (claimed.rowCount === 0) return
  const items = await q.query<{ product_id: string | null; qty: number }>('SELECT product_id, qty FROM order_items WHERE order_id = $1', [orderId])
  for (const i of items.rows) if (i.product_id) await q.query('UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1', [i.product_id, i.qty])
  const promo = (await q.query<{ promo_code: string | null }>('SELECT promo_code FROM orders WHERE id = $1', [orderId])).rows[0]?.promo_code
  if (promo) await q.query('UPDATE promo_codes SET used_count = GREATEST(used_count - 1, 0) WHERE code = $1', [promo])
}

export async function cancelOrder(orderId: string, req: Request | null, reason: string) {
  const db = await getDb()
  const changed = await db.tx(async (q) => {
    const r = await q.query(
      `UPDATE orders SET status = 'Cancelled', updated_at = now() WHERE id = $1 AND status NOT IN ('Cancelled','Delivered','Shipped') RETURNING id`, [orderId])
    if (r.rowCount === 0) return false
    await restock(q, orderId)
    return true
  })
  if (changed) await audit('order.cancelled', req, { target: orderId, meta: { reason } })
  return changed
}

export async function sendConfirmation(orderId: string) {
  const l = await loadOrder(orderId)
  if (!l) return
  const o = l.row
  await mail(o.email, templates.orderConfirmation(
    { id: o.id, name: o.name, total: o.total, method: o.payment_method, items: l.items.map((i) => ({ name: i.name, size_label: i.size_label, qty: i.qty, price: i.price })) },
    link(`/account?order=${o.id}`), money))
  await mail(config.STORE_NOTIFY_EMAIL, templates.adminNotice(`New order ${o.id}`, [
    `${o.name} (${o.email}, ${o.phone})`, `Total ${money(o.total)} · ${o.payment_method.toUpperCase()} · ${o.payment_status}`,
    ...l.items.map((i) => `${i.qty} × ${i.name} (${i.size_label})`),
  ]))
}

/** Idempotently marks an order paid. Returns true only the first time. */
export async function markPaid(orderId: string, paymentId: string, receipt: string | null, resultDesc = 'Success') {
  const db = await getDb()
  const first = await db.tx(async (q) => {
    const p = await q.query(`UPDATE payments SET status = 'paid', receipt = COALESCE($2, receipt), result_code = 0, result_desc = $3, updated_at = now() WHERE id = $1 AND status <> 'paid' RETURNING id`, [paymentId, receipt, resultDesc])
    if (p.rowCount === 0) return false
    // A paid order that was cancelled/expired in the meantime still has its money; reopen it if stock allows, else flag for refund.
    await q.query(`UPDATE orders SET payment_status = 'paid', status = CASE WHEN status = 'Pending payment' THEN 'Processing' ELSE status END, updated_at = now() WHERE id = $1`, [orderId])
    return true
  })
  if (first) {
    await audit('payment.paid', null, { target: orderId, meta: { receipt } })
    const st = (await db.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0]?.status
    if (st === 'Cancelled') {
      // Money arrived after the order was auto-cancelled: tell the owner so they can reinstate or refund it.
      await audit('payment.paid_after_cancel', null, { target: orderId, meta: { receipt } })
      await mail(config.STORE_NOTIFY_EMAIL, templates.adminNotice(`ACTION NEEDED: paid cancelled order ${orderId}`, [`M-Pesa receipt ${receipt ?? 'n/a'} was received for cancelled order ${orderId}. Refund the customer or contact them to reinstate the order.`]))
    } else void sendConfirmation(orderId)
  }
  return first
}

/** Cancels unpaid M-Pesa orders after 30 minutes and returns their stock. */
export async function expirePendingOrders(): Promise<number> {
  const db = await getDb()
  const stale = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE status = 'Pending payment' AND payment_status = 'pending' AND created_at < now() - interval '30 minutes'`)
  let n = 0
  for (const o of stale.rows) {
    try { if (await cancelOrder(o.id, null, 'payment_timeout')) n++ } catch (err) { logger.error({ err, order: o.id }, 'expire order failed') }
  }
  return n
}

export const assertAdminOrOwner = (req: Request, ownerId: string | null) => {
  if (!req.user || (req.user.role !== 'admin' && req.user.id !== ownerId)) throw forbidden()
}

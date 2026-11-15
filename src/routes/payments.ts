import { Router } from 'express'
import { z } from 'zod'
import { config } from '../config.ts'
import { getDb } from '../db/index.ts'
import { audit } from '../lib/audit.ts'
import { safeEqual } from '../lib/crypto.ts'
import { badRequest, conflict, notFound } from '../lib/errors.ts'
import { normalizeKenyanPhone, parseCallback, stkPush, stkQuery } from '../lib/mpesa.ts'
import { authorizeOrder, markPaid } from '../lib/orders.ts'
import { limits, optionalAuth, parse } from '../middleware/index.ts'
import { logger } from '../logger.ts'

export const router = Router()

interface PaymentRow { id: string; order_id: string; amount: number; checkout_request_id: string | null; status: string; created_at: Date }

/** Start (or re-send) an M-Pesa STK push for an order the caller owns. */
router.post('/mpesa/stk', optionalAuth, limits.write, async (req, res) => {
  const { orderId, phone } = parse(z.object({ orderId: z.string().trim().min(3).max(30), phone: z.string().trim().min(9).max(20) }), req.body)
  const l = await authorizeOrder(req, orderId.toUpperCase())
  const o = l.row
  if (o.payment_method !== 'mpesa') throw badRequest('This order is not an M-Pesa order.')
  if (o.status !== 'Pending payment' || o.payment_status === 'paid') throw conflict('This order is not awaiting payment.')
  const msisdn = normalizeKenyanPhone(phone)
  if (!msisdn) throw badRequest('Enter a valid Safaricom number, e.g. 0712 345 678.', { phone: 'Enter a valid Safaricom number, e.g. 0712 345 678.' })

  const db = await getDb()
  const recent = (await db.query<PaymentRow>(
    `SELECT * FROM payments WHERE order_id = $1 AND status = 'pending' AND created_at > now() - interval '60 seconds' ORDER BY created_at DESC LIMIT 1`, [o.id])).rows[0]
  if (recent) return void res.status(202).json({ paymentId: recent.id, status: 'pending', message: 'A payment prompt was just sent. Please check your phone.' })

  const stk = await stkPush({ phone: msisdn, amount: o.total, orderId: o.id })
  const p = await db.query<{ id: string }>(
    'INSERT INTO payments (order_id, phone, amount, checkout_request_id, merchant_request_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [o.id, msisdn, o.total, stk.checkoutRequestId, stk.merchantRequestId])
  await audit('payment.stk_sent', req, { target: o.id, meta: { phone: msisdn.slice(0, 6) + '****' + msisdn.slice(-2) } })
  res.status(202).json({ paymentId: p.rows[0].id, status: 'pending', message: 'Check your phone and enter your M-Pesa PIN to complete payment.' })
})

/** Polled by the storefront. Falls back to asking Safaricom directly if the callback has not arrived. */
router.get('/status/:orderId', optionalAuth, limits.global, async (req, res) => {
  const l = await authorizeOrder(req, String(req.params.orderId).toUpperCase())
  const db = await getDb()
  const p = (await db.query<PaymentRow>(`SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [l.row.id])).rows[0]
  if (p && p.status === 'pending' && p.checkout_request_id && Date.now() - p.created_at.getTime() > 4000) {
    try {
      const r = await stkQuery(p.checkout_request_id, Date.now() - p.created_at.getTime())
      if (r.state === 'paid') await markPaid(l.row.id, p.id, r.receipt)
      else if (r.state === 'failed') await db.query(`UPDATE payments SET status = 'failed', result_code = $2, result_desc = $3, updated_at = now() WHERE id = $1 AND status = 'pending'`, [p.id, r.code, r.desc])
    } catch (err) { logger.warn({ err }, 'stk status query failed') }
  }
  const o = (await db.query<{ status: string; payment_status: string }>('SELECT status, payment_status FROM orders WHERE id = $1', [l.row.id])).rows[0]
  const pay = (await db.query<{ status: string; result_desc: string | null }>(`SELECT status, result_desc FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, [l.row.id])).rows[0]
  res.json({ orderStatus: o.status, paymentStatus: o.payment_status, attempt: pay ? { status: pay.status, message: pay.status === 'failed' ? pay.result_desc : null } : null })
})

/**
 * Safaricom callback. The URL contains a secret path segment; every success is additionally
 * re-verified with Safaricom's STK query API and the amount is checked against our own record,
 * so a forged callback cannot mark an order paid.
 */
router.post('/mpesa/callback/:secret', async (req, res) => {
  const ack = () => res.json({ ResultCode: 0, ResultDesc: 'Accepted' })
  if (!config.MPESA_CALLBACK_SECRET || !safeEqual(req.params.secret, config.MPESA_CALLBACK_SECRET)) throw notFound()
  const cb = parseCallback(req.body)
  if (!cb) return void ack()
  const db = await getDb()
  const p = (await db.query<PaymentRow>('SELECT * FROM payments WHERE checkout_request_id = $1', [cb.checkoutRequestId])).rows[0]
  if (!p || p.status !== 'pending') return void ack()

  if (cb.code === 0) {
    if (cb.amount !== undefined && cb.amount !== p.amount) {
      logger.error({ order: p.order_id, expected: p.amount, got: cb.amount }, 'mpesa callback amount mismatch')
      await audit('payment.amount_mismatch', req, { target: p.order_id, meta: { expected: p.amount, got: cb.amount } })
      return void ack()
    }
    const verified = await stkQuery(cb.checkoutRequestId, 1e9).catch(() => ({ state: 'pending' as const }))
    if (verified.state !== 'paid') {
      logger.warn({ order: p.order_id }, 'mpesa callback claimed success but verification did not confirm; leaving pending')
      return void ack()
    }
    await markPaid(p.order_id, p.id, cb.receipt ?? null, cb.desc)
  } else {
    await db.query(`UPDATE payments SET status = 'failed', result_code = $2, result_desc = $3, updated_at = now() WHERE id = $1 AND status = 'pending'`, [p.id, cb.code, cb.desc.slice(0, 200)])
    await audit('payment.failed', req, { target: p.order_id, meta: { code: cb.code } })
  }
  ack()
})

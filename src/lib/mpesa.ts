import { randomUUID } from 'node:crypto'
import { config } from '../config.ts'
import { logger } from '../logger.ts'
import { HttpError } from './errors.ts'

const BASE = config.MPESA_MODE === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke'

/** Normalises Kenyan numbers (0712…, +254712…, 254712…, 0112…) to 2547XXXXXXXX / 2541XXXXXXXX. */
export function normalizeKenyanPhone(input: string): string | null {
  const d = input.replace(/[\s\-()]/g, '').replace(/^\+/, '')
  let n: string
  if (/^0[17]\d{8}$/.test(d)) n = '254' + d.slice(1)
  else if (/^254[17]\d{8}$/.test(d)) n = d
  else if (/^[17]\d{8}$/.test(d)) n = '254' + d
  else return null
  return n
}

let tokenCache: { token: string; exp: number } | null = null
async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 10_000) return tokenCache.token
  const auth = Buffer.from(`${config.MPESA_CONSUMER_KEY}:${config.MPESA_CONSUMER_SECRET}`).toString('base64')
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) { logger.error({ status: r.status }, 'mpesa auth failed'); throw new HttpError(502, 'payment_unavailable', 'Payment provider is unavailable. Please try again.') }
  const j = (await r.json()) as { access_token: string; expires_in: string }
  tokenCache = { token: j.access_token, exp: Date.now() + Number(j.expires_in) * 1000 }
  return j.access_token
}

const timestamp = () => new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
const password = (ts: string) => Buffer.from(`${config.MPESA_SHORTCODE}${config.MPESA_PASSKEY}${ts}`).toString('base64')

export interface StkInit { checkoutRequestId: string; merchantRequestId: string }

export async function stkPush(opts: { phone: string; amount: number; orderId: string }): Promise<StkInit> {
  if (config.MPESA_MODE === 'mock') return { checkoutRequestId: `mock-${randomUUID()}`, merchantRequestId: `mock-m-${randomUUID()}` }
  const ts = timestamp()
  const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      BusinessShortCode: config.MPESA_SHORTCODE, Password: password(ts), Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline', Amount: opts.amount, PartyA: opts.phone, PartyB: config.MPESA_SHORTCODE,
      PhoneNumber: opts.phone,
      CallBackURL: `${config.MPESA_CALLBACK_BASE.replace(/\/$/, '')}/api/payments/mpesa/callback/${config.MPESA_CALLBACK_SECRET}`,
      AccountReference: opts.orderId, TransactionDesc: `TAWA ${opts.orderId}`,
    }),
  })
  const j = (await r.json().catch(() => ({}))) as { ResponseCode?: string; CheckoutRequestID?: string; MerchantRequestID?: string; errorMessage?: string; ResponseDescription?: string }
  if (!r.ok || j.ResponseCode !== '0' || !j.CheckoutRequestID) {
    logger.error({ status: r.status, body: j }, 'mpesa stk push failed')
    throw new HttpError(502, 'payment_failed', 'We could not start the M-Pesa prompt. Check the phone number and try again.')
  }
  return { checkoutRequestId: j.CheckoutRequestID, merchantRequestId: j.MerchantRequestID ?? '' }
}

export type StkResult = { state: 'pending' } | { state: 'paid'; receipt: string | null; amount: number | null } | { state: 'failed'; code: number; desc: string }

/** Asks Safaricom for the authoritative status of an STK push (used to verify callbacks and to reconcile). */
export async function stkQuery(checkoutRequestId: string, ageMs: number): Promise<StkResult> {
  if (config.MPESA_MODE === 'mock') {
    if (ageMs < 2500) return { state: 'pending' }
    return { state: 'paid', receipt: `MOCK${checkoutRequestId.slice(-8).toUpperCase()}`, amount: null }
  }
  const ts = timestamp()
  const r = await fetch(`${BASE}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ BusinessShortCode: config.MPESA_SHORTCODE, Password: password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId }),
  })
  const j = (await r.json().catch(() => ({}))) as { ResultCode?: string | number; ResultDesc?: string; errorCode?: string }
  // Daraja answers with an error while the prompt is still being processed.
  if (!r.ok || j.ResultCode === undefined) return { state: 'pending' }
  const code = Number(j.ResultCode)
  if (code === 0) return { state: 'paid', receipt: null, amount: null }
  return { state: 'failed', code, desc: j.ResultDesc ?? 'Payment failed' }
}

export interface Callback {
  merchantRequestId: string; checkoutRequestId: string; code: number; desc: string
  amount?: number; receipt?: string; phone?: string
}
export function parseCallback(body: any): Callback | null {
  const cb = body?.Body?.stkCallback
  if (!cb || typeof cb.CheckoutRequestID !== 'string') return null
  const items: { Name: string; Value?: string | number }[] = cb.CallbackMetadata?.Item ?? []
  const get = (n: string) => items.find((i) => i.Name === n)?.Value
  return {
    merchantRequestId: String(cb.MerchantRequestID ?? ''), checkoutRequestId: cb.CheckoutRequestID,
    code: Number(cb.ResultCode), desc: String(cb.ResultDesc ?? ''),
    amount: get('Amount') !== undefined ? Number(get('Amount')) : undefined,
    receipt: get('MpesaReceiptNumber') !== undefined ? String(get('MpesaReceiptNumber')) : undefined,
    phone: get('PhoneNumber') !== undefined ? String(get('PhoneNumber')) : undefined,
  }
}

import { config, isProd } from '../config.ts'
import { logger } from '../logger.ts'

export interface Mail { to: string; subject: string; html: string; text: string }

/** Without BREVO_API_KEY + SENDER_EMAIL (dev/test) mails are captured here and logged instead of sent. */
export const outbox: Mail[] = []

const BREVO = 'https://api.brevo.com/v3'
const enabled = !!config.BREVO_API_KEY && !!config.SENDER_EMAIL

/** Throws if Brevo rejects the API key. Returns false when email is not configured. */
export async function verifyMailTransport(): Promise<boolean> {
  if (!enabled) return false
  const r = await fetch(`${BREVO}/account`, { headers: { 'api-key': config.BREVO_API_KEY, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Brevo rejected the API key (HTTP ${r.status})`)
  return true
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export async function sendMail(mail: Mail): Promise<void> {
  try {
    if (!enabled) {
      outbox.push(mail)
      if (outbox.length > 200) outbox.shift()
      if (!isProd) logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, '[mail:dev] not sent (Brevo not configured)')
      return
    }
    const r = await fetch(`${BREVO}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': config.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sender: { name: config.SENDER_NAME, email: config.SENDER_EMAIL }, to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html, textContent: mail.text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!r.ok) throw new Error(`Brevo HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  } catch (err) {
    // Email failure must never break the request that triggered it.
    logger.error({ err, to: mail.to, subject: mail.subject }, 'failed to send email')
  }
}

const wrap = (title: string, body: string) => `<!doctype html><html><body style="margin:0;background:#f7eee3;font-family:Georgia,serif;color:#3b2a20">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffaf3;border:1px solid #e0cfb9">
<tr><td style="padding:28px 32px;text-align:center;border-bottom:1px solid #e0cfb9"><div style="font-size:30px;letter-spacing:6px">TAWA</div><div style="font-size:10px;letter-spacing:4px">CANDLES</div></td></tr>
<tr><td style="padding:32px;font-size:16px;line-height:1.6"><h1 style="font-weight:500;font-size:26px;margin:0 0 16px">${esc(title)}</h1>${body}</td></tr>
<tr><td style="padding:20px 32px;font-size:12px;color:#7a6657;text-align:center;border-top:1px solid #e0cfb9">TAWA Candles · Art in every scent<br>You received this because of activity on your account or an order.</td></tr>
</table></td></tr></table></body></html>`

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#3b2a20;color:#f7eee3;padding:14px 28px;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;letter-spacing:2px;text-transform:uppercase">${esc(label)}</a></p>
<p style="font-size:13px;color:#7a6657">If the button doesn’t work, copy this link:<br>${esc(href)}</p>`

export const link = (path: string) => new URL(path, config.APP_URL).toString()

export const templates = {
  verify: (name: string, url: string): Mail => ({
    to: '', subject: 'Verify your TAWA account',
    html: wrap('Welcome to TAWA', `<p>Hi ${esc(name)}, please confirm your email address to finish setting up your account.</p>${button(url, 'Verify email')}<p style="font-size:13px">This link expires in 24 hours. If you didn’t create an account, you can ignore this email.</p>`),
    text: `Hi ${name}, verify your email: ${url}\nThis link expires in 24 hours.`,
  }),
  reset: (name: string, url: string): Mail => ({
    to: '', subject: 'Reset your TAWA password',
    html: wrap('Reset your password', `<p>Hi ${esc(name)}, we received a request to reset your password.</p>${button(url, 'Choose a new password')}<p style="font-size:13px">This link expires in 1 hour and can be used once. If you didn’t ask for this, your password is unchanged — you can ignore this email.</p>`),
    text: `Hi ${name}, reset your password: ${url}\nExpires in 1 hour. Ignore if you didn't request this.`,
  }),
  alreadyRegistered: (name: string, url: string): Mail => ({
    to: '', subject: 'You already have a TAWA account',
    html: wrap('You already have an account', `<p>Hi ${esc(name)}, someone (hopefully you) tried to register with this email. You already have an account.</p>${button(url, 'Reset password')}<p style="font-size:13px">If this wasn’t you, no action is needed.</p>`),
    text: `Hi ${name}, you already have an account. Forgot your password? ${url}`,
  }),
  passwordChanged: (name: string): Mail => ({
    to: '', subject: 'Your TAWA password was changed',
    html: wrap('Password changed', `<p>Hi ${esc(name)}, your password was just changed and all other devices were signed out.</p><p>If this wasn’t you, reset your password immediately and contact us.</p>`),
    text: `Hi ${name}, your password was changed. If this wasn't you, reset it immediately and contact us.`,
  }),
  orderConfirmation: (o: { id: string; name: string; total: number; method: string; items: { name: string; size_label: string; qty: number; price: number }[] }, url: string, money: (n: number) => string): Mail => ({
    to: '', subject: `Order ${o.id} confirmed`,
    html: wrap(`Thank you, ${o.name.split(' ')[0]}!`, `<p>Your order <b>${esc(o.id)}</b> is confirmed.</p><table width="100%" cellpadding="6" style="font-size:15px;border-collapse:collapse">${o.items.map((i) => `<tr><td>${esc(i.name)} <span style="color:#7a6657">· ${esc(i.size_label)} × ${i.qty}</span></td><td align="right">${money(i.price * i.qty)}</td></tr>`).join('')}<tr><td style="border-top:1px solid #e0cfb9"><b>Total</b></td><td align="right" style="border-top:1px solid #e0cfb9"><b>${money(o.total)}</b></td></tr></table><p>Payment: ${o.method === 'mpesa' ? 'M-Pesa' : 'Pay on delivery'}</p>${button(url, 'Track your order')}`),
    text: `Thank you ${o.name}! Order ${o.id} confirmed. Total ${money(o.total)}. Track: ${url}`,
  }),
  orderStatus: (o: { id: string; name: string; status: string; tracking?: string | null }, url: string): Mail => ({
    to: '', subject: `Order ${o.id}: ${o.status}`,
    html: wrap(`Your order is ${o.status.toLowerCase()}`, `<p>Hi ${esc(o.name.split(' ')[0])}, the status of order <b>${esc(o.id)}</b> is now <b>${esc(o.status)}</b>.</p>${o.tracking ? `<p>Tracking reference: <b>${esc(o.tracking)}</b></p>` : ''}${button(url, 'View order')}`),
    text: `Order ${o.id} is now ${o.status}.${o.tracking ? ' Tracking: ' + o.tracking : ''} ${url}`,
  }),
  contactAck: (name: string): Mail => ({
    to: '', subject: 'We received your message',
    html: wrap('Thanks for getting in touch', `<p>Hi ${esc(name)}, we’ve received your message and will reply within one business day.</p>`),
    text: `Hi ${name}, we received your message and will reply within one business day.`,
  }),
  customAck: (name: string, id: string): Mail => ({
    to: '', subject: `Custom candle request ${id} received`,
    html: wrap('Request received', `<p>Hi ${esc(name)}, thank you! Your custom candle request <b>${esc(id)}</b> is with our studio. We’ll send you a quote within 1–2 business days.</p>`),
    text: `Hi ${name}, custom request ${id} received. We'll send a quote within 1-2 business days.`,
  }),
  customQuote: (name: string, id: string, amount: number, note: string | null, money: (n: number) => string): Mail => ({
    to: '', subject: `Your custom candle quote (${id})`,
    html: wrap('Your quote is ready', `<p>Hi ${esc(name)}, here is the quote for request <b>${esc(id)}</b>:</p><p style="font-size:28px;margin:8px 0">${money(amount)}</p>${note ? `<p>${esc(note)}</p>` : ''}<p>Reply to this email to approve and we’ll begin production.</p>`),
    text: `Hi ${name}, quote for ${id}: ${money(amount)}. ${note ?? ''} Reply to approve.`,
  }),
  newsletterWelcome: (unsub: string): Mail => ({
    to: '', subject: 'Welcome to the TAWA family',
    html: wrap('You’re on the list', `<p>Thanks for subscribing. Use code <b>WELCOME15</b> for 15% off your first order.</p><p style="font-size:12px;color:#7a6657"><a href="${esc(unsub)}">Unsubscribe</a></p>`),
    text: `Thanks for subscribing. Use WELCOME15 for 15% off. Unsubscribe: ${unsub}`,
  }),
  adminNotice: (subject: string, lines: string[]): Mail => ({
    to: '', subject,
    html: wrap(subject, lines.map((l) => `<p>${esc(l)}</p>`).join('')),
    text: lines.join('\n'),
  }),
}

export const mail = (to: string, m: Mail) => sendMail({ ...m, to })

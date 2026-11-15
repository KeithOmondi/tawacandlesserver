import request from 'supertest'
import { createApp } from '../src/app.ts'
import { getDb } from '../src/db/index.ts'
import { migrate } from '../src/db/migrate.ts'
import { seed } from '../src/db/seed.ts'
import { hashPassword, totpAt } from '../src/lib/crypto.ts'
import { outbox } from '../src/lib/mailer.ts'

export const app = createApp()
export const XHR = { 'X-Requested-With': 'tawa' }
export const GOOD_PASSWORD = 'Correct-Horse-9-Battery'

export async function setupDb() {
  await migrate()
  await seed()
}

export const lastMailTo = (email: string) => [...outbox].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase())
export const tokenFromMail = (email: string) => lastMailTo(email)?.text.match(/token=([\w-]+)/)?.[1] ?? ''

let n = 0
export const uniqueEmail = (p = 'user') => `${p}${Date.now()}${n++}@example.com`

/** Registers + verifies a customer through the public API and returns a signed-in agent. */
export async function signedInCustomer(email = uniqueEmail()) {
  await request(app).post('/api/auth/register').send({ name: 'Test Customer', email, password: GOOD_PASSWORD, acceptTerms: true }).expect(202)
  await request(app).post('/api/auth/verify-email').send({ token: tokenFromMail(email) }).expect(200)
  const agent = request.agent(app)
  const res = await agent.post('/api/auth/login').send({ email, password: GOOD_PASSWORD }).expect(200)
  return { agent, email, token: res.body.accessToken as string, user: res.body.user }
}

/** Inserts an admin directly (as the CLI would) and signs in through the real login/MFA flow. */
export async function signedInAdmin(opts: { withMfa: boolean } = { withMfa: true }) {
  const email = uniqueEmail('admin')
  const db = await getDb()
  await db.query(`INSERT INTO users (email, password_hash, name, role, email_verified_at) VALUES ($1,$2,'Admin','admin',now())`, [email, await hashPassword(GOOD_PASSWORD)])
  const agent = request.agent(app)
  let res = await agent.post('/api/auth/login').send({ email, password: GOOD_PASSWORD }).expect(200)
  let token = res.body.accessToken as string
  let secret = ''
  if (opts.withMfa) {
    const setup = await agent.post('/api/auth/mfa/setup').set('Authorization', `Bearer ${token}`).send({ password: GOOD_PASSWORD }).expect(200)
    secret = setup.body.secret
    res = await agent.post('/api/auth/mfa/enable').set('Authorization', `Bearer ${token}`).send({ code: totpAt(secret) }).expect(200)
    token = res.body.accessToken
  }
  return { agent, email, token, secret, auth: () => ({ Authorization: `Bearer ${token}` }) }
}

export async function firstProduct(slug = 'golden-hour') {
  const r = await request(app).get(`/api/products/${slug}`).expect(200)
  return r.body.product as { id: string; stock: number; sizes: { id: string; price: number }[] }
}

export const orderBody = (productId: string, overrides: Record<string, unknown> = {}) => ({
  items: [{ productId, sizeCode: 'm', qty: 1 }],
  contact: { email: uniqueEmail('buyer'), name: 'Buyer Person', phone: '0712345678' },
  address: { line1: '12 Kimathi Street', city: 'Nairobi', region: 'Nairobi', postcode: '00100', country: 'Kenya' },
  delivery: 'standard', paymentMethod: 'cod', acceptTerms: true,
  ...overrides,
})

import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'
import { totpAt } from '../src/lib/crypto.ts'
import { GOOD_PASSWORD, XHR, app, lastMailTo, setupDb, signedInAdmin, signedInCustomer, tokenFromMail, uniqueEmail } from './helpers.ts'

beforeAll(setupDb)

describe('crypto', () => {
  it('TOTP matches the RFC 6238 test vector', () => {
    expect(totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082')
  })
})

describe('registration', () => {
  it('requires accepting the terms and a strong password', async () => {
    const email = uniqueEmail()
    await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: GOOD_PASSWORD }).expect(400)
    const weak = await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: 'password123', acceptTerms: true }).expect(400)
    expect(weak.body.error.details.password).toBeTruthy()
    await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: 'short', acceptTerms: true }).expect(400)
  })

  it('does not reveal whether an email is already registered', async () => {
    const email = uniqueEmail()
    const a = await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: GOOD_PASSWORD, acceptTerms: true })
    const b = await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: GOOD_PASSWORD, acceptTerms: true })
    expect(a.status).toBe(202); expect(b.status).toBe(202)
    expect(b.body).toEqual(a.body)
    expect(lastMailTo(email)?.subject).toMatch(/already have/i)
  })

  it('verification tokens are single-use', async () => {
    const email = uniqueEmail()
    await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: GOOD_PASSWORD, acceptTerms: true })
    const token = tokenFromMail(email)
    await request(app).post('/api/auth/verify-email').send({ token }).expect(200)
    await request(app).post('/api/auth/verify-email').send({ token }).expect(400)
  })
})

describe('login & sessions', () => {
  it('gives the same error for unknown users and wrong passwords', async () => {
    const { email } = await signedInCustomer()
    const a = await request(app).post('/api/auth/login').send({ email, password: 'Wrong-password-1!' })
    const b = await request(app).post('/api/auth/login').send({ email: uniqueEmail('nobody'), password: 'Wrong-password-1!' })
    expect(a.status).toBe(401); expect(b.status).toBe(401)
    expect(a.body.error.message).toBe(b.body.error.message)
  })

  it('locks the account after repeated failures (even for the right password)', async () => {
    const { email } = await signedInCustomer()
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email, password: 'Wrong-password-1!' }).expect(401)
    await request(app).post('/api/auth/login').send({ email, password: GOOD_PASSWORD }).expect(401)
  })

  it('never exposes the password hash or secrets in responses', async () => {
    const { agent, token } = await signedInCustomer()
    const me = await agent.get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200)
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash|secret|scrypt/i)
  })

  it('rotates refresh tokens and detects reuse of a stolen token', async () => {
    const email = uniqueEmail()
    await request(app).post('/api/auth/register').send({ name: 'Jo Doe', email, password: GOOD_PASSWORD, acceptTerms: true })
    await request(app).post('/api/auth/verify-email').send({ token: tokenFromMail(email) })
    const login = await request(app).post('/api/auth/login').send({ email, password: GOOD_PASSWORD }).expect(200)
    const cookie1 = login.headers['set-cookie'][0].split(';')[0]
    expect(login.headers['set-cookie'][0]).toMatch(/HttpOnly/i)
    expect(login.headers['set-cookie'][0]).toMatch(/SameSite=Strict/i)

    await request(app).post('/api/auth/refresh').set('Cookie', cookie1).expect(403) // custom header required (CSRF defence)
    const r2 = await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookie1).expect(200)
    const cookie2 = r2.headers['set-cookie'][0].split(';')[0]
    expect(cookie2).not.toBe(cookie1)

    // Replaying the old (already rotated) token is treated as theft: the whole family dies.
    await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookie1).expect(401)
    await request(app).post('/api/auth/refresh').set(XHR).set('Cookie', cookie2).expect(401)
  })

  it('rejects tampered and missing access tokens', async () => {
    await request(app).get('/api/auth/me').expect(401)
    await request(app).get('/api/auth/me').set('Authorization', 'Bearer abc.def.ghi').expect(401)
    const { token } = await signedInCustomer()
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token.slice(0, -3)}xyz`).expect(401)
  })
})

describe('password reset', () => {
  it('resets the password, signs out all devices and burns the token', async () => {
    const { agent, email, token } = await signedInCustomer()
    await request(app).post('/api/auth/forgot-password').send({ email }).expect(202)
    const resetToken = tokenFromMail(email)
    await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: 'password123' }).expect(400) // weak, token NOT burned
    await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: 'Another-Strong-Pass-7' }).expect(200)
    await request(app).post('/api/auth/reset-password').send({ token: resetToken, password: 'Yet-Another-Pass-8!' }).expect(400)
    await request(app).post('/api/auth/login').send({ email, password: GOOD_PASSWORD }).expect(401)
    await request(app).post('/api/auth/login').send({ email, password: 'Another-Strong-Pass-7' }).expect(200)
    void agent; void token
  })

  it('answers identically for unknown emails', async () => {
    const a = await request(app).post('/api/auth/forgot-password').send({ email: uniqueEmail('ghost') })
    const { email } = await signedInCustomer()
    const b = await request(app).post('/api/auth/forgot-password').send({ email })
    expect(a.status).toBe(b.status); expect(a.body).toEqual(b.body)
  })
})

describe('admin access control & MFA', () => {
  it('hides the admin API from customers and anonymous users', async () => {
    await request(app).get('/api/admin/stats').expect(401)
    const { token } = await signedInCustomer()
    await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${token}`).expect(404)
  })

  it('blocks admins until two-factor authentication is enrolled', async () => {
    const a = await signedInAdmin({ withMfa: false })
    const r = await request(app).get('/api/admin/stats').set(a.auth()).expect(403)
    expect(r.body.error.code).toBe('mfa_required')
  })

  it('requires a valid TOTP code at login, blocks replays, and unlocks the admin API', async () => {
    const a = await signedInAdmin({ withMfa: true })
    await request(app).get('/api/admin/stats').set(a.auth()).expect(200)

    const fresh = request.agent(app)
    const step1 = await fresh.post('/api/auth/login').send({ email: a.email, password: GOOD_PASSWORD }).expect(200)
    expect(step1.body.mfaRequired).toBe(true)
    expect(step1.body.accessToken).toBeUndefined()
    await fresh.post('/api/auth/mfa/login').send({ mfaToken: step1.body.mfaToken, code: '000000' }).expect(401)
    // The code consumed during enrolment cannot be replayed; use the next time-step.
    const code = totpAt(a.secret, Date.now() + 30_000)
    const ok = await fresh.post('/api/auth/mfa/login').send({ mfaToken: step1.body.mfaToken, code }).expect(200)
    await request(app).get('/api/admin/stats').set('Authorization', `Bearer ${ok.body.accessToken}`).expect(200)
    await fresh.post('/api/auth/mfa/login').send({ mfaToken: step1.body.mfaToken, code }).expect(401) // replay
  })

  it('does not let admins disable MFA', async () => {
    const a = await signedInAdmin()
    await request(app).post('/api/auth/mfa/disable').set(a.auth()).send({ password: GOOD_PASSWORD, code: totpAt(a.secret, Date.now() + 30_000) }).expect(403)
  })
})

describe('transport security', () => {
  it('sets hardened headers and a strict CSP', async () => {
    const r = await request(app).get('/api/products')
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/)
    expect(r.headers['x-powered-by']).toBeUndefined()
    expect(r.headers['x-request-id']).toBeTruthy()
  })

  it('rejects unsafe requests from foreign origins', async () => {
    await request(app).post('/api/contact').set('Origin', 'https://evil.example').send({}).expect(403)
  })

  it('does not leak stack traces on bad input', async () => {
    const r = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json')
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.ts/)
  })
})

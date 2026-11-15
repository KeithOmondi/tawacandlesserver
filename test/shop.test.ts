import request from 'supertest'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb } from '../src/db/index.ts'
import { app, firstProduct, orderBody, setupDb, signedInAdmin, signedInCustomer, uniqueEmail } from './helpers.ts'

beforeAll(setupDb)

describe('catalogue', () => {
  it('lists seeded products with computed ratings', async () => {
    const r = await request(app).get('/api/products').expect(200)
    expect(r.body.products.length).toBe(12)
    const p = r.body.products[0]
    expect(p.sizes.length).toBeGreaterThan(0)
    expect(typeof p.rating).toBe('number')
  })
  it('404s unknown products and rejects malformed slugs', async () => {
    await request(app).get('/api/products/nope').expect(404)
    await request(app).get('/api/products/%27%20OR%201=1--').expect(400)
  })
})

describe('pricing is server-authoritative', () => {
  it('ignores client-supplied prices and totals', async () => {
    const p = await firstProduct()
    const price = p.sizes.find((s) => s.id === 'm')!.price
    const r = await request(app).post('/api/orders/quote').send({ items: [{ productId: p.id, sizeCode: 'm', qty: 2, price: 1 }], total: 1 }).expect(200)
    expect(r.body.subtotal).toBe(price * 2)
  })
  it('rejects bad quantities, unknown items and invalid promos', async () => {
    const p = await firstProduct()
    await request(app).post('/api/orders/quote').send({ items: [{ productId: p.id, sizeCode: 'm', qty: -1 }] }).expect(400)
    await request(app).post('/api/orders/quote').send({ items: [{ productId: p.id, sizeCode: 'zz', qty: 1 }] }).expect(400)
    await request(app).post('/api/orders/quote').send({ items: [{ productId: 'not-a-uuid', sizeCode: 'm', qty: 1 }] }).expect(400)
    await request(app).post('/api/orders/quote').send({ items: [{ productId: p.id, sizeCode: 'm', qty: 1 }], promo: 'FAKE' }).expect(400)
  })
  it('applies promo codes and free-shipping rules', async () => {
    const p = await firstProduct()
    const r = await request(app).post('/api/orders/quote').send({ items: [{ productId: p.id, sizeCode: 'l', qty: 2 }], promo: 'tawa10' }).expect(200)
    expect(r.body.discount).toBe(Math.round(r.body.subtotal * 0.1))
    expect(r.body.shipping.standard).toBe(0) // over KSh 8,000 after discount
  })
})

describe('orders', () => {
  it('creates a COD order, decrements stock and restocks on cancel', async () => {
    const p = await firstProduct('sea-salt-sage')
    const body = orderBody(p.id)
    const r = await request(app).post('/api/orders').send(body).expect(201)
    expect(r.body.order.status).toBe('Processing')
    expect(r.body.order.total).toBe(p.sizes.find((s) => s.id === 'm')!.price + 400)
    expect((await firstProduct('sea-salt-sage')).stock).toBe(p.stock - 1)

    await request(app).post(`/api/orders/${r.body.order.id}/cancel`).expect(404) // no proof of ownership
    await request(app).post(`/api/orders/${r.body.order.id}/cancel`).set('X-Order-Token', r.body.orderToken).expect(200)
    expect((await firstProduct('sea-salt-sage')).stock).toBe(p.stock)
  })

  it('refuses to oversell', async () => {
    const p = await firstProduct('terracotta-pillar')
    const db = await getDb()
    await db.query('UPDATE products SET stock = 1 WHERE id = $1', [p.id])
    await request(app).post('/api/orders').send(orderBody(p.id, { items: [{ productId: p.id, sizeCode: 'm', qty: 2 }] })).expect(400)
    await request(app).post('/api/orders').send(orderBody(p.id)).expect(201)
    await request(app).post('/api/orders').send(orderBody(p.id)).expect(400)
  })

  it('requires terms acceptance and valid contact details', async () => {
    const p = await firstProduct()
    await request(app).post('/api/orders').send(orderBody(p.id, { acceptTerms: false })).expect(400)
    await request(app).post('/api/orders').send(orderBody(p.id, { contact: { email: 'bad', name: 'A', phone: '1' } })).expect(400)
  })

  it('only lets the owner, token holder or admin read an order', async () => {
    const p = await firstProduct()
    const alice = await signedInCustomer()
    const mine = await alice.agent.post('/api/orders').set('Authorization', `Bearer ${alice.token}`).send(orderBody(p.id, { contact: { email: alice.email, name: 'Alice A', phone: '0712345678' } })).expect(201)
    const id = mine.body.order.id
    await request(app).get(`/api/orders/${id}`).expect(404)
    const bob = await signedInCustomer()
    await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${bob.token}`).expect(404)
    await request(app).get(`/api/orders/${id}`).set('Authorization', `Bearer ${alice.token}`).expect(200)
    await request(app).get(`/api/orders/${id}`).set('X-Order-Token', mine.body.orderToken).expect(200)
    const list = await request(app).get('/api/account/orders').set('Authorization', `Bearer ${alice.token}`).expect(200)
    expect(list.body.orders.map((o: any) => o.id)).toContain(id)
    const bobList = await request(app).get('/api/account/orders').set('Authorization', `Bearer ${bob.token}`).expect(200)
    expect(bobList.body.orders.map((o: any) => o.id)).not.toContain(id)
  })

  it('guest tracking needs the matching email and gives one generic failure', async () => {
    const p = await firstProduct()
    const email = uniqueEmail('track')
    const o = await request(app).post('/api/orders').send(orderBody(p.id, { contact: { email, name: 'Tracker T', phone: '0712345678' } })).expect(201)
    await request(app).get('/api/orders/track').query({ id: o.body.order.id, email }).expect(200)
    const wrongEmail = await request(app).get('/api/orders/track').query({ id: o.body.order.id, email: uniqueEmail() }).expect(404)
    const wrongId = await request(app).get('/api/orders/track').query({ id: 'TAWA-999999', email }).expect(404)
    expect(wrongEmail.body.error.message).toBe(wrongId.body.error.message)
  })
})

describe('M-Pesa payments (mock provider)', () => {
  it('pays an order via STK push and confirms through status polling', async () => {
    const p = await firstProduct()
    const o = await request(app).post('/api/orders').send(orderBody(p.id, { paymentMethod: 'mpesa' })).expect(201)
    const { id } = o.body.order, token = o.body.orderToken
    expect(o.body.order.status).toBe('Pending payment')

    await request(app).post('/api/payments/mpesa/stk').send({ orderId: id, phone: '0712345678' }).expect(404) // no proof of ownership
    await request(app).post('/api/payments/mpesa/stk').set('X-Order-Token', token).send({ orderId: id, phone: '12345' }).expect(400)
    await request(app).post('/api/payments/mpesa/stk').set('X-Order-Token', token).send({ orderId: id, phone: '0712345678' }).expect(202)

    const db = await getDb()
    await db.query(`UPDATE payments SET created_at = now() - interval '10 seconds' WHERE order_id = $1`, [id])
    const s = await request(app).get(`/api/payments/status/${id}`).set('X-Order-Token', token).expect(200)
    expect(s.body.paymentStatus).toBe('paid')
    expect(s.body.orderStatus).toBe('Processing')
    await request(app).post('/api/payments/mpesa/stk').set('X-Order-Token', token).send({ orderId: id, phone: '0712345678' }).expect(409)
  })

  it('does not expose the callback endpoint without the secret', async () => {
    await request(app).post('/api/payments/mpesa/callback/guess').send({ Body: { stkCallback: { CheckoutRequestID: 'x', ResultCode: 0 } } }).expect(404)
  })
})

describe('admin operations', () => {
  it('manages products, orders and the audit trail', async () => {
    const a = await signedInAdmin()
    const created = await request(app).post('/api/admin/products').set(a.auth()).send({
      name: 'Test Candle', category: 'Jar Candles', vessel: 'jar', stock: 5, sizes: [{ code: 'm', label: 'Classic', price: 2500 }],
    }).expect(201)
    expect(created.body.product.slug).toBe('test-candle')
    await request(app).post('/api/admin/products').set(a.auth()).send({ name: 'Test Candle', category: 'Jar Candles', vessel: 'jar', stock: 5, sizes: [{ code: 'm', label: 'Classic', price: 2500 }] }).expect(409)
    await request(app).post('/api/admin/products').set(a.auth()).send({ name: 'X', category: 'Bad', vessel: 'jar', stock: -1, sizes: [] }).expect(400)

    const p = await firstProduct()
    const o = await request(app).post('/api/orders').send(orderBody(p.id)).expect(201)
    const upd = await request(app).patch(`/api/admin/orders/${o.body.order.id}`).set(a.auth()).send({ status: 'Delivered' }).expect(200)
    expect(upd.body.order.paymentStatus).toBe('paid') // COD is settled on delivery
    await request(app).patch(`/api/admin/orders/${o.body.order.id}`).set(a.auth()).send({ status: 'Bogus' }).expect(400)

    const audit = await request(app).get('/api/admin/audit').set(a.auth()).expect(200)
    expect(audit.body.entries.some((e: any) => e.action === 'admin.product.create')).toBe(true)
  })

  it('auto-generates size codes and keeps existing ones stable on edit', async () => {
    const a = await signedInAdmin()
    const body = { name: 'Auto Code Candle', category: 'Jar Candles', vessel: 'jar', stock: 5, sizes: [{ label: 'Small', price: 1000 }, { label: 'Large', price: 2000 }] }
    const c = await request(app).post('/api/admin/products').set(a.auth()).send(body).expect(201)
    const codes = c.body.product.sizes.map((x: any) => x.id)
    expect(new Set(codes).size).toBe(2)
    // editing: send existing codes back plus one brand-new size
    const sizes = [...c.body.product.sizes.map((x: any) => ({ code: x.id, label: x.label, price: x.price })), { label: 'XL', price: 3000 }]
    const u = await request(app).put(`/api/admin/products/${c.body.product.id}`).set(a.auth()).send({ ...body, slug: c.body.product.slug, sizes }).expect(200)
    const after = u.body.product.sizes.map((x: any) => x.id)
    expect(after).toEqual(expect.arrayContaining(codes))
    expect(new Set(after).size).toBe(3)
  })

  it('handles contact messages and custom requests end-to-end', async () => {
    await request(app).post('/api/contact').send({ name: 'Wanjiku', email: uniqueEmail(), subject: 'Hello', body: 'Do you ship to Mombasa?' }).expect(201)
    const a = await signedInAdmin()
    const msgs = await request(app).get('/api/admin/messages').set(a.auth()).expect(200)
    expect(msgs.body.messages.some((m: any) => m.subject === 'Hello')).toBe(true)

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
    const field = (r: request.Test) => r.field('name', 'Amina').field('email', uniqueEmail()).field('vessel', 'Glass jar').field('size', 'Classic')
      .field('color', 'Sage').field('scent', 'Fig & Honey').field('occasion', 'Wedding').field('quantity', '24').field('label', 'A & J')
    const c = await field(request(app).post('/api/custom-requests')).attach('reference', png, 'ref.png').expect(201)
    expect(c.body.estimate).toBe(Math.round((2350 + 400) * 24 * 0.9)) // server recomputes the estimate; 10% bulk discount
    await field(request(app).post('/api/custom-requests')).attach('reference', Buffer.from('<?php echo 1 ?>'), 'evil.png').expect(400) // magic-byte check
    const list = await request(app).get('/api/admin/custom-requests').set(a.auth()).expect(200)
    expect(list.body.requests[0].hasReference).toBeDefined()
  })
})

describe('account rights', () => {
  it('exports data and erases the account', async () => {
    const c = await signedInCustomer()
    const exp = await request(app).get('/api/account/export').set('Authorization', `Bearer ${c.token}`).expect(200)
    expect(exp.body.account.email).toBe(c.email)
    expect(JSON.stringify(exp.body)).not.toMatch(/password_hash/)
    await request(app).post('/api/account/delete').set('Authorization', `Bearer ${c.token}`).send({ password: 'wrong' }).expect(401)
    await request(app).post('/api/account/delete').set('Authorization', `Bearer ${c.token}`).send({ password: 'Correct-Horse-9-Battery' }).expect(204)
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${c.token}`).expect(401)
    await request(app).post('/api/auth/login').send({ email: c.email, password: 'Correct-Horse-9-Battery' }).expect(401)
  })
})

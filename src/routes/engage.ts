import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { config } from '../config.ts'
import { getDb } from '../db/index.ts'
import { clientIp } from '../lib/audit.ts'
import { randomToken } from '../lib/crypto.ts'
import { notFound } from '../lib/errors.ts'
import { link, mail, templates } from '../lib/mailer.ts'
import { money } from '../lib/pricing.ts'
import { MAX_UPLOAD_BYTES, saveImage } from '../lib/uploads.ts'
import { limits, optionalAuth, parse } from '../middleware/index.ts'
import { emailSchema } from './auth.ts'

export const router = Router()

const phone = z.string().trim().regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number.')
const optionalPhone = phone.optional().or(z.literal('').transform(() => undefined))

// ---------- contact form ----------
router.post('/contact', optionalAuth, limits.write, async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100), email: emailSchema, phone: optionalPhone,
    subject: z.string().trim().min(2).max(120), body: z.string().trim().min(10, 'Please write at least a sentence.').max(5000),
    website: z.string().max(200).optional(), // honeypot — real users never fill this in
  }), req.body)
  if (b.website) return void res.status(201).json({ message: 'Message sent.' }) // pretend success to bots
  const db = await getDb()
  await db.query('INSERT INTO messages (name, email, phone, subject, body, ip) VALUES ($1,$2,$3,$4,$5,$6)', [b.name, b.email, b.phone ?? null, b.subject, b.body, clientIp(req)])
  await mail(b.email, templates.contactAck(b.name))
  await mail(config.STORE_NOTIFY_EMAIL, templates.adminNotice(`New message: ${b.subject}`, [`From ${b.name} <${b.email}>`, b.body.slice(0, 1000)]))
  res.status(201).json({ message: 'Message sent.' })
})

// ---------- custom candle requests ----------
const VESSELS: Record<string, number> = { 'Glass jar': 2350, Tumbler: 2600, 'Travel tin': 1550, Pillar: 2100 }
const SIZES: Record<string, number> = { Petite: 0.7, Classic: 1, Grand: 1.4 }
const COLORS = ['Ivory', 'Blush', 'Sage', 'Terracotta', 'Lilac', 'Honey', 'Charcoal', 'Sky']
const SCENTS = ['Vanilla & Amber', 'Rose & Peony', 'Lavender & Chamomile', 'Sandalwood & Oud', 'Sea Salt & Sage', 'Fig & Honey', 'Citrus & Neroli', 'Cinnamon & Clove', 'Unscented', 'Surprise me']
const OCCASIONS = ['Wedding', 'Birthday', 'Corporate gift', 'Baby shower', 'Housewarming', 'Memorial', 'Just because', 'Other']

export const estimateCustom = (vessel: string, size: string, label: string, qty: number) => {
  const unit = VESSELS[vessel] * SIZES[size] + (label.trim() ? 400 : 0)
  const discount = qty >= 50 ? 0.2 : qty >= 12 ? 0.1 : 0
  return Math.round(unit * qty * (1 - discount))
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 20, fieldSize: 10_000 } })

router.post('/custom-requests', optionalAuth, limits.write, upload.single('reference'), async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(100), email: emailSchema, phone: optionalPhone,
    vessel: z.enum(Object.keys(VESSELS) as [string, ...string[]]), size: z.enum(Object.keys(SIZES) as [string, ...string[]]),
    color: z.enum(COLORS as [string, ...string[]]), scent: z.enum(SCENTS as [string, ...string[]]),
    label: z.string().trim().max(40).default(''), occasion: z.enum(OCCASIONS as [string, ...string[]]),
    quantity: z.coerce.number().int().min(1).max(5000),
    neededBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
    budget: z.string().trim().max(60).optional().or(z.literal('').transform(() => undefined)),
    notes: z.string().trim().max(3000).optional().or(z.literal('').transform(() => undefined)),
  }), req.body)
  const file = req.file ? await saveImage(req.file.buffer) : null
  const id = `CUS-${randomToken(4).replace(/[^A-Za-z0-9]/g, 'X').slice(0, 6).toUpperCase()}`
  const estimate = estimateCustom(b.vessel, b.size, b.label, b.quantity)
  const db = await getDb()
  await db.query(
    `INSERT INTO custom_requests (id, user_id, name, email, phone, vessel, size, color, scent, label, occasion, quantity, needed_by, budget, notes, reference_file, estimate)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, req.user?.id ?? null, b.name, b.email, b.phone ?? null, b.vessel, b.size, b.color, b.scent, b.label, b.occasion, b.quantity, b.neededBy ?? null, b.budget ?? null, b.notes ?? null, file, estimate])
  await mail(b.email, templates.customAck(b.name, id))
  await mail(config.STORE_NOTIFY_EMAIL, templates.adminNotice(`New custom request ${id}`, [`${b.name} <${b.email}>`, `${b.quantity} × ${b.vessel} (${b.size}), ${b.color}, ${b.scent}, ${b.occasion}`, `Estimate ${money(estimate)}`]))
  res.status(201).json({ id, estimate })
})

// ---------- newsletter ----------
router.post('/newsletter', limits.email, async (req, res) => {
  const { email, website } = parse(z.object({ email: emailSchema, website: z.string().max(200).optional() }), req.body)
  if (!website) {
    const db = await getDb()
    const token = randomUUID()
    const r = await db.query('INSERT INTO subscribers (email, token) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [email, token])
    if (r.rowCount) await mail(email, templates.newsletterWelcome(link(`/unsubscribe?token=${token}`)))
  }
  // Same answer whether or not the address was already subscribed.
  res.status(202).json({ message: 'Thanks for subscribing!' })
})

router.post('/newsletter/unsubscribe', limits.auth, async (req, res) => {
  const { token } = parse(z.object({ token: z.uuid() }), req.body)
  const db = await getDb()
  const r = await db.query('DELETE FROM subscribers WHERE token = $1', [token])
  if (!r.rowCount) throw notFound('This unsubscribe link is no longer valid.')
  res.json({ message: 'You have been unsubscribed.' })
})

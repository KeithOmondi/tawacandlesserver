import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scrypt as _scrypt, timingSafeEqual,
} from 'node:crypto'
import { promisify } from 'node:util'
import { config } from '../config.ts'

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>

// ---------- passwords (scrypt, OWASP-recommended parameters) ----------
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64
const scryptOpts = { N, r: R, p: P, maxmem: 128 * N * R * 2 }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, scryptOpts)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$')
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false
  const salt = Buffer.from(saltB64, 'base64')
  const expected = Buffer.from(keyB64, 'base64')
  const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { N: +n, r: +r, p: +p, maxmem: 128 * +n * +r * 2 })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/** A real hash to compare against when the user does not exist (prevents timing-based user enumeration). */
let dummy: Promise<string> | undefined
export const dummyHash = () => (dummy ??= hashPassword('not-a-real-password-' + randomBytes(8).toString('hex')))

const COMMON = new Set([
  'password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou123', 'letmein1234',
  'welcome1234', 'admin12345', 'candle12345', 'tawacandles', 'changeme123', 'qwerty12345', 'abcdefghij', '0123456789',
])

/** Returns an error message, or null if the password is acceptable. */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < 10) return 'Password must be at least 10 characters.'
  if (password.length > 128) return 'Password must be at most 128 characters.'
  const lower = password.toLowerCase()
  if (COMMON.has(lower)) return 'That password is too common.'
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character.'
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length
  if (classes < 2 && password.length < 16) return 'Use a mix of letters, numbers or symbols (or a longer passphrase).'
  const local = context.email?.split('@')[0]?.toLowerCase()
  if (local && local.length >= 4 && lower.includes(local)) return 'Password must not contain your email.'
  if (context.name && context.name.length >= 4 && lower.includes(context.name.toLowerCase())) return 'Password must not contain your name.'
  return null
}

// ---------- tokens ----------
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')
export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
export const randomCode = (digits = 6) => String(randomInt(0, 10 ** digits)).padStart(digits, '0')

// ---------- encryption at rest (AES-256-GCM) ----------
const key = createHash('sha256').update(config.DATA_ENCRYPTION_KEY).digest()
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.')
}
export function decrypt(payload: string): string {
  const [iv, tag, enc] = payload.split('.').map((s) => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30s) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export function base32Encode(buf: Buffer): string {
  let bits = '', out = ''
  for (const b of buf) bits += b.toString(2).padStart(8, '0')
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)]
  return out
}
export function base32Decode(s: string): Buffer {
  let bits = ''
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(ch)
    if (v < 0) throw new Error('bad base32')
    bits += v.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}
export const newTotpSecret = () => base32Encode(randomBytes(20))
export function totpAt(secret: string, time = Date.now()): string {
  const counter = Math.floor(time / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const off = h[h.length - 1] & 0xf
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(code % 1_000_000).padStart(6, '0')
}
/** Accepts the current code ±1 step. Returns the matched time-step (to block replay) or null. */
export function verifyTotp(secret: string, code: string, time = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  for (const drift of [-1, 0, 1]) {
    const t = time + drift * 30_000
    if (safeEqual(totpAt(secret, t), code)) return Math.floor(t / 1000 / 30)
  }
  return null
}
export const totpUri = (secret: string, email: string) =>
  `otpauth://totp/${encodeURIComponent('TAWA Candles')}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent('TAWA Candles')}&digits=6&period=30`

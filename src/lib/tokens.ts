import { SignJWT, jwtVerify } from 'jose'
import { config } from '../config.ts'

const secret = new TextEncoder().encode(config.JWT_SECRET)
const ISS = 'tawa-candles', AUD = 'tawa-web'

type Purpose = 'access' | 'mfa' | 'order'

async function sign(purpose: Purpose, sub: string, ttlSeconds: number, extra: Record<string, unknown> = {}) {
  return new SignJWT({ pur: purpose, ...extra })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub).setIssuer(ISS).setAudience(AUD)
    .setIssuedAt().setExpirationTime(`${ttlSeconds}s`)
    .sign(secret)
}

async function verify(token: string, purpose: Purpose) {
  const { payload } = await jwtVerify(token, secret, { issuer: ISS, audience: AUD, algorithms: ['HS256'] })
  if (payload.pur !== purpose) throw new Error('wrong token purpose')
  return payload
}

export const signAccess = (userId: string, role: string, mfa: boolean) =>
  sign('access', userId, config.ACCESS_TOKEN_TTL_MIN * 60, { role, mfa })
export async function verifyAccess(token: string) {
  const p = await verify(token, 'access')
  return { id: String(p.sub), mfa: p.mfa === true }
}

/** Short-lived token proving the password step passed; exchanged for a session after the TOTP step. */
export const signMfaChallenge = (userId: string) => sign('mfa', userId, 5 * 60)
export async function verifyMfaChallenge(token: string) { return String((await verify(token, 'mfa')).sub) }

/** Proves possession of a just-placed order (guest checkout) for payment polling and the confirmation page. */
export const signOrderToken = (orderId: string) => sign('order', orderId, 24 * 3600)
export async function verifyOrderToken(token: string) { return String((await verify(token, 'order')).sub) }

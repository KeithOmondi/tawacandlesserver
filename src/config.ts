import 'dotenv/config'
import { z } from 'zod'

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  /** Public URL of the storefront (used in emails and for CORS / origin checks). */
  APP_URL: z.url().default('http://localhost:5173'),
  /** Extra allowed browser origins, comma separated. */
  CORS_ORIGINS: z.string().default(''),
  /** Number of reverse proxies in front of the app (for correct client IPs / rate limits). */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  /** Serve the built storefront from this server (single deployable). */
  SERVE_CLIENT: bool.default(false),
  CLIENT_DIST: z.string().default('../client/dist'),

  /** Postgres connection string. If empty (dev/test only) an embedded Postgres is used. */
  DATABASE_URL: z.string().default(''),
  DATABASE_SSL: bool.default(true),
  PGLITE_DIR: z.string().default('.pglite'),

  /** 32+ random bytes, base64/hex. Signs JWTs. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** 32+ random chars. Encrypts MFA secrets at rest (AES-256-GCM). */
  DATA_ENCRYPTION_KEY: z.string().min(32, 'DATA_ENCRYPTION_KEY must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).max(60).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  ADMIN_REQUIRE_MFA: bool.default(true),

  /** Brevo transactional email API key (Brevo → SMTP & API → API Keys). */
  BREVO_API_KEY: z.string().default(''),
  /** Must be a sender/domain verified in Brevo. */
  SENDER_EMAIL: z.string().default(''),
  SENDER_NAME: z.string().default('TAWA Candles'),
  STORE_NOTIFY_EMAIL: z.string().default('hello@tawacandles.com'),

  MPESA_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  MPESA_CONSUMER_KEY: z.string().default(''),
  MPESA_CONSUMER_SECRET: z.string().default(''),
  MPESA_SHORTCODE: z.string().default(''),
  MPESA_PASSKEY: z.string().default(''),
  /** Public HTTPS base URL Safaricom can reach, e.g. https://shop.tawacandles.com */
  MPESA_CALLBACK_BASE: z.string().default(''),
  /** Random string embedded in the callback URL path. */
  MPESA_CALLBACK_SECRET: z.string().default(''),

  UPLOAD_DIR: z.string().default('uploads'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment configuration:')
  for (const i of parsed.error.issues) console.error(` - ${i.path.join('.')}: ${i.message}`)
  process.exit(1)
}

export const config = parsed.data
export const isProd = config.NODE_ENV === 'production'
export const isTest = config.NODE_ENV === 'test'

// Hard production requirements — refuse to boot insecurely.
if (isProd) {
  const problems: string[] = []
  if (!config.DATABASE_URL) problems.push('DATABASE_URL is required in production')
  if (!config.APP_URL.startsWith('https://')) problems.push('APP_URL must be https in production')
  if (!config.BREVO_API_KEY) problems.push('BREVO_API_KEY is required in production (verification/reset emails)')
  if (!config.SENDER_EMAIL) problems.push('SENDER_EMAIL is required in production')
  if (config.MPESA_MODE === 'mock') problems.push('MPESA_MODE=mock is not allowed in production')
  if (config.MPESA_MODE !== 'mock') {
    for (const k of ['MPESA_CONSUMER_KEY', 'MPESA_CONSUMER_SECRET', 'MPESA_SHORTCODE', 'MPESA_PASSKEY', 'MPESA_CALLBACK_BASE', 'MPESA_CALLBACK_SECRET'] as const) {
      if (!config[k]) problems.push(`${k} is required when MPESA_MODE is ${config.MPESA_MODE}`)
    }
    if (config.MPESA_CALLBACK_SECRET && config.MPESA_CALLBACK_SECRET.length < 24) problems.push('MPESA_CALLBACK_SECRET must be at least 24 characters')
  }
  if (!config.ADMIN_REQUIRE_MFA) problems.push('ADMIN_REQUIRE_MFA must be true in production')
  if (/change|example|secret|password/i.test(config.JWT_SECRET)) problems.push('JWT_SECRET looks like a placeholder')
  if (problems.length) {
    console.error('Refusing to start in production:')
    for (const p of problems) console.error(` - ${p}`)
    process.exit(1)
  }
}

export const allowedOrigins = [
  new URL(config.APP_URL).origin,
  ...config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
]

export const TERMS_VERSION = '2026-11-15'
export const PRIVACY_VERSION = '2026-11-15'

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import compression from 'compression'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { allowedOrigins, config, isProd } from './config.ts'
import { getDb } from './db/index.ts'
import { EXPRESS_SHIPPING, FREE_SHIPPING_OVER, STANDARD_SHIPPING } from './lib/pricing.ts'
import { PRIVACY_VERSION, TERMS_VERSION } from './config.ts'
import { errorHandler, limits, notFoundHandler, originGuard } from './middleware/index.ts'
import { router as accountRouter } from './routes/account.ts'
import { router as adminRouter } from './routes/admin.ts'
import { router as authRouter } from './routes/auth.ts'
import { router as catalogRouter } from './routes/catalog.ts'
import { router as engageRouter } from './routes/engage.ts'
import { router as ordersRouter } from './routes/orders.ts'
import { router as paymentsRouter } from './routes/payments.ts'
import { logger } from './logger.ts'

export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', config.TRUST_PROXY)
  app.set('etag', false)

  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID()
      res.setHeader('X-Request-Id', id)
      void req
      return id
    },
    autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    serializers: { req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }), res: (r) => ({ statusCode: r.statusCode }) },
  }))

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:', ...(config.R2_PUBLIC_URL ? [new URL(config.R2_PUBLIC_URL).origin] : [])],
        'connect-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        ...(isProd ? { 'upgrade-insecure-requests': [] } : {}),
      },
    },
    strictTransportSecurity: isProd ? { maxAge: 63_072_000, includeSubDomains: true, preload: true } : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  }))
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    next()
  })
  app.use(compression())

  // Health probes (no auth, no secrets).
  app.get('/healthz', (_req, res) => void res.json({ status: 'ok' }))
  app.get('/readyz', async (_req, res) => {
    try { await (await getDb()).query('SELECT 1'); res.json({ status: 'ready' }) } catch { res.status(503).json({ status: 'unavailable' }) }
  })

  const api = express.Router()
  api.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Requested-With', 'X-Order-Token'],
    maxAge: 600,
  }))
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  api.use(express.json({ limit: '100kb', strict: true }))
  api.use(cookieParser())
  api.use(originGuard)
  api.use(limits.global)

  api.get('/meta', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.json({ currency: 'KES', freeShippingOver: FREE_SHIPPING_OVER, standardShipping: STANDARD_SHIPPING, expressShipping: EXPRESS_SHIPPING, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION })
  })
  api.use('/auth', authRouter)
  api.use('/account', accountRouter)
  api.use('/orders', ordersRouter)
  api.use('/payments', paymentsRouter)
  api.use('/admin', adminRouter)
  api.use('/', catalogRouter)
  api.use('/', engageRouter)
  api.use(notFoundHandler)
  app.use('/api', api)

  // Optionally serve the built storefront (single-container deployment).
  const dist = resolve(config.CLIENT_DIST)
  if (config.SERVE_CLIENT && existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (/[\\/]assets[\\/]/.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') } }))
    app.get(/^(?!\/api\/).*/, (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(resolve(dist, 'index.html')) })
  }

  app.use(errorHandler)
  return app
}

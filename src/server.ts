import { createApp } from './app.ts'
import { config, isProd } from './config.ts'
import { closeDb, getDb } from './db/index.ts'
import { migrate } from './db/migrate.ts'
import { seed } from './db/seed.ts'
import { expirePendingOrders } from './lib/orders.ts'
import { verifyMailTransport } from './lib/mailer.ts'
import { purgeOldData } from './lib/retention.ts'
import { logger } from './logger.ts'

async function main() {
  await migrate()
  if (!isProd) {
    // Convenience for local development: load the demo catalogue into an empty database.
    const n = (await (await getDb()).query<{ n: number }>('SELECT count(*) AS n FROM products')).rows[0].n
    if (n === 0) { await seed(); logger.info('demo catalogue seeded') }
  }
  verifyMailTransport().then((ok) => (ok ? logger.info('Brevo email API verified') : logger.warn('Brevo not configured — emails are logged, not sent'))).catch((err) => logger.error({ err: err.message }, 'Brevo verification FAILED — check BREVO_API_KEY'))
  const app = createApp()
  const server = app.listen(config.PORT, () => logger.info({ port: config.PORT, env: config.NODE_ENV }, 'TAWA server listening'))
  server.requestTimeout = 30_000
  server.headersTimeout = 20_000
  server.keepAliveTimeout = 65_000

  const sweep = setInterval(() => { expirePendingOrders().then((n) => n && logger.info({ n }, 'expired unpaid orders')).catch((err) => logger.error({ err }, 'expiry sweep failed')) }, 5 * 60_000)
  sweep.unref()
  const purge = setInterval(() => { purgeOldData().catch((err) => logger.error({ err }, 'retention purge failed')) }, 24 * 3600_000)
  purge.unref()
  purgeOldData().catch((err) => logger.error({ err }, 'retention purge failed'))

  let closing = false
  const shutdown = (signal: string) => {
    if (closing) return
    closing = true
    logger.info({ signal }, 'shutting down')
    clearInterval(sweep)
    clearInterval(purge)
    server.close(async () => { await closeDb().catch(() => {}); process.exit(0) })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'))
  process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaught exception'); process.exit(1) })
}

main().catch((err) => { logger.fatal({ err }, 'failed to start'); process.exit(1) })

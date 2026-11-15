/** Sends a test email through the Brevo API:  npm run mail:test -- you@example.com */
import { config } from '../config.ts'
import { sendMail, verifyMailTransport, outbox } from '../lib/mailer.ts'

const to = process.argv[2]
if (!to) { console.error('Usage: npm run mail:test -- <recipient email>'); process.exit(1) }
try {
  if (!(await verifyMailTransport())) { console.error('Brevo not configured (set BREVO_API_KEY and SENDER_EMAIL in .env).'); process.exit(1) }
  console.log('Brevo API key OK.')
} catch (e) { console.error('Brevo check failed:', (e as Error).message); process.exit(1) }
await sendMail({ to, subject: 'TAWA test email', text: 'If you can read this, TAWA email delivery works.', html: '<p>If you can read this, <b>TAWA</b> email delivery works.</p>' })
console.log(outbox.length ? 'Send failed (see log above).' : `Sent from ${config.SENDER_NAME} <${config.SENDER_EMAIL}> to ${to}. Check the inbox (and spam).`)

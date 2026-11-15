# TAWA server

Express 5 + TypeScript + PostgreSQL. Config is validated at boot (`src/config.ts`); invalid or insecure production
settings abort startup.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | API with reload (embedded Postgres when `DATABASE_URL` is empty; seeds demo data) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run migrate` | Apply SQL migrations in `src/db/migrations` (also runs automatically at boot) |
| `npm run seed` | Load the demo catalogue + promo codes (idempotent) |
| `npm run admin:create -- <email> ["Name"] [--reset-mfa]` | Create/reset an admin |
| `npm test` · `npm run typecheck` · `npm run audit` | Quality gates (also run in CI) |

## Security model

**Passwords** — scrypt (N=2¹⁵, r=8, p=1, per-user salt), 10–128 chars, common-password / repeated-char / contains-email checks.
Unknown users cost the same hashing time as real ones (no timing oracle).

**Sessions** — 15-minute JWT access token (HS256, `iss`/`aud`/purpose-checked) held **in memory** by the client, plus a
rotating refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie (`__Host-` prefixed in production). Refresh tokens are
stored only as SHA-256 hashes; each use rotates the token and **re-use of an old token revokes the whole family**.
Password reset / change / MFA enrolment revoke other sessions. The user row is re-checked on every request, so disabling an
account takes effect immediately.

**Brute force** — per-IP rate limits (login 10/15 min, auth endpoints 20/15 min, writes 20/h, lookups 15/15 min, global 300/min)
and per-account lockout (5 failures → 15 min) that also applies to the MFA step. Generic error messages everywhere; registration
and password reset do not reveal whether an email exists.

**MFA** — TOTP (RFC 6238, tested against the RFC vector), secrets encrypted at rest with AES-256-GCM, replay protection
(a time-step can't be reused), hashed one-time recovery codes. **Mandatory for admins** (`ADMIN_REQUIRE_MFA`); the admin API
returns `mfa_required` until enrolled, and admins cannot disable it. To non-admins the admin API looks like it doesn't exist (404).

**CSRF / origin** — bearer tokens are not auto-sent by browsers; cookie endpoints (`/auth/refresh`, `/auth/logout`) additionally
require `X-Requested-With`, and every unsafe request with a foreign `Origin` is rejected. CORS is an explicit allow-list.

**Input & output** — every body/query/param is validated with Zod (unknown fields stripped, UUID/slug/enum constrained);
all SQL is parameterised; JSON bodies capped at 100 KB; uploads ≤2 MB, **type-sniffed from magic bytes** (PNG/JPEG/WebP only),
stored under random names outside the web root and served only to admins with `nosniff` + a locked-down CSP. CSV exports
neutralise spreadsheet-formula injection. Emails HTML-escape all user content.

**Money** — the browser never sends prices. Carts are re-priced from the database inside a transaction that locks product rows,
decrements stock atomically, and consumes promo codes atomically. Order lookups need ownership (account) or a signed order
token; guest tracking needs order number **and** email and returns one generic failure.

**M-Pesa** — the callback URL contains a secret path segment (constant-time compared); a "success" callback is only trusted after
the amount matches our record **and** Safaricom's STK-query API confirms it. Payment finalisation is idempotent; late payments on
auto-cancelled orders alert the owner. Unpaid orders expire after 30 minutes and return stock.

**Transport & headers** — Helmet with a strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), HSTS (prod),
`nosniff`, no `X-Powered-By`, `Cache-Control: no-store` on API responses, `Permissions-Policy` locking down device APIs.

**Audit & privacy** — append-only `audit_log` for sign-ins, lockouts, MFA events, token-reuse detection, orders, payments and every
admin mutation (visible in the dashboard). Logs redact credentials. `src/lib/retention.ts` purges data per the Privacy Policy;
account deletion anonymises the profile and detaches orders (kept 7 years for accounting).

**Operations** — non-root, read-only container with dropped capabilities, `/healthz` + `/readyz`, graceful shutdown, structured
JSON logs with request IDs, CI runs typecheck, tests, build and `npm audit`.

### Known limits / next steps

- Rate-limit counters are in process memory. With **more than one instance**, use a shared store (e.g. `rate-limit-redis`).
- Card payments are not implemented (M-Pesa + pay on delivery only). Add a PSP such as Pesapal/Flutterwave/Stripe when needed.
- Refunds are recorded manually in the dashboard (no automatic M-Pesa reversal).
- Product images are generated illustrations; add an image upload/CDN flow when you have photography.
- Put the site behind a WAF/CDN (e.g. Cloudflare) for volumetric DDoS protection — app-level limits cannot stop that.

## API reference (prefix `/api`)

**Public** `GET /products` · `GET /products/:slug` · `GET /meta` · `POST /orders/quote` · `POST /orders` · `GET /orders/track` ·
`GET /orders/:id` + `POST /orders/:id/cancel` (owner or `X-Order-Token`) · `POST /payments/mpesa/stk` · `GET /payments/status/:orderId` ·
`POST /payments/mpesa/callback/:secret` · `POST /contact` · `POST /custom-requests` (multipart) · `POST /newsletter` · `POST /newsletter/unsubscribe`

**Auth** `POST /auth/register|verify-email|resend-verification|login|mfa/login|refresh|logout|logout-all|forgot-password|reset-password|change-password`
· `GET /auth/me` · `POST /auth/mfa/setup|enable|disable`

**Account** (signed in) `PATCH /account/profile` · `GET|POST|PUT|DELETE /account/addresses` · `GET /account/orders` · `GET /account/export` ·
`POST /account/delete` · `GET|PUT|DELETE /wishlist` · `POST /products/:id/reviews`

**Admin** (admin + MFA) `GET /admin/stats|orders|products|messages|custom-requests|subscribers|subscribers.csv|promo-codes|reviews|users|audit` and the
matching `POST/PUT/PATCH/DELETE` mutations.

Errors are always `{ "error": { "code", "message", "details?", "requestId" } }`.

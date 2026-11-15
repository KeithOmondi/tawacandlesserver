import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { config } from '../config.ts'
import { badRequest } from './errors.ts'
import { sniff } from './uploads.ts'

export const r2Enabled = () => !!(config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET && config.R2_PUBLIC_URL)

let client: S3Client | null = null
const s3 = () => (client ??= new S3Client({
  region: 'auto',
  endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
}))

const base = () => config.R2_PUBLIC_URL.replace(/\/+$/, '')

/** Validates the real image type (magic bytes), uploads to R2 and returns the public URL. */
export async function uploadProductImage(buf: Buffer): Promise<string> {
  if (!r2Enabled()) throw badRequest('Image storage is not configured on the server.')
  const t = sniff(buf)
  if (!t) throw badRequest('Only PNG, JPEG or WebP images are allowed.')
  const key = `products/${randomUUID()}.${t.ext}`
  await s3().send(new PutObjectCommand({ Bucket: config.R2_BUCKET, Key: key, Body: buf, ContentType: t.mime, CacheControl: 'public, max-age=31536000, immutable' }))
  return `${base()}/${key}`
}

/** Best-effort removal of a previously uploaded image. Ignores URLs that aren't ours. */
export async function deleteProductImage(url: string | null | undefined): Promise<void> {
  if (!url || !r2Enabled() || !url.startsWith(`${base()}/products/`)) return
  try { await s3().send(new DeleteObjectCommand({ Bucket: config.R2_BUCKET, Key: url.slice(base().length + 1) })) } catch { /* orphaned object is harmless */ }
}

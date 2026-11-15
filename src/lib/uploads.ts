import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { config } from '../config.ts'
import { badRequest } from './errors.ts'

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
const root = resolve(config.UPLOAD_DIR)

/** Detects the real image type from magic bytes — never trusts the client-provided mimetype/extension. */
export function sniff(b: Buffer): { ext: string; mime: string } | null {
  if (b.length > 12 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return { ext: 'png', mime: 'image/png' }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' }
  return null
}

export async function saveImage(buf: Buffer): Promise<string> {
  const t = sniff(buf)
  if (!t) throw badRequest('Only PNG, JPEG or WebP images are allowed.')
  await mkdir(root, { recursive: true })
  const name = `${randomUUID()}.${t.ext}`
  await writeFile(join(root, name), buf, { mode: 0o640 })
  return name
}

/** Resolves a stored filename to an absolute path, refusing anything outside the upload directory. */
export function uploadPath(name: string): string | null {
  const safe = basename(name)
  if (safe !== name || !/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(safe)) return null
  return join(root, safe)
}

export const mimeFor = (name: string) => (name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg')

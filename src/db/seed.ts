import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb, getDb } from './index.ts'
import { migrate } from './migrate.ts'

interface SeedProduct {
  slug: string; name: string; tagline: string; category: string; vessel: string; wax: string; accent: string
  scentFamily: string; notes: object; description: string; badge: string | null; compareAt: number | null
  stock: number; featured: boolean; sort: number
  sizes: { code: string; label: string; weight: string; burn: string; price: number }[]
  reviews: { name: string; rating: number; title: string; body: string; date: string }[]
}

/** Loads the demo catalogue and promo codes. Safe to run repeatedly (skips existing slugs/codes). */
export async function seed() {
  await migrate()
  const db = await getDb()
  const data: SeedProduct[] = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'seed-data.json'), 'utf8'))
  let added = 0
  for (const p of data) {
    const res = await db.query<{ id: string }>(
      `INSERT INTO products (slug,name,tagline,category,vessel,wax,accent,scent_family,notes,description,badge,compare_at,stock,featured,sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (slug) DO NOTHING RETURNING id`,
      [p.slug, p.name, p.tagline, p.category, p.vessel, p.wax, p.accent, p.scentFamily, JSON.stringify(p.notes), p.description, p.badge, p.compareAt, p.stock, p.featured, p.sort],
    )
    const id = res.rows[0]?.id
    if (!id) continue
    added++
    for (const s of p.sizes) {
      await db.query('INSERT INTO product_sizes (product_id,code,label,weight,burn,price) VALUES ($1,$2,$3,$4,$5,$6)', [id, s.code, s.label, s.weight, s.burn, s.price])
    }
    for (const r of p.reviews) {
      await db.query(`INSERT INTO reviews (product_id,name,rating,title,body,status,created_at) VALUES ($1,$2,$3,$4,$5,'published',$6)`, [id, r.name, r.rating, r.title, r.body, r.date])
    }
  }
  const promos: [string, string, number, number, string][] = [
    ['TAWA10', 'percent', 10, 0, '10% off'],
    ['WELCOME15', 'percent', 15, 0, '15% off your first order'],
    ['GLOW500', 'fixed', 500, 3000, 'KSh 500 off orders over KSh 3,000'],
  ]
  for (const [code, type, value, min, label] of promos) {
    await db.query('INSERT INTO promo_codes (code,type,value,min_subtotal,label) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [code, type, value, min, label])
  }
  return { products: added }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed()
    .then((r) => { console.log(`Seeded ${r.products} products.`); return closeDb() })
    .catch((e) => { console.error(e); process.exit(1) })
}

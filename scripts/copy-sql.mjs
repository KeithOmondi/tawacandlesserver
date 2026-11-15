import { cpSync } from 'node:fs'
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true })
cpSync('src/db/seed-data.json', 'dist/db/seed-data.json')

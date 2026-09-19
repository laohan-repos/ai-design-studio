import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { ModelConfig } from '../src/types'

export type StoredArtwork = {
  id: string
  src: string
  prompt: string
  createdAt: number
  x: number
  y: number
  width: number
}

export class StudioDatabase {
  private writeQueue: Promise<void> = Promise.resolve()
  private constructor(private db: Database, private filePath: string) {}

  static async open(filePath: string) {
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => wasmPath })
    let bytes: Uint8Array | undefined
    try { bytes = await readFile(filePath) } catch { /* first launch */ }
    const db = bytes ? new SQL.Database(bytes) : new SQL.Database()
    db.run(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'text-to-image',
        base_url TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL,
        supports_image INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artworks (
        id TEXT PRIMARY KEY,
        mime_type TEXT NOT NULL,
        image_data BLOB NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        canvas_x REAL NOT NULL DEFAULT 0,
        canvas_y REAL NOT NULL DEFAULT 0,
        canvas_width REAL NOT NULL DEFAULT 320
      );
      CREATE INDEX IF NOT EXISTS idx_artworks_created_at ON artworks(created_at DESC);
    `)
    const modelColumns = db.exec('PRAGMA table_info(models)')[0]?.values.map(row => String(row[1])) || []
    if (!modelColumns.includes('task_type')) db.run("ALTER TABLE models ADD COLUMN task_type TEXT NOT NULL DEFAULT 'text-to-image'")
    const store = new StudioDatabase(db, filePath)
    await store.persist()
    return store
  }

  listModels(): ModelConfig[] {
    const statement = this.db.prepare('SELECT * FROM models ORDER BY sort_order, created_at')
    const rows: ModelConfig[] = []
    while (statement.step()) {
      const row = statement.getAsObject()
      rows.push({ id: String(row.id), name: String(row.name), provider: row.provider as ModelConfig['provider'], taskType: (row.task_type || 'text-to-image') as ModelConfig['taskType'], baseUrl: String(row.base_url), apiKey: String(row.api_key), model: String(row.model) })
    }
    statement.free()
    return rows
  }

  async saveModels(models: ModelConfig[]) {
    this.db.run('BEGIN')
    try {
      this.db.run('DELETE FROM models')
      const statement = this.db.prepare('INSERT INTO models (id, name, provider, task_type, base_url, api_key, model, supports_image, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      models.forEach((item, index) => statement.run([item.id, item.name, item.provider, item.taskType, item.baseUrl, item.apiKey, item.model, item.taskType === 'image-to-image' ? 1 : 0, index, Date.now()]))
      statement.free(); this.db.run('COMMIT')
    } catch (error) { this.db.run('ROLLBACK'); throw error }
    await this.persist()
  }

  listArtworks(): StoredArtwork[] {
    const statement = this.db.prepare('SELECT * FROM artworks ORDER BY created_at DESC')
    const rows: StoredArtwork[] = []
    while (statement.step()) {
      const row = statement.getAsObject()
      const bytes = row.image_data as Uint8Array
      rows.push({ id: String(row.id), src: `data:${String(row.mime_type)};base64,${Buffer.from(bytes).toString('base64')}`, prompt: String(row.prompt), createdAt: Number(row.created_at), x: Number(row.canvas_x), y: Number(row.canvas_y), width: Number(row.canvas_width) })
    }
    statement.free()
    return rows
  }

  async saveArtworks(items: StoredArtwork[]) {
    this.db.run('BEGIN')
    try {
      const statement = this.db.prepare('INSERT OR REPLACE INTO artworks (id, mime_type, image_data, prompt, created_at, canvas_x, canvas_y, canvas_width) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const item of items) {
        const match = item.src.match(/^data:(.*?);base64,(.*)$/)
        if (!match) throw new Error('仅支持保存 data URL 图片')
        statement.run([item.id, match[1], Buffer.from(match[2], 'base64'), item.prompt, item.createdAt, item.x, item.y, item.width])
      }
      statement.free(); this.db.run('COMMIT')
    } catch (error) { this.db.run('ROLLBACK'); throw error }
    await this.persist()
  }

  async moveArtwork(id: string, x: number, y: number) {
    this.db.run('UPDATE artworks SET canvas_x = ?, canvas_y = ? WHERE id = ?', [x, y, id])
    await this.persist()
  }

  private async persist() {
    const data = Buffer.from(this.db.export())
    const temporaryPath = `${this.filePath}.tmp`
    this.writeQueue = this.writeQueue.then(async () => {
      await writeFile(temporaryPath, data)
      await rename(temporaryPath, this.filePath)
    })
    await this.writeQueue
  }
}

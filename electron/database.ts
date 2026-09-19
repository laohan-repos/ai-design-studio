import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { ModelConfig } from '../src/types'

export type StoredArtwork = {
  id: string
  canvasId: string
  src: string
  prompt: string
  createdAt: number
  x: number
  y: number
  width: number
}

export type StoredArtworkVersion = {
  id: string
  artworkId: string
  src: string
  prompt: string
  createdAt: number
  versionNumber: number
  isCurrent: boolean
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
      CREATE TABLE IF NOT EXISTS canvases (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
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
        canvas_id TEXT NOT NULL DEFAULT 'default-canvas',
        mime_type TEXT NOT NULL,
        image_data BLOB NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        canvas_x REAL NOT NULL DEFAULT 0,
        canvas_y REAL NOT NULL DEFAULT 0,
        canvas_width REAL NOT NULL DEFAULT 320,
        current_version_id TEXT
      );
      CREATE TABLE IF NOT EXISTS artwork_versions (
        id TEXT PRIMARY KEY,
        artwork_id TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        image_data BLOB NOT NULL,
        prompt TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        version_number INTEGER NOT NULL,
        FOREIGN KEY (artwork_id) REFERENCES artworks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artworks_created_at ON artworks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artwork_versions ON artwork_versions(artwork_id, version_number DESC);
    `)
    const modelColumns = db.exec('PRAGMA table_info(models)')[0]?.values.map(row => String(row[1])) || []
    if (!modelColumns.includes('task_type')) db.run("ALTER TABLE models ADD COLUMN task_type TEXT NOT NULL DEFAULT 'text-to-image'")
    const artworkColumns = db.exec('PRAGMA table_info(artworks)')[0]?.values.map(row => String(row[1])) || []
    if (!artworkColumns.includes('canvas_id')) db.run("ALTER TABLE artworks ADD COLUMN canvas_id TEXT NOT NULL DEFAULT 'default-canvas'")
    if (!artworkColumns.includes('current_version_id')) db.run('ALTER TABLE artworks ADD COLUMN current_version_id TEXT')
    db.run(`
      INSERT OR IGNORE INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number)
      SELECT 'original-' || id, id, mime_type, image_data, prompt, created_at, 1 FROM artworks;
      UPDATE artworks SET current_version_id = 'original-' || id WHERE current_version_id IS NULL;
    `)
    const canvasCount = Number(db.exec('SELECT COUNT(*) FROM canvases')[0]?.values[0]?.[0] || 0)
    if (!canvasCount) {
      const now = Date.now()
      db.run('INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['default-canvas', '我的第一个画布', now, now])
    }
    const store = new StudioDatabase(db, filePath)
    await store.persist()
    return store
  }

  listCanvases() {
    const statement = this.db.prepare(`
      SELECT canvases.*, COUNT(artworks.id) AS artwork_count,
        (SELECT first_artwork.id FROM artworks AS first_artwork WHERE first_artwork.canvas_id = canvases.id ORDER BY first_artwork.created_at ASC LIMIT 1) AS cover_id
      FROM canvases LEFT JOIN artworks ON artworks.canvas_id = canvases.id
      GROUP BY canvases.id ORDER BY canvases.updated_at DESC
    `)
    const rows: Array<{ id: string; name: string; createdAt: number; updatedAt: number; artworkCount: number; coverSrc?: string }> = []
    while (statement.step()) {
      const row = statement.getAsObject()
      let coverSrc: string | undefined
      if (row.cover_id) {
        const cover = this.db.prepare('SELECT mime_type, image_data FROM artworks WHERE id = ?')
        cover.bind([String(row.cover_id)])
        if (cover.step()) {
          const data = cover.getAsObject()
          coverSrc = `data:${String(data.mime_type)};base64,${Buffer.from(data.image_data as Uint8Array).toString('base64')}`
        }
        cover.free()
      }
      rows.push({ id: String(row.id), name: String(row.name), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), artworkCount: Number(row.artwork_count), coverSrc })
    }
    statement.free()
    return rows
  }

  async createCanvas(id: string, name: string) {
    const now = Date.now()
    this.db.run('INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, name, now, now])
    await this.persist()
    return { id, name, createdAt: now, updatedAt: now, artworkCount: 0 }
  }

  async renameCanvas(id: string, name: string) {
    const updatedAt = Date.now()
    this.db.run('UPDATE canvases SET name = ?, updated_at = ? WHERE id = ?', [name, updatedAt, id])
    await this.persist()
    return updatedAt
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

  listArtworks(canvasId: string): StoredArtwork[] {
    const statement = this.db.prepare('SELECT * FROM artworks WHERE canvas_id = ? ORDER BY created_at DESC')
    statement.bind([canvasId])
    const rows: StoredArtwork[] = []
    while (statement.step()) {
      const row = statement.getAsObject()
      const bytes = row.image_data as Uint8Array
      rows.push({ id: String(row.id), canvasId: String(row.canvas_id), src: `data:${String(row.mime_type)};base64,${Buffer.from(bytes).toString('base64')}`, prompt: String(row.prompt), createdAt: Number(row.created_at), x: Number(row.canvas_x), y: Number(row.canvas_y), width: Number(row.canvas_width) })
    }
    statement.free()
    return rows
  }

  listArtworkVersions(artworkId: string): StoredArtworkVersion[] {
    const statement = this.db.prepare(`
      SELECT versions.*, artworks.current_version_id
      FROM artwork_versions AS versions
      JOIN artworks ON artworks.id = versions.artwork_id
      WHERE versions.artwork_id = ? ORDER BY versions.version_number DESC
    `)
    statement.bind([artworkId])
    const rows: StoredArtworkVersion[] = []
    while (statement.step()) {
      const row = statement.getAsObject()
      const bytes = row.image_data as Uint8Array
      rows.push({ id: String(row.id), artworkId: String(row.artwork_id), src: `data:${String(row.mime_type)};base64,${Buffer.from(bytes).toString('base64')}`, prompt: String(row.prompt), createdAt: Number(row.created_at), versionNumber: Number(row.version_number), isCurrent: String(row.current_version_id) === String(row.id) })
    }
    statement.free()
    return rows
  }

  async saveArtworkVersion(item: Omit<StoredArtworkVersion, 'isCurrent'>) {
    const match = item.src.match(/^data:(.*?);base64,(.*)$/)
    if (!match) throw new Error('仅支持保存 data URL 图片')
    this.db.run('INSERT INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.artworkId, match[1], Buffer.from(match[2], 'base64'), item.prompt, item.createdAt, item.versionNumber])
    await this.persist()
  }

  async applyArtworkVersion(artworkId: string, versionId: string) {
    this.db.run(`
      UPDATE artworks SET
        mime_type = (SELECT mime_type FROM artwork_versions WHERE id = ?),
        image_data = (SELECT image_data FROM artwork_versions WHERE id = ?),
        prompt = (SELECT prompt FROM artwork_versions WHERE id = ?),
        current_version_id = ?
      WHERE id = ?
    `, [versionId, versionId, versionId, versionId, artworkId])
    await this.persist()
    return this.listArtworkVersions(artworkId).find(version => version.id === versionId)
  }

  async saveArtworks(items: StoredArtwork[]) {
    this.db.run('BEGIN')
    try {
      const statement = this.db.prepare('INSERT OR REPLACE INTO artworks (id, canvas_id, mime_type, image_data, prompt, created_at, canvas_x, canvas_y, canvas_width, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      for (const item of items) {
        const match = item.src.match(/^data:(.*?);base64,(.*)$/)
        if (!match) throw new Error('仅支持保存 data URL 图片')
        statement.run([item.id, item.canvasId, match[1], Buffer.from(match[2], 'base64'), item.prompt, item.createdAt, item.x, item.y, item.width, `original-${item.id}`])
        this.db.run('INSERT OR IGNORE INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number) VALUES (?, ?, ?, ?, ?, ?, 1)', [`original-${item.id}`, item.id, match[1], Buffer.from(match[2], 'base64'), item.prompt, item.createdAt])
      }
      statement.free(); this.db.run('COMMIT')
    } catch (error) { this.db.run('ROLLBACK'); throw error }
    if (items.length) this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [Date.now(), items[0].canvasId])
    await this.persist()
  }

  async moveArtwork(id: string, x: number, y: number) {
    this.db.run('UPDATE artworks SET canvas_x = ?, canvas_y = ? WHERE id = ?', [x, y, id])
    this.db.run('UPDATE canvases SET updated_at = ? WHERE id = (SELECT canvas_id FROM artworks WHERE id = ?)', [Date.now(), id])
    await this.persist()
  }

  async deleteArtwork(id: string) {
    const statement = this.db.prepare('SELECT canvas_id FROM artworks WHERE id = ?')
    statement.bind([id])
    const canvasId = statement.step() ? statement.get()[0] : undefined
    statement.free()
    this.db.run('DELETE FROM artworks WHERE id = ?', [id])
    if (canvasId) this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [Date.now(), String(canvasId)])
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

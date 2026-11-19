import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { ModelConfig } from '../src/types'
import type { PosterContent } from '../src/lib/poster'

export type StoredPoster = {
  artworkId: string
  sourceVersionId: string
  revision: number
  content: PosterContent
  history: PosterContent[]
}

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
  private constructor(private db: Database, private filePath: string, private SQL: SqlJsStatic) {}

  static async open(filePath: string) {
    const require = createRequire(import.meta.url)
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
    const SQL: SqlJsStatic = await initSqlJs({ locateFile: () => wasmPath })
    let bytes: Uint8Array | undefined
    try { bytes = await readFile(filePath) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const db = bytes ? new SQL.Database(bytes) : new SQL.Database()
    const hadCanvasTable = Boolean(db.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'canvases'").length)
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
        proxy_enabled INTEGER NOT NULL DEFAULT 0,
        proxy_url TEXT NOT NULL DEFAULT '',
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
      CREATE TABLE IF NOT EXISTS posters (
        artwork_id TEXT PRIMARY KEY,
        source_version_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        history_json TEXT NOT NULL,
        FOREIGN KEY (artwork_id) REFERENCES artworks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_artworks_created_at ON artworks(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artwork_versions ON artwork_versions(artwork_id, version_number DESC);
    `)
    const modelColumns = db.exec('PRAGMA table_info(models)')[0]?.values.map(row => String(row[1])) || []
    if (!modelColumns.includes('task_type')) db.run("ALTER TABLE models ADD COLUMN task_type TEXT NOT NULL DEFAULT 'text-to-image'")
    if (!modelColumns.includes('proxy_enabled')) db.run('ALTER TABLE models ADD COLUMN proxy_enabled INTEGER NOT NULL DEFAULT 0')
    if (!modelColumns.includes('proxy_url')) db.run("ALTER TABLE models ADD COLUMN proxy_url TEXT NOT NULL DEFAULT ''")
    const artworkColumns = db.exec('PRAGMA table_info(artworks)')[0]?.values.map(row => String(row[1])) || []
    if (!artworkColumns.includes('canvas_id')) db.run("ALTER TABLE artworks ADD COLUMN canvas_id TEXT NOT NULL DEFAULT 'default-canvas'")
    if (!artworkColumns.includes('current_version_id')) db.run('ALTER TABLE artworks ADD COLUMN current_version_id TEXT')
    db.run(`
      INSERT OR IGNORE INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number)
      SELECT 'original-' || id, id, mime_type, image_data, prompt, created_at, 1 FROM artworks;
      UPDATE artworks SET current_version_id = 'original-' || id WHERE current_version_id IS NULL;
    `)
    if (!hadCanvasTable) {
      const now = Date.now()
      db.run('INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['default-canvas', '我的第一个画布', now, now])
    }
    const store = new StudioDatabase(db, filePath, SQL)
    await store.persist()
    return store
  }

  listCanvases(includeCovers = true) {
    const statement = this.db.prepare(`
      SELECT canvases.*, COUNT(artworks.id) AS artwork_count,
        (SELECT first_artwork.id FROM artworks AS first_artwork WHERE first_artwork.canvas_id = canvases.id ORDER BY first_artwork.created_at, first_artwork.id LIMIT 1) AS cover_id
      FROM canvases LEFT JOIN artworks ON artworks.canvas_id = canvases.id
      GROUP BY canvases.id ORDER BY canvases.updated_at DESC
    `)
    const rows: Array<{ id: string; name: string; createdAt: number; updatedAt: number; artworkCount: number; coverSrc?: string }> = []
    while (statement.step()) {
      const row = statement.getAsObject()
      const coverSrc = includeCovers && row.cover_id ? this.getCoverSource(String(row.cover_id)) : undefined
      rows.push({ id: String(row.id), name: String(row.name), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), artworkCount: Number(row.artwork_count), coverSrc })
    }
    statement.free()
    return rows
  }

  private getCoverSource(artworkId: string) {
    const row = this.db.exec('SELECT mime_type, image_data FROM artworks WHERE id = ?', [artworkId])[0]?.values[0]
    if (!row) return undefined
    return `data:${String(row[0])};base64,${Buffer.from(row[1] as Uint8Array).toString('base64')}`
  }

  getCanvasArtworkCount(id: string): number | undefined {
    const result = this.db.exec(`
      SELECT COUNT(artworks.id) FROM canvases LEFT JOIN artworks ON artworks.canvas_id = canvases.id
      WHERE canvases.id = ? GROUP BY canvases.id
    `, [id])
    const count = result[0]?.values[0]?.[0]
    return typeof count === 'number' ? count : undefined
  }

  createCanvas(id: string, name: string) {
    return this.write(() => {
      const now = Date.now()
      this.db.run('INSERT INTO canvases (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, name, now, now])
      return { id, name, createdAt: now, updatedAt: now, artworkCount: 0 }
    })
  }

  renameCanvas(id: string, name: string) {
    return this.write(() => {
      const updatedAt = Date.now()
      this.db.run('UPDATE canvases SET name = ?, updated_at = ? WHERE id = ?', [name, updatedAt, id])
      if (!this.db.getRowsModified()) throw new Error('画布不存在')
      return updatedAt
    })
  }

  deleteCanvas(id: string) {
    return this.write(() => {
      const artworkCount = this.getCanvasArtworkCount(id)
      if (artworkCount === undefined) throw new Error('画布不存在')
      this.deleteArtworkRows('canvas_id', id)
      this.db.run('DELETE FROM canvases WHERE id = ?', [id])
      const nextCanvasId = this.db.exec('SELECT id FROM canvases ORDER BY updated_at DESC, id LIMIT 1')[0]?.values[0]?.[0]
      return { canvasId: id, artworkCount, nextCanvasId: typeof nextCanvasId === 'string' ? nextCanvasId : undefined }
    })
  }

  listModels(): ModelConfig[] {
    const statement = this.db.prepare('SELECT * FROM models ORDER BY sort_order, created_at')
    const rows: ModelConfig[] = []
    while (statement.step()) {
      const row = statement.getAsObject()
      rows.push({ id: String(row.id), name: String(row.name), provider: row.provider as ModelConfig['provider'], taskType: (row.task_type || 'text-to-image') as ModelConfig['taskType'], baseUrl: String(row.base_url), apiKey: String(row.api_key), model: String(row.model), proxyEnabled: Boolean(row.proxy_enabled), proxyUrl: String(row.proxy_url || '') })
    }
    statement.free()
    return rows
  }

  saveModels(models: ModelConfig[]) {
    return this.write(() => {
      this.db.run('DELETE FROM models')
      const statement = this.db.prepare('INSERT INTO models (id, name, provider, task_type, base_url, api_key, model, proxy_enabled, proxy_url, supports_image, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      try {
        models.forEach((item, index) => statement.run([item.id, item.name, item.provider, item.taskType, item.baseUrl, item.apiKey, item.model, item.proxyEnabled ? 1 : 0, item.proxyUrl || '', item.taskType === 'image-to-image' ? 1 : 0, index, Date.now()]))
      } finally { statement.free() }
    })
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

  listArtworkMetadata(canvasId: string, limit: number, offset: number) {
    const statement = this.db.prepare(`
      SELECT id, prompt, created_at, canvas_x, canvas_y, canvas_width
      FROM artworks WHERE canvas_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?
    `)
    const rows: Array<Omit<StoredArtwork, 'src'>> = []
    try {
      statement.bind([canvasId, limit, offset])
      while (statement.step()) {
        const row = statement.getAsObject()
        rows.push({ id: String(row.id), canvasId, prompt: String(row.prompt), createdAt: Number(row.created_at), x: Number(row.canvas_x), y: Number(row.canvas_y), width: Number(row.canvas_width) })
      }
      return rows
    } finally { statement.free() }
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

  listArtworkVersionMetadata(artworkId: string) {
    const query = this.db.exec(`
      SELECT versions.id, versions.version_number, versions.created_at, versions.id = artworks.current_version_id
      FROM artwork_versions AS versions JOIN artworks ON artworks.id = versions.artwork_id
      WHERE versions.artwork_id = ? ORDER BY versions.version_number DESC
    `, [artworkId])
    return (query[0]?.values ?? []).map(([id, number, time, current]) => ({
      id: String(id), versionNumber: Number(number), createdAt: Number(time), isCurrent: Boolean(current)
    }))
  }

  saveArtworkVersion(item: Omit<StoredArtworkVersion, 'isCurrent' | 'versionNumber'>): Promise<StoredArtworkVersion> {
    const match = item.src.match(/^data:(.*?);base64,(.*)$/)
    if (!match) return Promise.reject(new Error('仅支持保存 data URL 图片'))
    return this.write(() => {
      this.db.run(`
        INSERT INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number)
        SELECT ?, artworks.id, ?, ?, ?, ?, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM artwork_versions WHERE artwork_id = artworks.id)
        FROM artworks WHERE artworks.id = ?
      `, [item.id, match[1], Buffer.from(match[2], 'base64'), item.prompt, item.createdAt, item.artworkId])
      if (!this.db.getRowsModified()) throw new Error('原图已不存在，无法保存版本')
      const versionNumber = Number(this.db.exec('SELECT version_number FROM artwork_versions WHERE id = ?', [item.id])[0].values[0][0])
      return { ...item, versionNumber, isCurrent: false }
    })
  }

  getArtworkSource(artworkId: string, versionId?: string) {
    const result = this.db.exec(`
      SELECT versions.id, versions.image_data, versions.mime_type, versions.prompt FROM artworks
      JOIN artwork_versions AS versions ON versions.artwork_id = artworks.id
        AND versions.id = COALESCE(?, artworks.current_version_id)
      WHERE artworks.id = ?
    `, [versionId ?? null, artworkId])
    const row = result[0]?.values[0]
    if (!row) return undefined
    return { versionId: String(row[0]), bytes: Buffer.from(row[1] as Uint8Array), mime: String(row[2]), prompt: String(row[3]) }
  }

  getPoster(artworkId: string): StoredPoster | undefined {
    const row = this.db.exec('SELECT source_version_id, revision, content_json, history_json FROM posters WHERE artwork_id = ?', [artworkId])[0]?.values[0]
    if (!row) return undefined
    return { artworkId, sourceVersionId: String(row[0]), revision: Number(row[1]), content: JSON.parse(String(row[2])), history: JSON.parse(String(row[3])) }
  }

  savePoster(poster: StoredPoster, previousRevision: number) {
    const { artworkId, sourceVersionId, revision, content, history } = poster
    const contentJson = JSON.stringify(content)
    const historyJson = JSON.stringify(history)
    return this.write(() => {
      if (!previousRevision) {
        this.db.run(`INSERT OR IGNORE INTO posters
          SELECT id, ?, ?, ?, ? FROM artworks WHERE id = ?`, [sourceVersionId, revision, contentJson, historyJson, artworkId])
      } else {
        this.db.run('UPDATE posters SET revision = ?, content_json = ?, history_json = ? WHERE artwork_id = ? AND revision = ?', [revision, contentJson, historyJson, artworkId, previousRevision])
      }
      if (!this.db.getRowsModified()) throw new Error('海报已更新或原图已删除，请重新打开')
    })
  }

  applyArtworkVersion(artworkId: string, versionId: string) {
    return this.write(() => {
      const row = this.db.exec(`
        SELECT version.mime_type, version.image_data, version.prompt, version.created_at, version.version_number, artworks.canvas_id,
          artworks.id = (SELECT first.id FROM artworks AS first WHERE first.canvas_id = artworks.canvas_id ORDER BY first.created_at, first.id LIMIT 1)
        FROM artwork_versions AS version JOIN artworks ON artworks.id = version.artwork_id
        WHERE version.id = ? AND version.artwork_id = ?
      `, [versionId, artworkId])[0]?.values[0]
      if (!row) return undefined
      const [mime, bytes, prompt, createdAt, versionNumber, canvasId, isCover] = row
      const updatedAt = Date.now()
      this.db.run('UPDATE artworks SET mime_type = ?, image_data = ?, prompt = ?, current_version_id = ? WHERE id = ?', [mime, bytes, prompt, versionId, artworkId])
      this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [updatedAt, canvasId])
      const version: StoredArtworkVersion = {
        id: versionId, artworkId, src: `data:${String(mime)};base64,${Buffer.from(bytes as Uint8Array).toString('base64')}`,
        prompt: String(prompt), createdAt: Number(createdAt), versionNumber: Number(versionNumber), isCurrent: true
      }
      return { canvasId: String(canvasId), isCover: Boolean(isCover), updatedAt, version }
    })
  }

  saveArtworks(items: StoredArtwork[]) {
    return this.write(() => {
      const canvasIds = new Set(items.map(item => item.canvasId))
      for (const canvasId of canvasIds) {
        if (this.getCanvasArtworkCount(canvasId) === undefined) throw new Error('画布不存在，无法保存图片')
      }
      const statement = this.db.prepare('INSERT OR REPLACE INTO artworks (id, canvas_id, mime_type, image_data, prompt, created_at, canvas_x, canvas_y, canvas_width, current_version_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      try {
        for (const item of items) {
          const match = item.src.match(/^data:(.*?);base64,(.*)$/)
          if (!match) throw new Error('仅支持保存 data URL 图片')
          const bytes = Buffer.from(match[2], 'base64')
          statement.run([item.id, item.canvasId, match[1], bytes, item.prompt, item.createdAt, item.x, item.y, item.width, `original-${item.id}`])
          this.db.run('INSERT OR IGNORE INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number) VALUES (?, ?, ?, ?, ?, ?, 1)', [`original-${item.id}`, item.id, match[1], bytes, item.prompt, item.createdAt])
        }
      } finally { statement.free() }
      const updatedAt = Date.now()
      for (const canvasId of canvasIds) this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [updatedAt, canvasId])
    })
  }

  moveArtwork(artworkId: string, x: number, y: number) {
    return this.write(() => {
      const canvasId = this.requireArtworkCanvas(artworkId)
      const updatedAt = Date.now()
      this.db.run('UPDATE artworks SET canvas_x = ?, canvas_y = ? WHERE id = ?', [x, y, artworkId])
      this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [updatedAt, canvasId])
      return { artworkId, canvasId, x, y, updatedAt }
    })
  }

  deleteArtwork(artworkId: string) {
    return this.write(() => {
      const canvasId = this.requireArtworkCanvas(artworkId)
      this.deleteArtworkRows('id', artworkId)
      const updatedAt = Date.now()
      this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [updatedAt, canvasId])
      const artworkCount = this.getCanvasArtworkCount(canvasId) ?? 0
      const coverId = this.db.exec('SELECT id FROM artworks WHERE canvas_id = ? ORDER BY created_at, id LIMIT 1', [canvasId])[0]?.values[0]?.[0]
      const coverSrc = typeof coverId === 'string' ? this.getCoverSource(coverId) : undefined
      return { artworkId, canvasId, artworkCount, updatedAt, coverSrc }
    })
  }

  private requireArtworkCanvas(artworkId: string) {
    const canvasId = this.db.exec('SELECT canvas_id FROM artworks WHERE id = ?', [artworkId])[0]?.values[0]?.[0]
    if (typeof canvasId !== 'string') throw new Error('图片不存在')
    return canvasId
  }

  private deleteArtworkRows(column: 'id' | 'canvas_id', value: string) {
    const matchingArtworks = `SELECT id FROM artworks WHERE ${column} = ?`
    this.db.run(`DELETE FROM posters WHERE artwork_id IN (${matchingArtworks})`, [value])
    this.db.run(`DELETE FROM artwork_versions WHERE artwork_id IN (${matchingArtworks})`, [value])
    this.db.run(`DELETE FROM artworks WHERE ${column} = ?`, [value])
  }

  private write<T>(mutate: () => T): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      this.db.run('BEGIN')
      let result: T
      try {
        result = mutate()
        this.db.run('COMMIT')
      } catch (error) {
        this.db.run('ROLLBACK')
        throw error
      }
      try { await this.persist() }
      catch (error) {
        const restored = new this.SQL.Database(await readFile(this.filePath))
        this.db.close()
        this.db = restored
        throw error
      }
      return result
    })
    this.writeQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async persist() {
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, this.db.export())
    await rename(temporaryPath, this.filePath)
  }
}

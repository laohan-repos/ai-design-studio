import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { Artwork, ModelConfig } from '../src/types'
import type { PosterContent } from '../src/lib/poster'
import type { PosterPixelTileWrite } from '../src/lib/poster-pixels'
import type { ArtworkGroupChangeInput, CanvasGrouping, CanvasGroupingChange } from '../src/lib/canvas-groups'
import type { EditorHistory, EditorHistoryEntry, EditorPhotoHistoryEdit, EditorPosterHistoryEdit } from '../src/lib/editor-history'
import { appendEditorHistory, describeEditorHistory, editorStateAt, type StoredEditorHistory } from './editor-history'

export type StoredPoster = {
  artworkId: string
  sourceVersionId: string
  revision: number
  content: PosterContent
  history: PosterContent[]
}

type LegacyPosterContent = Omit<PosterContent, 'imageLayers' | 'layerOrder'> & Partial<Pick<PosterContent, 'imageLayers' | 'layerOrder'>>

function readPosterContent({ imageLayers = [], layerOrder, ...content }: LegacyPosterContent): PosterContent {
  return {
    ...content, imageLayers,
    layerOrder: layerOrder ?? [
      'subject',
      ...content.textLayers.map(layer => `text:${layer.id}` as const),
      ...imageLayers.map(layer => `image:${layer.id}` as const)
    ]
  }
}

export type StoredArtwork = Artwork

export type StoredArtworkVersion = {
  id: string
  artworkId: string
  src: string
  prompt: string
  createdAt: number
  versionNumber: number
  isCurrent: boolean
}

export type AppliedArtworkVersion = {
  canvasId: string
  isCover: boolean
  updatedAt: number
  version: StoredArtworkVersion
}

type EditorHistoryNavigation = { history: EditorHistory; poster?: StoredPoster; applied?: AppliedArtworkVersion }

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
      CREATE TABLE IF NOT EXISTS artwork_groups (
        id TEXT PRIMARY KEY,
        canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        UNIQUE(canvas_id, name)
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
        edit_recipe_json TEXT,
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
      CREATE TABLE IF NOT EXISTS editor_histories (
        artwork_id TEXT PRIMARY KEY REFERENCES artworks(id) ON DELETE CASCADE,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS poster_pixel_tiles (
        artwork_id TEXT NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        image_data BLOB NOT NULL,
        PRIMARY KEY (artwork_id, id)
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
    if (!artworkColumns.includes('group_id')) db.run('ALTER TABLE artworks ADD COLUMN group_id TEXT REFERENCES artwork_groups(id) ON DELETE SET NULL')
    db.run('CREATE INDEX IF NOT EXISTS idx_artworks_canvas_group ON artworks(canvas_id, group_id)')
    const versionColumns = db.exec('PRAGMA table_info(artwork_versions)')[0]?.values.map(row => String(row[1])) || []
    if (!versionColumns.includes('edit_recipe_json')) db.run('ALTER TABLE artwork_versions ADD COLUMN edit_recipe_json TEXT')
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

  getCanvasArtworkCount(id: string, groupId?: string | null): number | undefined {
    const result = this.db.exec(`
      SELECT COUNT(artworks.id) FROM canvases LEFT JOIN artworks ON artworks.canvas_id = canvases.id
        ${groupId !== undefined ? 'AND artworks.group_id IS ?' : ''}
      WHERE canvases.id = ? GROUP BY canvases.id
    `, groupId === undefined ? [id] : [groupId, id])
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
      this.db.run('DELETE FROM artwork_groups WHERE canvas_id = ?', [id])
      this.db.run('DELETE FROM canvases WHERE id = ?', [id])
      const nextCanvasId = this.db.exec('SELECT id FROM canvases ORDER BY updated_at DESC, id LIMIT 1')[0]?.values[0]?.[0]
      return { canvasId: id, artworkCount, nextCanvasId: typeof nextCanvasId === 'string' ? nextCanvasId : undefined }
    })
  }

  listArtworkGroups(canvasId: string): CanvasGrouping {
    const count = this.getCanvasArtworkCount(canvasId)
    if (count === undefined) throw new Error('画布不存在')
    const query = this.db.exec(`
      SELECT artwork_groups.id, artwork_groups.name, COUNT(artworks.id)
      FROM artwork_groups LEFT JOIN artworks ON artworks.group_id = artwork_groups.id AND artworks.canvas_id = artwork_groups.canvas_id
      WHERE artwork_groups.canvas_id = ? GROUP BY artwork_groups.id
      ORDER BY artwork_groups.sort_order, artwork_groups.id
    `, [canvasId])
    const groups = (query[0]?.values ?? []).map(([id, name, artworkCount]) => ({
      id: String(id), name: String(name), artworkCount: Number(artworkCount),
    }))
    const ungroupedCount = count - groups.reduce((total, group) => total + group.artworkCount, 0)
    return { canvasId, groups, ungroupedCount }
  }

  changeArtworkGroups(input: ArtworkGroupChangeInput): Promise<CanvasGroupingChange> {
    const { canvasId } = input
    return this.write(() => {
      const { groups } = this.listArtworkGroups(canvasId)
      let groupId = 'groupId' in input ? input.groupId ?? undefined : undefined
      let assignment: CanvasGroupingChange['assignment']
      if (groupId && !groups.some(group => group.id === groupId)) throw new Error('分组不在指定画布中')
      if ('name' in input && groups.some(group => group.name === input.name && group.id !== groupId)) {
        throw new Error('此画布已有同名分组')
      }

      switch (input.type) {
        case 'create':
          groupId = randomUUID()
          this.db.run(`
            INSERT INTO artwork_groups (id, canvas_id, name, sort_order)
            VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM artwork_groups WHERE canvas_id = ?))
          `, [groupId, canvasId, input.name, canvasId])
          break
        case 'rename':
          this.db.run('UPDATE artwork_groups SET name = ? WHERE id = ?', [input.name, input.groupId])
          break
        case 'reorder': {
          const order = new Set(input.groupIds)
          if (order.size !== groups.length || groups.some(group => !order.has(group.id))) {
            throw new Error('分组列表已变化，请重新查询后排序')
          }
          input.groupIds.forEach((id, index) => this.db.run('UPDATE artwork_groups SET sort_order = ? WHERE id = ?', [index, id]))
          break
        }
        case 'delete': {
          const rows = this.db.exec('SELECT id FROM artworks WHERE canvas_id = ? AND group_id = ?', [canvasId, input.groupId])
          const artworkIds = (rows[0]?.values ?? []).map(([id]) => String(id))
          this.db.run('UPDATE artworks SET group_id = NULL WHERE canvas_id = ? AND group_id = ?', [canvasId, input.groupId])
          this.db.run('DELETE FROM artwork_groups WHERE id = ?', [input.groupId])
          assignment = { artworkIds, groupId: null }
          break
        }
        case 'assign': {
          const artworkIds = [...new Set(input.artworkIds)]
          const criterion = `canvas_id = ? AND id IN (${artworkIds.map(() => '?').join(', ')})`
          const params = [canvasId, ...artworkIds]
          const count = this.db.exec(`SELECT COUNT(*) FROM artworks WHERE ${criterion}`, params)[0].values[0][0]
          if (count !== artworkIds.length) throw new Error('有图片不存在或不在指定画布中')
          this.db.run(`UPDATE artworks SET group_id = ? WHERE ${criterion}`, [input.groupId, ...params])
          assignment = { artworkIds, groupId: input.groupId }
          break
        }
      }
      return { ...this.listArtworkGroups(canvasId), groupId, assignment }
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
      rows.push({ id: String(row.id), canvasId: String(row.canvas_id), groupId: row.group_id === null ? null : String(row.group_id), src: `data:${String(row.mime_type)};base64,${Buffer.from(bytes).toString('base64')}`, prompt: String(row.prompt), createdAt: Number(row.created_at), x: Number(row.canvas_x), y: Number(row.canvas_y), width: Number(row.canvas_width) })
    }
    statement.free()
    return rows
  }

  listArtworkMetadata(canvasId: string, limit: number, offset: number, groupId?: string | null) {
    const statement = this.db.prepare(`
      SELECT id, group_id, prompt, created_at, canvas_x, canvas_y, canvas_width
      FROM artworks WHERE canvas_id = ? ${groupId !== undefined ? 'AND group_id IS ?' : ''}
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?
    `)
    const rows: Array<Omit<StoredArtwork, 'src'>> = []
    try {
      statement.bind(groupId === undefined ? [canvasId, limit, offset] : [canvasId, groupId, limit, offset])
      while (statement.step()) {
        const row = statement.getAsObject()
        rows.push({ id: String(row.id), canvasId, groupId: row.group_id === null ? null : String(row.group_id), prompt: String(row.prompt), createdAt: Number(row.created_at), x: Number(row.canvas_x), y: Number(row.canvas_y), width: Number(row.canvas_width) })
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

  getArtworkReference(artworkId: string) {
    const row = this.db.exec('SELECT canvas_id, prompt, current_version_id, group_id FROM artworks WHERE id = ?', [artworkId])[0]?.values[0]
    if (!row) return undefined
    return { artworkId, canvasId: String(row[0]), title: String(row[1]).slice(0, 240), currentVersionId: String(row[2]),
      groupId: typeof row[3] === 'string' ? row[3] : null }
  }

  getArtworkEditRecipe(artworkId: string, versionId: string) {
    const result = this.db.exec('SELECT edit_recipe_json FROM artwork_versions WHERE artwork_id = ? AND id = ?', [artworkId, versionId])
    const recipe = result[0]?.values[0]?.[0]
    return typeof recipe === 'string' ? recipe : undefined
  }

  saveArtworkVersion(item: Omit<StoredArtworkVersion, 'isCurrent' | 'versionNumber'>, editRecipe?: string, historyEdit?: EditorPhotoHistoryEdit): Promise<StoredArtworkVersion> {
    const match = item.src.match(/^data:(.*?);base64,(.*)$/)
    if (!match) return Promise.reject(new Error('仅支持保存 data URL 图片'))
    return this.write(() => {
      const state = historyEdit && this.editorHistoryState(item.artworkId, { versionId: historyEdit.sourceVersionId, view: 'photo' })
      if (historyEdit && state) {
        if (historyEdit.expectedRevision !== undefined && historyEdit.expectedRevision !== state.revision) throw new Error('编辑历史已更新，请重新预览后再保存')
        const source = this.db.exec('SELECT 1 FROM artwork_versions WHERE artwork_id = ? AND id = ?', [item.artworkId, historyEdit.sourceVersionId])[0]
        if (!source) throw new Error('找不到编辑使用的图片版本')
      }
      this.db.run(`
        INSERT INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, edit_recipe_json, version_number)
        SELECT ?, artworks.id, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM artwork_versions WHERE artwork_id = artworks.id)
        FROM artworks WHERE artworks.id = ?
      `, [item.id, match[1], Buffer.from(match[2], 'base64'), item.prompt, item.createdAt, editRecipe ?? null, item.artworkId])
      if (!this.db.getRowsModified()) throw new Error('原图已不存在，无法保存版本')
      const versionNumber = Number(this.db.exec('SELECT version_number FROM artwork_versions WHERE id = ?', [item.id])[0].values[0][0])
      if (historyEdit && state) {
        const { kind, label } = historyEdit
        this.writeEditorHistory(item.artworkId, appendEditorHistory(state, { entry: { kind, label, view: 'photo', versionId: item.id } }))
      }
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
    const content: LegacyPosterContent = JSON.parse(String(row[2]))
    const history: LegacyPosterContent[] = JSON.parse(String(row[3]))
    return { artworkId, sourceVersionId: String(row[0]), revision: Number(row[1]), content: readPosterContent(content), history: history.map(readPosterContent) }
  }

  savePoster(poster: StoredPoster, previousRevision: number, historyEdit?: EditorPosterHistoryEdit, pixelTiles: readonly PosterPixelTileWrite[] = []) {
    const { artworkId, sourceVersionId, content } = poster
    return this.write(() => {
      const state = historyEdit && this.editorHistoryState(artworkId, { versionId: sourceVersionId, view: 'poster' })
      this.writePoster(historyEdit ? { ...poster, history: [] } : poster, previousRevision)
      this.writePosterPixelTiles(artworkId, pixelTiles)
      if (historyEdit && state) {
        const { kind, label } = historyEdit
        const versionId = state.steps[state.cursor]?.entry.versionId ?? sourceVersionId
        const entry: EditorHistoryEntry = { kind, label, view: 'poster', versionId }
        this.writeEditorHistory(artworkId, appendEditorHistory(state, { entry, poster: content }))
      } else if (!previousRevision) {
        // A poster opened after photo edits still needs a baseline for those earlier steps.
        const existing = this.readEditorHistory(artworkId)
        if (existing && !existing.baseline.poster) {
          this.writeEditorHistory(artworkId, { ...existing, baseline: { ...existing.baseline, poster: content } })
        } else this.prunePosterPixelTiles(artworkId, existing)
      } else this.prunePosterPixelTiles(artworkId, this.readEditorHistory(artworkId))
    })
  }

  private writePoster({ artworkId, sourceVersionId, revision, content, history }: StoredPoster, previousRevision: number) {
    const contentJson = JSON.stringify(content)
    const historyJson = JSON.stringify(history)
    if (!previousRevision) {
      this.db.run(`INSERT OR IGNORE INTO posters
        SELECT id, ?, ?, ?, ? FROM artworks WHERE id = ?`, [sourceVersionId, revision, contentJson, historyJson, artworkId])
    } else {
      this.db.run('UPDATE posters SET revision = ?, content_json = ?, history_json = ? WHERE artwork_id = ? AND revision = ?', [revision, contentJson, historyJson, artworkId, previousRevision])
    }
    if (!this.db.getRowsModified()) throw new Error('海报已更新或原图已删除，请重新打开')
  }

  private readEditorHistory(artworkId: string): StoredEditorHistory | undefined {
    const json = this.db.exec('SELECT state_json FROM editor_histories WHERE artwork_id = ?', [artworkId])[0]?.values[0]?.[0]
    return typeof json === 'string' ? JSON.parse(json) : undefined
  }

  private editorHistoryState(artworkId: string, first?: Pick<EditorHistoryEntry, 'versionId' | 'view'>): StoredEditorHistory {
    const stored = this.readEditorHistory(artworkId)
    if (stored) return stored
    const artwork = this.getArtworkReference(artworkId)
    if (!artwork) throw new Error('图片不存在')
    const poster = this.getPoster(artworkId)
    const baseline = { appliedVersionId: artwork.currentVersionId, poster: poster?.history[0] ?? poster?.content }
    const start = poster?.history.length
      ? { versionId: poster.sourceVersionId, view: 'poster' as const }
      : first ?? { versionId: artwork.currentVersionId, view: 'photo' as const }
    const steps: StoredEditorHistory['steps'] = [{ entry: { ...start, label: '初始状态', kind: 'initial' } }]
    if (poster?.history.length) {
      for (const content of [...poster.history.slice(1), poster.content]) {
        steps.push({ entry: { versionId: poster.sourceVersionId, view: 'poster', label: '编辑海报', kind: 'layers' }, poster: content })
      }
    }
    return { revision: poster?.revision ?? 1, cursor: steps.length - 1, steps, baseline }
  }

  private writeEditorHistory(artworkId: string, state: StoredEditorHistory) {
    this.db.run(`INSERT INTO editor_histories (artwork_id, state_json) VALUES (?, ?)
      ON CONFLICT(artwork_id) DO UPDATE SET state_json = excluded.state_json`, [artworkId, JSON.stringify(state)])
    this.prunePosterPixelTiles(artworkId, state)
  }

  getPosterPixelTiles(artworkId: string, ids: Iterable<string>) {
    const tiles = new Map<string, Buffer>()
    const uniqueIds = new Set(ids)
    if (!uniqueIds.size) return tiles
    const statement = this.db.prepare('SELECT image_data FROM poster_pixel_tiles WHERE artwork_id = ? AND id = ?')
    try {
      for (const id of uniqueIds) {
        statement.bind([artworkId, id])
        if (!statement.step()) throw new Error('图层的部分像素数据已丢失')
        tiles.set(id, Buffer.from(statement.get()[0] as Uint8Array))
      }
    } finally { statement.free() }
    return tiles
  }

  private writePosterPixelTiles(artworkId: string, tiles: readonly PosterPixelTileWrite[]) {
    if (!tiles.length) return
    const statement = this.db.prepare('INSERT OR IGNORE INTO poster_pixel_tiles (artwork_id, id, image_data) VALUES (?, ?, ?)')
    try {
      for (const tile of tiles) statement.run([artworkId, tile.id, tile.bytes])
    } finally { statement.free() }
  }

  private prunePosterPixelTiles(artworkId: string, state?: StoredEditorHistory) {
    const rows = this.db.exec('SELECT id FROM poster_pixel_tiles WHERE artwork_id = ?', [artworkId])[0]?.values
    if (!rows?.length) return
    const poster = this.getPoster(artworkId)
    const contents = [poster?.content, ...(poster?.history ?? []), state?.baseline.poster, ...(state?.steps.map(step => step.poster) ?? [])]
    const retained = new Set<string>()
    for (const content of contents) {
      for (const layer of Object.values(content?.pixelLayers ?? {})) {
        if (layer) for (const id of Object.values(layer.tiles)) retained.add(id)
      }
    }
    const statement = this.db.prepare('DELETE FROM poster_pixel_tiles WHERE artwork_id = ? AND id = ?')
    try {
      for (const [id] of rows) {
        if (!retained.has(String(id))) statement.run([artworkId, id])
      }
    } finally { statement.free() }
  }

  getEditorHistory(artworkId: string): EditorHistory {
    return describeEditorHistory(artworkId, this.editorHistoryState(artworkId))
  }

  navigateEditorHistory(artworkId: string, revision: number, cursor: number): Promise<EditorHistoryNavigation> {
    return this.write(() => {
      const state = this.editorHistoryState(artworkId)
      if (revision !== state.revision) throw new Error('编辑历史已更新，请刷新后重试')
      if (!Number.isInteger(cursor) || cursor < 0 || cursor >= state.steps.length) throw new Error('找不到该历史状态')
      const poster = this.getPoster(artworkId)
      if (cursor === state.cursor) return { history: describeEditorHistory(artworkId, state), poster }

      const target = editorStateAt(state, cursor)
      const updated = { ...state, cursor, revision: state.revision + 1 }
      let applied: AppliedArtworkVersion | undefined
      if (target.appliedVersionId !== this.getArtworkReference(artworkId)?.currentVersionId) {
        applied = this.writeAppliedArtworkVersion(artworkId, target.appliedVersionId)
        if (!applied) throw new Error('找不到该历史状态应用的图片版本')
      }
      const restored = poster && { ...poster, content: target.poster ?? poster.content, revision: poster.revision + 1, history: [] }
      if (restored) this.writePoster(restored, poster.revision)
      this.writeEditorHistory(artworkId, updated)
      return { history: describeEditorHistory(artworkId, updated), poster: restored, applied }
    })
  }

  applyArtworkVersion(artworkId: string, versionId: string): Promise<AppliedArtworkVersion | undefined> {
    return this.write(() => {
      const artwork = this.getArtworkReference(artworkId)
      if (!artwork) return undefined
      const state = versionId !== artwork.currentVersionId ? this.editorHistoryState(artworkId) : undefined
      const applied = this.writeAppliedArtworkVersion(artworkId, versionId)
      if (applied && state) {
        const entry: EditorHistoryEntry = { versionId, view: 'photo', label: '应用到画布', kind: 'apply' }
        this.writeEditorHistory(artworkId, appendEditorHistory(state, { entry, appliedVersionId: versionId }))
      }
      return applied
    })
  }

  private writeAppliedArtworkVersion(artworkId: string, versionId: string): AppliedArtworkVersion | undefined {
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
  }

  addArtwork(source: Pick<StoredArtwork, 'canvasId' | 'src' | 'prompt'>) {
    return this.write(() => {
      const count = this.getCanvasArtworkCount(source.canvasId)
      if (count === undefined) throw new Error('画布不存在，无法保存图片')
      const artwork = { ...source, id: randomUUID(), groupId: null, createdAt: Date.now(), x: count * 36, y: count * 36, width: 320 }
      this.writeArtworks([artwork])
      return { artwork, artworkCount: count + 1 }
    })
  }

  saveArtworks(items: StoredArtwork[]) {
    return this.write(() => this.writeArtworks(items))
  }

  private writeArtworks(items: StoredArtwork[]) {
    const canvasIds = new Set(items.map(item => item.canvasId))
    for (const canvasId of canvasIds) {
      if (this.getCanvasArtworkCount(canvasId) === undefined) throw new Error('画布不存在，无法保存图片')
    }
    const statement = this.db.prepare(`
      INSERT OR REPLACE INTO artworks (id, canvas_id, mime_type, image_data, prompt, created_at, canvas_x, canvas_y, canvas_width, current_version_id, group_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT group_id FROM artworks WHERE id = ? AND canvas_id = ?))
    `)
    try {
      for (const item of items) {
        const match = item.src.match(/^data:(.*?);base64,(.*)$/)
        if (!match) throw new Error('仅支持保存 data URL 图片')
        const bytes = Buffer.from(match[2], 'base64')
        statement.run([item.id, item.canvasId, match[1], bytes, item.prompt, item.createdAt, item.x, item.y, item.width, `original-${item.id}`, item.id, item.canvasId])
        this.db.run('INSERT OR IGNORE INTO artwork_versions (id, artwork_id, mime_type, image_data, prompt, created_at, version_number) VALUES (?, ?, ?, ?, ?, ?, 1)', [`original-${item.id}`, item.id, match[1], bytes, item.prompt, item.createdAt])
      }
    } finally { statement.free() }
    const updatedAt = Date.now()
    for (const canvasId of canvasIds) this.db.run('UPDATE canvases SET updated_at = ? WHERE id = ?', [updatedAt, canvasId])
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
    this.db.run(`DELETE FROM poster_pixel_tiles WHERE artwork_id IN (${matchingArtworks})`, [value])
    this.db.run(`DELETE FROM editor_histories WHERE artwork_id IN (${matchingArtworks})`, [value])
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

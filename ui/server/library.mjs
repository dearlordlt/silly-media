/**
 * Per-profile media library: SQLite metadata (`library.db`) + files on disk
 * (`files/<id>.<ext>`, `thumbs/<id>.<ext>`). Synchronous by design — every
 * method runs inside one JS tick, so check-then-write sequences are atomic
 * with respect to other requests.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export const KINDS = /** @type {const} */ (['image', 'audio', 'video', 'model3d'])

/** Item ids become file names, so they are restricted to a filesystem-safe set. */
const ID_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** @type {Record<string, string>} */
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'video/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/webm': 'webm',
  'model/gltf-binary': 'glb',
}

/** Error carrying an HTTP status and a JSON body (`{error, ...extra}`). */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, unknown>} [extra]
   */
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** `type/subtype` of a Content-Type, lower-cased, parameters stripped. */
export function mimeBase(/** @type {string | undefined} */ ct) {
  return (ct ?? '').split(';')[0].trim().toLowerCase()
}

export function extForMime(/** @type {string} */ mime) {
  return EXT_BY_MIME[mimeBase(mime)] ?? 'bin'
}

export function isValidId(/** @type {unknown} */ id) {
  return typeof id === 'string' && ID_RE.test(id)
}

/**
 * @typedef {'image' | 'audio' | 'video' | 'model3d'} MediaKind
 * @typedef {{
 *   id: string, kind: MediaKind, source: string, name: string,
 *   prompt: string | null, negativePrompt: string | null, model: string | null, seed: number | null,
 *   width: number | null, height: number | null, durationSeconds: number | null,
 *   meta: Record<string, unknown> | null, createdAt: number, favorite: boolean, tags: string[],
 *   mime: string, size: number, thumbVersion: number | null,
 * }} ItemRecord
 * @typedef {Omit<ItemRecord, 'size' | 'thumbVersion'>} ItemInput
 */

const bad = (/** @type {string} */ msg) => new HttpError(400, msg)

/** Field validators shared by item creation and PATCH. Each returns the DB-ready value. */
/** @type {Record<string, { col: string, check: (v: unknown, k: string) => unknown }>} */
const FIELDS = {
  name: { col: 'name', check: (v, k) => str(v, k) },
  prompt: { col: 'prompt', check: (v, k) => nullable(v, k, str) },
  negativePrompt: { col: 'negative_prompt', check: (v, k) => nullable(v, k, str) },
  model: { col: 'model', check: (v, k) => nullable(v, k, str) },
  seed: { col: 'seed', check: (v, k) => nullable(v, k, int) },
  width: { col: 'width', check: (v, k) => nullable(v, k, nonNegInt) },
  height: { col: 'height', check: (v, k) => nullable(v, k, nonNegInt) },
  durationSeconds: { col: 'duration_seconds', check: (v, k) => nullable(v, k, num) },
  meta: {
    col: 'meta',
    check: (v, k) =>
      nullable(v, k, (x) => {
        if (typeof x !== 'object' || Array.isArray(x)) throw bad(`${k} must be an object or null`)
        return JSON.stringify(x)
      }),
  },
  createdAt: { col: 'created_at', check: (v, k) => int(v, k) },
  favorite: {
    col: 'favorite',
    check: (v, k) => {
      if (typeof v !== 'boolean') throw bad(`${k} must be a boolean`)
      return v ? 1 : 0
    },
  },
  tags: {
    col: 'tags',
    check: (v, k) => {
      if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) throw bad(`${k} must be a string[]`)
      return JSON.stringify(v)
    },
  },
}

const PATCHABLE = new Set(['name', 'favorite', 'meta', 'width', 'height', 'durationSeconds', 'tags', 'prompt'])

function str(/** @type {unknown} */ v, /** @type {string} */ k) {
  if (typeof v !== 'string') throw bad(`${k} must be a string`)
  return v
}
function num(/** @type {unknown} */ v, /** @type {string} */ k) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`${k} must be a finite number`)
  return v
}
function int(/** @type {unknown} */ v, /** @type {string} */ k) {
  if (!Number.isSafeInteger(v)) throw bad(`${k} must be an integer`)
  return /** @type {number} */ (v)
}
function nonNegInt(/** @type {unknown} */ v, /** @type {string} */ k) {
  if (int(v, k) < 0) throw bad(`${k} must be >= 0`)
  return /** @type {number} */ (v)
}
/**
 * @param {unknown} v
 * @param {string} k
 * @param {(v: unknown, k: string) => unknown} check
 */
function nullable(v, k, check) {
  return v === null ? null : check(v, k)
}

function isPlainObject(/** @type {unknown} */ v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** @param {Record<string, any>} r */
function toRecord(r) {
  return /** @type {ItemRecord} */ ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    name: r.name,
    prompt: r.prompt,
    negativePrompt: r.negative_prompt,
    model: r.model,
    seed: r.seed,
    width: r.width,
    height: r.height,
    durationSeconds: r.duration_seconds,
    meta: r.meta == null ? null : JSON.parse(r.meta),
    createdAt: r.created_at,
    favorite: r.favorite === 1,
    tags: JSON.parse(r.tags),
    mime: r.mime,
    size: r.size,
    thumbVersion: r.thumb_version,
  })
}

/** Schema migrations; index i upgrades user_version i → i + 1. */
const MIGRATIONS = [
  `CREATE TABLE items(
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
     prompt TEXT, negative_prompt TEXT, model TEXT, seed INTEGER, width INTEGER, height INTEGER,
     duration_seconds REAL, meta TEXT, created_at INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
     tags TEXT NOT NULL DEFAULT '[]', mime TEXT NOT NULL, size INTEGER NOT NULL,
     file TEXT NOT NULL, thumb_file TEXT, thumb_mime TEXT, thumb_version INTEGER);
   CREATE INDEX items_created ON items(created_at DESC);
   CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
]

export class Library {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir
    this.filesDir = join(dataDir, 'files')
    this.thumbsDir = join(dataDir, 'thumbs')
    this.dbPath = join(dataDir, 'library.db')
    mkdirSync(this.filesDir, { recursive: true })
    mkdirSync(this.thumbsDir, { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    this.#migrate()
    const db = this.db
    this.q = {
      list: db.prepare('SELECT * FROM items ORDER BY created_at DESC, rowid DESC'),
      get: db.prepare('SELECT * FROM items WHERE id = ?'),
      insert: db.prepare(
        `INSERT INTO items(id, kind, source, name, prompt, negative_prompt, model, seed, width, height,
           duration_seconds, meta, created_at, favorite, tags, mime, size, file)
         VALUES (:id, :kind, :source, :name, :prompt, :negative_prompt, :model, :seed, :width, :height,
           :duration_seconds, :meta, :created_at, :favorite, :tags, :mime, :size, :file)`,
      ),
      setThumb: db.prepare('UPDATE items SET thumb_file = ?, thumb_mime = ?, thumb_version = ? WHERE id = ?'),
      del: db.prepare('DELETE FROM items WHERE id = ? RETURNING file, thumb_file'),
      delKind: db.prepare('DELETE FROM items WHERE kind = ? RETURNING id, file, thumb_file'),
      delAll: db.prepare('DELETE FROM items RETURNING id, file, thumb_file'),
      stats: db.prepare('SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM items GROUP BY kind'),
      kvAll: db.prepare('SELECT key, value FROM kv'),
      kvSet: db.prepare(
        'INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ),
      kvDel: db.prepare('DELETE FROM kv WHERE key = ?'),
    }
  }

  #migrate() {
    const row = /** @type {{ user_version: number }} */ (this.db.prepare('PRAGMA user_version').get())
    for (let v = row.user_version; v < MIGRATIONS.length; v++) {
      this.#tx(() => {
        this.db.exec(MIGRATIONS[v])
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  /**
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close() {
    if (this.db.isOpen) this.db.close()
  }

  filePath(/** @type {string} */ name) {
    return join(this.filesDir, name)
  }

  thumbPath(/** @type {string} */ name) {
    return join(this.thumbsDir, name)
  }

  /** Temp path inside `dir` (same filesystem, so rename is atomic). */
  tmpPath(/** @type {'files' | 'thumbs'} */ dir) {
    return join(dir === 'files' ? this.filesDir : this.thumbsDir, `.tmp-${randomUUID()}`)
  }

  /** @returns {ItemRecord[]} */
  list() {
    return this.q.list.all().map(toRecord)
  }

  /** @returns {Record<string, any> | undefined} */
  row(/** @type {string} */ id) {
    return this.q.get.get(id)
  }

  /** @returns {ItemRecord | null} */
  get(/** @type {string} */ id) {
    const r = this.row(id)
    return r ? toRecord(r) : null
  }

  /**
   * Validate an upload's JSON header and fill defaults.
   * @param {unknown} raw
   * @returns {Record<string, unknown> & { id: string, mime: string }} DB-ready column values (minus size/file)
   */
  validateInput(raw) {
    if (!isPlainObject(raw)) throw bad('item metadata must be a JSON object')
    const input = /** @type {Record<string, unknown>} */ (raw)
    if (!KINDS.includes(/** @type {any} */ (input.kind))) throw bad(`kind must be one of ${KINDS.join(', ')}`)
    if (typeof input.source !== 'string' || !input.source) throw bad('source must be a non-empty string')
    if (typeof input.mime !== 'string' || !input.mime) throw bad('mime must be a non-empty string')
    const id = input.id ?? randomUUID()
    if (!isValidId(id)) throw bad('id must match [A-Za-z0-9_-][A-Za-z0-9._-]{0,127}')
    /** @type {Record<string, unknown>} */
    const cols = {
      id, kind: input.kind, source: input.source, mime: input.mime,
      name: '', prompt: null, negative_prompt: null, model: null, seed: null, width: null, height: null,
      duration_seconds: null, meta: null, created_at: Date.now(), favorite: 0, tags: '[]',
    }
    for (const [k, v] of Object.entries(input)) {
      if (k === 'id' || k === 'kind' || k === 'source' || k === 'mime') continue
      const f = FIELDS[k]
      if (!f) throw bad(`unknown field: ${k}`)
      if (v === undefined) continue
      cols[f.col] = f.check(v, k)
    }
    return /** @type {any} */ (cols)
  }

  /**
   * Insert a validated item whose file is already in place under `files/`.
   * @param {Record<string, unknown>} cols from validateInput
   * @param {string} file file name inside files/
   * @param {number} size
   */
  insert(cols, file, size) {
    this.q.insert.run(/** @type {any} */ ({ ...cols, file, size }))
    return /** @type {ItemRecord} */ (this.get(/** @type {string} */ (cols.id)))
  }

  /**
   * Apply a partial update. Returns null when the item does not exist.
   * @param {string} id
   * @param {unknown} patch
   */
  patch(id, patch) {
    if (!isPlainObject(patch)) throw bad('patch must be a JSON object')
    /** @type {string[]} */
    const sets = []
    /** @type {any[]} */
    const vals = []
    for (const [k, v] of Object.entries(/** @type {object} */ (patch))) {
      if (!PATCHABLE.has(k)) throw bad(`field not patchable: ${k}`)
      if (v === undefined) continue
      const f = FIELDS[k]
      sets.push(`${f.col} = ?`)
      vals.push(f.check(v, k))
    }
    if (!this.row(id)) return null
    if (sets.length) this.db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    return this.get(id)
  }

  /**
   * Point an item at a new thumb file (already in thumbs/); removes the previous one.
   * @returns {ItemRecord | null}
   */
  setThumb(/** @type {string} */ id, /** @type {string} */ file, /** @type {string} */ mime) {
    const prev = this.row(id)
    if (!prev) return null
    this.q.setThumb.run(file, mime, Date.now(), id)
    if (prev.thumb_file && prev.thumb_file !== file) rmSync(this.thumbPath(prev.thumb_file), { force: true })
    return this.get(id)
  }

  /** @param {{ file: string, thumb_file: string | null }} r */
  #unlinkFiles(r) {
    rmSync(this.filePath(r.file), { force: true })
    if (r.thumb_file) rmSync(this.thumbPath(r.thumb_file), { force: true })
  }

  /**
   * Delete items by id; returns the ids that existed.
   * @param {string[]} ids
   */
  deleteIds(ids) {
    const rows = this.#tx(() => ids.map((id) => ({ id, r: this.q.del.get(id) })).filter((x) => x.r))
    for (const { r } of rows) this.#unlinkFiles(/** @type {any} */ (r))
    return rows.map((x) => x.id)
  }

  /**
   * Delete every item of a kind (or all items); returns deleted ids.
   * @param {MediaKind} [kind]
   */
  deleteKind(kind) {
    const rows = /** @type {any[]} */ (kind ? this.q.delKind.all(kind) : this.q.delAll.all())
    for (const r of rows) this.#unlinkFiles(r)
    return rows.map((r) => /** @type {string} */ (r.id))
  }

  stats() {
    let items = 0
    let bytes = 0
    /** @type {Record<string, { count: number, bytes: number }>} */
    const byKind = {}
    for (const r of /** @type {any[]} */ (this.q.stats.all())) {
      byKind[r.kind] = { count: r.count, bytes: r.bytes }
      items += r.count
      bytes += r.bytes
    }
    let dbBytes = 0
    for (const suffix of ['', '-wal', '-shm']) dbBytes += statSync(this.dbPath + suffix, { throwIfNoEntry: false })?.size ?? 0
    return { items, bytes, byKind, dbBytes }
  }

  /** @returns {Record<string, string>} */
  kvAll() {
    /** @type {Record<string, string>} */
    const values = {}
    for (const r of /** @type {any[]} */ (this.q.kvAll.all())) values[r.key] = r.value
    return values
  }

  /**
   * Apply a kv batch atomically (deletes run after sets).
   * @param {unknown} body
   */
  kvApply(body) {
    if (!isPlainObject(body)) throw bad('body must be a JSON object')
    const { set, delete: del, ...rest } = /** @type {Record<string, unknown>} */ (body)
    const extra = Object.keys(rest)
    if (extra.length) throw bad(`unknown field: ${extra[0]}`)
    if (set !== undefined && (!isPlainObject(set) || !Object.values(/** @type {object} */ (set)).every((v) => typeof v === 'string')))
      throw bad('set must be a Record<string, string>')
    if (del !== undefined && (!Array.isArray(del) || !del.every((k) => typeof k === 'string'))) throw bad('delete must be a string[]')
    const now = Date.now()
    this.#tx(() => {
      for (const [k, v] of Object.entries(/** @type {Record<string, string>} */ (set ?? {}))) this.q.kvSet.run(k, v, now)
      for (const k of /** @type {string[]} */ (del ?? [])) this.q.kvDel.run(k)
    })
  }
}

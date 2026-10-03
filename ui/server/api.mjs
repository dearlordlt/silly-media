/**
 * `/app-api` HTTP handlers: library items + files, key-value settings, and an
 * SSE stream that tells other tabs of the same profile about item changes.
 */
import { createReadStream, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { HttpError, KINDS, extForMime, isValidId, mimeBase } from './library.mjs'

export const PREFIX = '/app-api'

/** Hard cap on any request body (item uploads, thumbs). */
const MAX_BODY = 2 * 1024 ** 3
/** Cap on JSON bodies and the JSON header of an item upload. */
const MAX_JSON = 32 * 1024 ** 2
const PING_MS = 25_000

/**
 * @typedef {import('node:http').IncomingMessage} Req
 * @typedef {import('node:http').ServerResponse} Res
 * @typedef {import('./library.mjs').Library} Library
 */

const bad = (/** @type {string} */ msg) => new HttpError(400, msg)
const notFound = (/** @type {string} */ what) => new HttpError(404, `${what} not found`)

/** @param {Res} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** @param {Req} req @param {Res} res @param {unknown} err */
function fail(req, res, err) {
  const status = err instanceof HttpError ? err.status : 500
  if (status === 500) console.error('app-api:', err)
  if (res.headersSent || res.destroyed) return void res.destroy()
  // An error before the body was consumed: answer, then let the socket close
  // instead of reading (possibly gigabytes of) the remaining upload.
  const unread = !req.complete
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(unread ? { Connection: 'close' } : {}),
  })
  const message = err instanceof Error ? err.message : String(err)
  res.end(JSON.stringify({ error: message, ...(err instanceof HttpError ? err.extra : {}) }))
  if (unread) req.resume()
}

/**
 * Request body chunks, enforcing `limit`. Early exit does not destroy the
 * socket, so an error response can still be written.
 * @param {Req} req
 * @param {number} limit
 * @returns {AsyncGenerator<Buffer>}
 */
async function* bodyChunks(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`)
  let total = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, `request body exceeds ${limit} bytes`)
    yield chunk
  }
}

/** Parse a JSON body regardless of Content-Type (sendBeacon posts text/plain). */
async function readJson(/** @type {Req} */ req) {
  /** @type {Buffer[]} */
  const parts = []
  for await (const c of bodyChunks(req, MAX_JSON)) parts.push(c)
  return parseJson(Buffer.concat(parts))
}

function parseJson(/** @type {Buffer} */ buf) {
  if (!buf.length) throw bad('empty JSON body')
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw bad('invalid JSON body')
  }
}

/**
 * Write `first` then the rest of `chunks` to a new file at `tmp`; returns the
 * byte count. On failure the temp file is removed and `chunks` released.
 * @param {string} tmp
 * @param {Buffer | null} first
 * @param {AsyncGenerator<Buffer>} chunks
 */
async function writeTmp(tmp, first, chunks) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let fh
  let size = 0
  const put = async (/** @type {Buffer} */ buf) => {
    for (let off = 0; off < buf.length; ) off += (await fh.write(buf, off, buf.length - off)).bytesWritten
    size += buf.length
  }
  try {
    fh = await open(tmp, 'wx')
    if (first?.length) await put(first)
    for (let r = await chunks.next(); !r.done; r = await chunks.next()) await put(r.value)
    await fh.close()
    return size
  } catch (e) {
    await fh?.close().catch(() => {})
    rmSync(tmp, { force: true })
    await chunks.return(undefined)
    throw e
  }
}

/**
 * Single `bytes=` range → [start, end] inclusive; null = serve whole file;
 * 'unsatisfiable' = 416. Multi-range and malformed headers are ignored.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {[number, number] | null | 'unsatisfiable'}
 */
function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  if (m[1] === '') {
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'unsatisfiable'
    return [Math.max(0, size - n), size - 1]
  }
  const start = Number(m[1])
  const last = m[2] === '' ? Infinity : Number(m[2])
  if (last < start) return null
  if (start >= size) return 'unsatisfiable'
  return [start, Math.min(last, size - 1)]
}

/** `attachment` disposition with an ASCII fallback and an RFC 5987 UTF-8 name. */
function contentDisposition(/** @type {string} */ name) {
  const clean = name.replace(/[\x00-\x1f\x7f"\\/]/g, '_')
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

/**
 * Stream a stored file with Range support.
 * @param {Req} req
 * @param {Res} res
 * @param {string} path
 * @param {string} mime
 * @param {string | null} download requested download name, if any
 */
function serveFile(req, res, path, mime, download) {
  const st = statSync(path, { throwIfNoEntry: false })
  if (!st?.isFile()) throw notFound('file')
  const range = parseRange(req.headers.range, st.size)
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ error: 'range not satisfiable' }))
  }
  const [start, end] = range ?? [0, st.size - 1]
  /** @type {Record<string, string | number>} */
  const headers = {
    'Content-Type': mime,
    'Content-Length': Math.max(0, end - start + 1),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
  }
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`
  if (download !== null) headers['Content-Disposition'] = contentDisposition(download)
  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD' || st.size === 0) return res.end()
  const stream = createReadStream(path, { start, end })
  // A file deleted mid-stream must not take the server down.
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Reject cross-site writes: a page on another origin could otherwise POST
 * (e.g. text/plain forms) to this loopback server and wipe the library.
 * @param {Req} req
 */
function checkOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return
  let host
  try {
    host = new URL(origin)
  } catch {
    throw new HttpError(403, 'cross-origin request refused')
  }
  if (LOOPBACK.has(host.hostname) || host.hostname.endsWith('.localhost') || host.host === req.headers.host) return
  throw new HttpError(403, 'cross-origin request refused')
}

/**
 * @param {{ lib: Library, profile: string, dataDir: string, startedAt: number }} ctx
 */
export function createApi({ lib, profile, dataDir, startedAt }) {
  /** @type {Set<Res>} */
  const clients = new Set()
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n')
  }, PING_MS)
  ping.unref()

  /** @param {'item' | 'clear'} event @param {Record<string, unknown>} data */
  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const c of clients) c.write(msg)
  }

  function closeEvents() {
    clearInterval(ping)
    for (const c of clients) c.end()
    clients.clear()
  }

  /** @param {Req} req @param {Res} res */
  function events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    clients.add(res)
    const drop = () => clients.delete(res)
    req.on('close', drop)
    res.on('close', drop)
    res.on('error', drop)
  }

  /** @param {Req} req @param {Res} res @param {string | undefined} client */
  async function createItem(req, res, client) {
    if (mimeBase(req.headers['content-type']) !== 'application/x-silly-item')
      throw new HttpError(415, 'Content-Type must be application/x-silly-item')
    const chunks = bodyChunks(req, MAX_BODY)
    let head = Buffer.alloc(0)
    const take = async () => {
      const r = await chunks.next()
      if (r.done) throw bad('truncated item frame')
      head = head.length ? Buffer.concat([head, r.value]) : r.value
    }
    let cols
    try {
      while (head.length < 4) await take()
      const n = head.readUInt32BE(0)
      if (n > MAX_JSON) throw bad(`item metadata exceeds ${MAX_JSON} bytes`)
      while (head.length < 4 + n) await take()
      cols = lib.validateInput(parseJson(head.subarray(4, 4 + n)))
      head = head.subarray(4 + n)
    } catch (e) {
      // Detach from the request so the error response can flow (see fail()).
      await chunks.return(undefined)
      throw e
    }
    const id = cols.id
    const exists = () => {
      const item = lib.get(id)
      if (item) throw new HttpError(409, `item ${id} already exists`, { item })
    }
    try {
      exists()
    } catch (e) {
      await chunks.return(undefined)
      throw e
    }
    const tmp = lib.tmpPath('files')
    const size = await writeTmp(tmp, head, chunks)
    // Synchronous from here on: no other request can interleave.
    try {
      exists()
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    }
    const file = `${id}.${extForMime(cols.mime)}`
    renameSync(tmp, lib.filePath(file))
    let item
    try {
      item = lib.insert(cols, file, size)
    } catch (e) {
      rmSync(lib.filePath(file), { force: true })
      throw e
    }
    broadcast('item', { op: 'add', id, item, client })
    sendJson(res, 201, item)
  }

  /** @param {Req} req @param {Res} res @param {string} id @param {string | undefined} client */
  async function putThumb(req, res, id, client) {
    if (!lib.row(id)) throw notFound('item')
    const mime = mimeBase(req.headers['content-type'])
    if (!mime.startsWith('image/')) throw new HttpError(415, 'Content-Type must be an image/* type')
    const tmp = lib.tmpPath('thumbs')
    const size = await writeTmp(tmp, null, bodyChunks(req, MAX_BODY))
    if (!size || !lib.row(id)) {
      rmSync(tmp, { force: true })
      throw size ? notFound('item') : bad('empty thumbnail body')
    }
    const file = `${id}.${extForMime(mime)}`
    renameSync(tmp, lib.thumbPath(file))
    const item = lib.setThumb(id, file, mime)
    broadcast('item', { op: 'update', id, item, client })
    sendJson(res, 200, item)
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {string[]} parts decoded path segments after /app-api
   * @param {URL} url
   */
  async function route(req, res, parts, url) {
    const m = req.method ?? 'GET'
    const read = m === 'GET' || m === 'HEAD'
    if (!read) checkOrigin(req)
    const h = req.headers['x-client-id']
    const client = typeof h === 'string' && h.length <= 128 ? h : undefined
    const [a, b, c, ...more] = parts
    const methodNotAllowed = () => new HttpError(405, `${m} not allowed on ${url.pathname}`)
    if (more.length) throw notFound('route')

    if (a === 'info' && !b) {
      if (!read) throw methodNotAllowed()
      return sendJson(res, 200, { app: 'silly-media-ui', profile, dataDir, pid: process.pid, startedAt, version: 1 })
    }

    if (a === 'items' && !b) {
      if (read) return sendJson(res, 200, { items: lib.list() })
      if (m === 'POST') return createItem(req, res, client)
      if (m === 'DELETE') {
        const kind = url.searchParams.get('kind')
        if (kind !== null && !KINDS.includes(/** @type {any} */ (kind))) throw bad(`kind must be one of ${KINDS.join(', ')}`)
        const ids = lib.deleteKind(/** @type {any} */ (kind ?? undefined))
        if (ids.length) broadcast('clear', { kind: kind ?? undefined, ids, client })
        return sendJson(res, 200, { deleted: ids.length })
      }
      throw methodNotAllowed()
    }

    if (a === 'items' && b === 'delete' && !c && m === 'POST') {
      const body = await readJson(req)
      const ids = body?.ids
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw bad('ids must be a string[]')
      const deleted = lib.deleteIds([...new Set(/** @type {string[]} */ (ids))])
      if (deleted.length) broadcast('clear', { ids: deleted, client })
      return sendJson(res, 200, { deleted: deleted.length })
    }

    if (a === 'items' && b && !c) {
      if (read) {
        const item = lib.get(b)
        if (!item) throw notFound('item')
        return sendJson(res, 200, item)
      }
      if (m === 'PATCH') {
        const item = lib.patch(b, await readJson(req))
        if (!item) throw notFound('item')
        broadcast('item', { op: 'update', id: b, item, client })
        return sendJson(res, 200, item)
      }
      if (m === 'DELETE') {
        if (lib.deleteIds([b]).length) broadcast('item', { op: 'delete', id: b, client })
        res.writeHead(204)
        return res.end()
      }
      throw methodNotAllowed()
    }

    if (a === 'items' && b && c === 'thumb') {
      if (m !== 'PUT') throw methodNotAllowed()
      return putThumb(req, res, b, client)
    }

    if ((a === 'files' || a === 'thumbs') && b && !c) {
      if (!read) throw methodNotAllowed()
      const row = isValidId(b) ? lib.row(b) : undefined
      if (!row) throw notFound('item')
      if (a === 'files') return serveFile(req, res, lib.filePath(row.file), row.mime, url.searchParams.get('download'))
      if (!row.thumb_file) throw notFound('thumbnail')
      return serveFile(req, res, lib.thumbPath(row.thumb_file), row.thumb_mime, null)
    }

    if (a === 'stats' && !b) {
      if (!read) throw methodNotAllowed()
      return sendJson(res, 200, { ...lib.stats(), dataDir, profile })
    }

    if (a === 'kv' && !b) {
      if (read) return sendJson(res, 200, { values: lib.kvAll() })
      if (m !== 'POST') throw methodNotAllowed()
      lib.kvApply(await readJson(req))
      return sendJson(res, 200, { ok: true })
    }

    if (a === 'events' && !b) {
      if (m !== 'GET') throw methodNotAllowed()
      return events(req, res)
    }

    throw notFound('route')
  }

  /**
   * @param {Req} req
   * @param {Res} res
   * @param {URL} url pathname starts with PREFIX
   */
  async function handle(req, res, url) {
    try {
      const parts = url.pathname
        .slice(PREFIX.length)
        .split('/')
        .filter(Boolean)
        .map((s) => {
          try {
            return decodeURIComponent(s)
          } catch {
            throw bad('malformed URL escape')
          }
        })
      await route(req, res, parts, url)
    } catch (err) {
      fail(req, res, err)
    }
  }

  return { handle, closeEvents }
}

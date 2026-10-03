/**
 * Static file serving for the built SPA, mounted under a URL prefix (/ui/)
 * with SPA fallback for client-side routes.
 */
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain' })
  res.end(body)
}

/**
 * @param {{ root: string, base: string }} opts `root` absolute, `base` like `/ui/`
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => void}
 */
export function createStatic({ root, base }) {
  /** Resolve a URL path to a file inside root; null on traversal or bad encoding. */
  function safeJoin(/** @type {string} */ urlPath) {
    let decoded
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return null // malformed %-escape: treat as not found instead of crashing
    }
    const clean = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
    const full = join(root, clean)
    if (full !== root && !full.startsWith(root + sep)) return null
    return full
  }

  return (_req, res, pathname) => {
    if (!pathname.startsWith(base)) {
      if (pathname === '/' || pathname === base.slice(0, -1)) {
        res.writeHead(302, { Location: base })
        return res.end()
      }
      return sendText(res, 404, 'Not found')
    }

    const rel = pathname.slice(base.length)
    let filePath = safeJoin(rel === '' ? 'index.html' : rel)

    if (filePath) {
      try {
        const st = statSync(filePath)
        if (st.isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        filePath = null
      }
    }

    // SPA fallback: any unknown non-asset route serves index.html.
    if (!filePath || !statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      if (extname(rel)) return sendText(res, 404, 'Not found')
      filePath = join(root, 'index.html')
    }

    if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
      return sendText(res, 404, 'UI not built — run npm run build')
    }

    const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    const immutable = /\.[0-9a-f]{8,}\./.test(filePath) || filePath.includes(`${sep}assets${sep}`)
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    const stream = createReadStream(filePath)
    // A file removed mid-request (e.g. during a rebuild) must not kill the server.
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}

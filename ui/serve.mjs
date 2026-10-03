#!/usr/bin/env node
/**
 * Minimal static file server for the built UI, mounted under a URL prefix
 * (/ui/) with SPA fallback. Zero dependencies — Node built-ins only.
 *
 * Usage: node serve.mjs --root dist --base /ui/ --port 5273 [--host 127.0.0.1]
 */
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const root = resolve(opt('root', 'dist'))
const base = ('/' + opt('base', '/ui/').replace(/^\/+|\/+$/g, '') + '/').replace('//', '/')
const port = Number(opt('port', '5273'))
const host = opt('host', '127.0.0.1')

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

function send(res, status, headers, body) {
  res.writeHead(status, headers)
  if (body) res.end(body)
  else res.end()
}

/** Resolve a URL path to a file inside root; null on traversal or bad encoding. */
function safeJoin(urlPath) {
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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  let pathname = url.pathname

  if (!pathname.startsWith(base)) {
    if (pathname === base.slice(0, -1)) {
      res.writeHead(302, { Location: base })
      return res.end()
    }
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found')
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
    if (extname(rel)) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found')
    filePath = join(root, 'index.html')
  }

  if (!statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    return send(res, 404, { 'Content-Type': 'text/plain' }, 'UI not built — run npm run build')
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
})

server.listen(port, host, () => {
  console.log(`Silly Media UI served at http://${host}:${port}${base}`)
})

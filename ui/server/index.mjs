#!/usr/bin/env node
/**
 * Silly Media UI app server: serves the built SPA under a URL prefix (/ui/)
 * and owns one profile's library (SQLite + files) under /app-api.
 * Zero dependencies — Node built-ins only (Node >= 22.13 for node:sqlite).
 *
 * Usage:
 *   node ui/server/index.mjs --root ui/dist --base /ui/ --port 5273 [--host 127.0.0.1]
 *                            [--profile default] [--data-dir <profileDir>] [--api-only]
 *
 * Exit codes: 2 bad arguments, 3 profile already served by a live process,
 * 4 port unavailable.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Library } from './library.mjs'
import { PREFIX, createApi } from './api.mjs'
import { createStatic } from './static.mjs'

const args = process.argv.slice(2)
const opt = (/** @type {string} */ name, /** @type {string} */ fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const flag = (/** @type {string} */ name) => args.includes(`--${name}`)

function die(/** @type {number} */ code, /** @type {string} */ msg) {
  console.error(`Error: ${msg}`)
  process.exit(code)
}

const profile = opt('profile', 'default')
if (!/^[A-Za-z0-9_-]{1,32}$/.test(profile)) die(2, `invalid profile name '${profile}' (allowed: [A-Za-z0-9_-]{1,32})`)

const dataRoot = process.env.SILLY_UI_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'silly-media-ui')
const dataDir = resolve(opt('data-dir', join(dataRoot, 'profiles', profile)))
const root = resolve(opt('root', 'dist'))
const base = ('/' + opt('base', '/ui/').replace(/^\/+|\/+$/g, '') + '/').replace('//', '/')
const port = Number(opt('port', '5273'))
const host = opt('host', '127.0.0.1')
const apiOnly = flag('api-only')
if (!Number.isInteger(port) || port < 0 || port > 65535) die(2, `invalid --port '${opt('port', '')}'`)

mkdirSync(dataDir, { recursive: true })
const serverJson = join(dataDir, 'server.json')

/** True when `pid` names a running process (EPERM = alive, owned by someone else). */
function alive(/** @type {unknown} */ pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return false
  try {
    process.kill(/** @type {number} */ (pid), 0)
    return true
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'
  }
}

/** @type {{ pid?: number, port?: number, host?: string } | null} */
let existing = null
try {
  existing = JSON.parse(readFileSync(serverJson, 'utf8'))
} catch {
  // missing or unreadable: no live server recorded
}
if (existing && existing.pid !== process.pid && alive(existing.pid)) {
  die(
    3,
    `profile '${profile}' is already served by pid ${existing.pid} on http://${existing.host ?? '127.0.0.1'}:${existing.port}${base}` +
      ` (${serverJson})`,
  )
}

const startedAt = Date.now()
const lib = new Library(dataDir)
const api = createApi({ lib, profile, dataDir, startedAt })
const serveStatic = apiOnly ? null : createStatic({ root, base })

const server = createServer((req, res) => {
  let url
  try {
    url = new URL(req.url ?? '/', 'http://localhost')
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    return res.end('Bad request')
  }
  if (url.pathname === PREFIX || url.pathname.startsWith(PREFIX + '/')) return void api.handle(req, res, url)
  if (serveStatic) return serveStatic(req, res, url.pathname)
  res.writeHead(404, { 'Content-Type': 'text/plain' })
  res.end('Not found (API-only server)')
})
// Large uploads over slow links must not be cut off by the default 5 min request timeout.
server.requestTimeout = 0

let ownsServerJson = false
function removeServerJson() {
  if (!ownsServerJson) return
  ownsServerJson = false
  try {
    if (JSON.parse(readFileSync(serverJson, 'utf8')).pid === process.pid) rmSync(serverJson, { force: true })
  } catch {
    // already gone
  }
}

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  removeServerJson()
  api.closeEvents()
  server.close()
  server.closeAllConnections()
  lib.close()
  process.exit(0)
}
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(sig, shutdown)
process.on('exit', removeServerJson)

server.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
  lib.close()
  if (err.code === 'EADDRINUSE') die(4, `port ${port} on ${host} is already in use`)
  if (err.code === 'EACCES') die(4, `no permission to listen on ${host}:${port}`)
  die(1, err.message)
})

server.listen(port, host, () => {
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
  const info = { pid: process.pid, port: addr.port, host, profile, startedAt, apiOnly }
  const tmp = `${serverJson}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(info) + '\n')
  renameSync(tmp, serverJson)
  ownsServerJson = true
  const shown = host.includes(':') ? `[${host}]` : host
  console.log(
    apiOnly
      ? `Silly Media app API (profile '${profile}') at http://${shown}:${addr.port}${PREFIX}`
      : `Silly Media UI (profile '${profile}') served at http://${shown}:${addr.port}${base}`,
  )
})

import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeJson } from './accounts.mjs'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_TTL = 5 * 60000
const MAX_TRIES = 5
const MAX_ATTEMPTS = 10
const sha = s => createHash('sha256').update(s).digest('hex')
const normalize = s => String(s).toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')

export function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device'
  const browser = /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Edg/.test(ua) ? 'Edge' : /Chrome|CriOS/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser'
  return `${os} · ${browser}`
}

export function createDevices(file, now = Date.now) {
  let enabled = false
  let devices = []
  let pairing = null
  let attempts = []
  let queue = Promise.resolve()
  const revokeListeners = []

  const persist = () => (queue = queue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await writeJson(file, { enabled, devices })
  }))

  return {
    get enabled() { return enabled },
    async load() {
      try {
        const s = JSON.parse(await fs.readFile(file, 'utf8'))
        enabled = s.enabled === true
        devices = Array.isArray(s.devices) ? s.devices : []
      } catch {}
    },
    async setEnabled(b) { enabled = !!b; await persist() },
    startPairing() {
      const bytes = randomBytes(8)
      const raw = Array.from(bytes, b => ALPHABET[b & 31]).join('')
      pairing = { code: raw, expires: now() + CODE_TTL, tries: 0 }
      return `${raw.slice(0, 4)}-${raw.slice(4)}`
    },
    async pair(input, userAgent) {
      attempts = attempts.filter(t => now() - t < 60000)
      if (attempts.length >= MAX_ATTEMPTS) return null
      attempts.push(now())
      if (!pairing) return null
      if (now() > pairing.expires) { pairing = null; return null }
      const given = Buffer.from(normalize(input).padEnd(8).slice(0, 8))
      const want = Buffer.from(pairing.code)
      if (!timingSafeEqual(given, want) || normalize(input).length !== 8) {
        if (++pairing.tries >= MAX_TRIES) pairing = null
        return null
      }
      pairing = null
      const token = randomBytes(32).toString('base64url')
      const device = { id: randomUUID(), name: deviceName(userAgent), tokenHash: sha(token), created: now(), lastSeen: now() }
      devices.push(device)
      await persist()
      const { tokenHash, ...pub } = device
      return { token, device: pub }
    },
    async check(token) {
      const h = sha(String(token))
      const d = devices.find(x => x.tokenHash === h)
      if (!d) return null
      if (now() - d.lastSeen > 60000) { d.lastSeen = now(); await persist() }
      const { tokenHash, ...pub } = d
      return pub
    },
    async revoke(id) {
      if (!devices.some(d => d.id === id)) return
      devices = devices.filter(d => d.id !== id)
      await persist()
      revokeListeners.forEach(fn => fn(id))
    },
    async revokeAll() { for (const d of [...devices]) await this.revoke(d.id) },
    list() { return devices.map(({ tokenHash, ...pub }) => pub) },
    onRevoke(fn) { revokeListeners.push(fn) },
  }
}

export function createHub({ now = Date.now, idleMs = 900000 } = {}) {
  const clients = new Map()
  const sessions = new Map()
  const routes = new Map()
  const routeKey = (clientId, tab) => `${clientId}:${tab}`

  const deliver = (client, ch, data) => {
    try { if (client.alive()) client.send(ch, data) } catch {}
  }
  const broadcast = (ch, data, exceptId) => {
    for (const c of clients.values()) if (c.id !== exceptId) deliver(c, ch, data)
  }
  const announce = () => broadcast('sessions:changed', {})
  const unsubscribe = (entry, clientId, tab) => {
    for (const s of entry.subs) if (s.client.id === clientId && (tab === undefined || s.tab === tab)) {
      entry.subs.delete(s)
      routes.delete(routeKey(clientId, s.tab))
    }
  }
  const subscribe = (entry, client, tab) => {
    const prev = routes.get(routeKey(client.id, tab))
    if (prev && prev !== entry) unsubscribe(prev, client.id, tab)
    unsubscribe(entry, client.id, tab)
    entry.subs.add({ client, tab })
    routes.set(routeKey(client.id, tab), entry)
  }

  function remove(key) {
    const entry = sessions.get(key)
    if (!entry) return
    for (const s of [...entry.subs]) routes.delete(routeKey(s.client.id, s.tab))
    entry.subs.clear()
    sessions.delete(key)
    announce()
  }

  return {
    connect(client) { clients.set(client.id, client) },
    broadcast,
    get: (clientId, tab) => routes.get(routeKey(clientId, tab)),
    remove,
    drop(clientId) {
      clients.delete(clientId)
      for (const entry of sessions.values()) unsubscribe(entry, clientId)
      announce()
    },
    add(key, client, tab, stop) {
      clients.set(client.id, client)
      const entry = {
        key, stop, info: {}, sessionId: null, busy: false, meta: null, pending: new Map(), subs: new Set(), lastActive: now(),
        emit(ch, data) {
          const was = [entry.sessionId, entry.busy]
          entry.lastActive = now()
          if (ch === 'claude:meta') entry.meta = data
          else if (ch === 'claude:permission') entry.pending.set(data.id, data)
          else if (ch === 'claude:message') {
            const m = data.msg
            if (m?.type === 'system' && m.subtype === 'init') entry.sessionId = m.session_id
            else if (m?.type === 'result') entry.busy = false
          }
          for (const s of entry.subs) deliver(s.client, ch, { tab: s.tab, ...data })
          if (was[0] !== entry.sessionId || was[1] !== entry.busy) announce()
        },
        markBusy() {
          entry.lastActive = now()
          if (!entry.busy) { entry.busy = true; announce() }
        },
        answered(id, byClientId, byTab) {
          if (!entry.pending.delete(id)) return false
          for (const s of entry.subs) if (s.client.id !== byClientId || (byTab !== undefined && s.tab !== byTab)) deliver(s.client, 'claude:permission-done', { tab: s.tab, id })
          return true
        },
      }
      sessions.set(key, entry)
      subscribe(entry, client, tab)
      announce()
      return entry
    },
    attach(client, tab, key) {
      const entry = sessions.get(key)
      if (!entry) return null
      clients.set(client.id, client)
      subscribe(entry, client, tab)
      if (entry.meta) deliver(client, 'claude:meta', { tab, ...entry.meta })
      for (const p of entry.pending.values()) deliver(client, 'claude:permission', { tab, ...p })
      announce()
      const { cwd, model, permissionMode, account } = entry.info
      return { sessionId: entry.sessionId, cwd, model, permissionMode, account, busy: entry.busy }
    },
    detach(clientId, tab) {
      const entry = routes.get(routeKey(clientId, tab))
      if (!entry) return 0
      unsubscribe(entry, clientId, tab)
      announce()
      return entry.subs.size
    },
    list(clientId) {
      return [...sessions.values()].map(e => ({
        key: e.key, sessionId: e.sessionId, cwd: e.info.cwd, model: e.info.model, account: e.info.account, busy: e.busy,
        waiting: e.pending.size > 0,
        here: [...e.subs].some(s => s.client.id === clientId),
      }))
    },
    sweep() {
      const stale = [...sessions.values()].filter(e => !e.subs.size && !e.busy && now() - e.lastActive >= idleMs)
      for (const e of stale) { try { e.stop() } catch {} remove(e.key) }
      return stale.map(e => e.key)
    },
  }
}

export const DEVICE_KEYS = new Set(('theme palette accent accentCustom uiFont proseFont monoFont density radius fontSize chatWidth motion customCss panelWidth sidebar panel panelTab sounds notifications enterSends').split(' '))

export const pickShared = obj => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => !DEVICE_KEYS.has(k) && k !== 'v'))

export function createShared(file) {
  let data = null
  let queue = Promise.resolve()
  return {
    async load() {
      try {
        const s = JSON.parse(await fs.readFile(file, 'utf8'))
        data = s && typeof s === 'object' && !Array.isArray(s) ? s : null
      } catch { data = null }
    },
    get: () => data,
    save(patch) {
      data = { ...(data || {}), ...pickShared(patch) }
      const snapshot = data
      queue = queue.catch(() => {}).then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await writeJson(file, snapshot)
      })
      return queue.then(() => snapshot)
    },
  }
}

export function createOutbox({ max = 5000, maxBytes = 8 << 20 } = {}) {
  let items = []
  let bytes = 0
  let seq = 0
  return {
    push(ch, d) {
      const size = JSON.stringify(d ?? null).length + ch.length
      items.push({ id: ++seq, ch, d, size })
      bytes += size
      while (items.length > 1 && (items.length > max || bytes > maxBytes)) bytes -= items.shift().size
      return seq
    },
    since(lastId) {
      if (lastId > seq) return null
      if (lastId < seq && (!items.length || lastId + 1 < items[0].id)) return null
      return items.filter(e => e.id > lastId)
    },
  }
}

const TYPES = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', json: 'application/json', webmanifest: 'application/manifest+json', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8' }
const typeOf = f => TYPES[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream'
const PUBLIC = new Set(['/ui/pair.html', '/ui/pair.js', '/ui/style.css', '/ui/manifest.webmanifest', '/build/icon.svg', '/build/icon.png'])
const PAGE_RE = /^[\w-]{8,64}$/
const PAGE_TTL = 24 * 3600000

export function createRemoteServer({ appDir, devices, hub, shared, info, call, allowed, onPair, outbox: outboxOptions, bodyLimit = 64 << 20, now = Date.now }) {
  const pkg = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'))
  const roots = ['/ui/', '/build/', '/vendor/', ...Object.keys(pkg.dependencies || {}).filter(d => d !== '@anthropic-ai/claude-agent-sdk').map(d => `/node_modules/${d}/`)]
  const pages = new Map()
  const previews = new Map()
  let server
  let sweeper

  const headers = (res, extra = {}) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v)
  }
  const reply = (res, status, body = '', extra = {}) => {
    headers(res, extra)
    res.statusCode = status
    res.end(body)
  }
  const json = (res, status, obj) => reply(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  const sameOrigin = req => {
    const site = req.headers['sec-fetch-site']
    if (site) return site === 'same-origin'
    try { const host = new URL(req.headers.origin).host; return host === req.headers.host || host === req.headers['x-forwarded-host'] } catch { return false }
  }
  const readBody = (req, limit) => new Promise(resolve => {
    const chunks = []
    let size = 0
    let over = false
    req.on('data', c => {
      size += c.length
      if (size > limit) { over = true; chunks.length = 0 } else if (!over) chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
  const authed = req => {
    const m = /(?:^|;\s*)cd_device=([\w-]+)/.exec(req.headers.cookie || '')
    return m ? devices.check(m[1]) : null
  }

  const writeEvent = (res, id, ch, d) => res.write(`${id === undefined ? '' : `id: ${id}\n`}data: ${JSON.stringify({ ch, d })}\n\n`)

  function pageFor(device, pageId) {
    const id = `p${device.id}:${pageId}`
    let p = pages.get(id)
    if (!p) {
      const outbox = createOutbox(outboxOptions)
      p = { id, deviceId: device.id, outbox, res: null, lastConn: now() }
      p.client = {
        id,
        send: (ch, d) => { const eid = outbox.push(ch, d); if (p.res) writeEvent(p.res, eid, ch, d) },
        alive: () => !!p.res || now() - p.lastConn < PAGE_TTL,
      }
      pages.set(id, p)
      hub.connect(p.client)
    }
    return p
  }
  function dropPage(p) {
    p.res?.end()
    p.res = null
    pages.delete(p.id)
    hub.drop(p.id)
  }

  devices.onRevoke(deviceId => { for (const p of [...pages.values()]) if (p.deviceId === deviceId) dropPage(p) })

  async function serveFile(res, file, extra = {}) {
    let st
    try { st = await fs.stat(file) } catch { return reply(res, 404) }
    if (!st.isFile()) return reply(res, 404)
    reply(res, 200, await fs.readFile(file), { 'Content-Type': typeOf(file), 'Cache-Control': 'no-cache', ...extra })
  }

  async function serveStatic(res, p) {
    const root = roots.find(r => p.startsWith(r))
    if (!root) return reply(res, 404)
    const dir = path.resolve(appDir, root.slice(1))
    const file = path.resolve(appDir, p.slice(1))
    if (!file.startsWith(dir + path.sep)) return reply(res, 404)
    return serveFile(res, file)
  }

  async function pair(req, res) {
    if (!sameOrigin(req)) return reply(res, 403)
    const body = await readBody(req, 4096)
    let code
    try { code = JSON.parse(body).code } catch {}
    const r = typeof code === 'string' ? await devices.pair(code, req.headers['user-agent'] || '') : null
    if (!r) return reply(res, 403)
    onPair?.(r.device)
    reply(res, 204, '', { 'Set-Cookie': `cd_device=${r.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000` })
  }

  async function api(req, res, device, channel) {
    if (req.headers['x-codedesk'] !== '1' || !sameOrigin(req)) return json(res, 403, { error: 'Forbidden' })
    const pageId = req.headers['x-codedesk-page']
    if (!PAGE_RE.test(pageId || '')) return json(res, 400, { error: 'Bad page' })
    if (!allowed.has(channel)) return json(res, 404, { error: 'Unknown channel' })
    const body = await readBody(req, bodyLimit)
    if (body === null) return json(res, 413, { error: 'Request too large' })
    let args
    try { args = JSON.parse(body || '[]') } catch { return json(res, 400, { error: 'Bad JSON' }) }
    if (!Array.isArray(args)) return json(res, 400, { error: 'Bad arguments' })
    const page = pageFor(device, pageId)
    try { json(res, 200, { ok: await call(channel, page.client, args) }) } catch (e) { json(res, 200, { error: String(e?.message || e) }) }
  }

  function events(req, res, device, url) {
    const pageId = url.searchParams.get('page')
    if (!PAGE_RE.test(pageId || '')) return reply(res, 400)
    const prev = url.searchParams.get('prev')
    if (prev && prev !== pageId) { const old = pages.get(`p${device.id}:${prev}`); if (old) dropPage(old) }
    const page = pageFor(device, pageId)
    page.res?.end()
    headers(res, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    res.statusCode = 200
    res.write('retry: 2000\n\n')
    const last = req.headers['last-event-id']
    const missed = page.outbox.since(last === undefined ? 0 : Number(last) || 0)
    if (missed === null) writeEvent(res, undefined, 'remote:resync', {})
    else for (const e of missed) writeEvent(res, e.id, e.ch, e.d)
    page.res = res
    page.lastConn = now()
    const ping = setInterval(() => res.write(': ping\n\n'), 25000)
    res.on('close', () => {
      clearInterval(ping)
      if (page.res === res) { page.res = null; page.lastConn = now() }
    })
  }

  async function index(res) {
    const html = await fs.readFile(path.join(appDir, 'ui/index.html'), 'utf8')
    const out = html
      .replace('</head>', '  <link rel="manifest" href="/ui/manifest.webmanifest">\n</head>')
      .replace('<script', '<script src="/boot.js"></script>\n  <script src="/ui/remote.js"></script>\n  <script')
    reply(res, 200, out, { 'Content-Type': TYPES.html, 'Cache-Control': 'no-store', 'Content-Security-Policy': "frame-ancestors 'none'" })
  }

  async function boot(res) {
    const data = JSON.stringify({ shared: shared.get(), info: await info() }).replace(/</g, '\\u003c')
    reply(res, 200, `window.__codedesk=${data}`, { 'Content-Type': TYPES.js, 'Cache-Control': 'no-store' })
  }

  async function preview(res, url) {
    const sandbox = { 'Content-Security-Policy': 'sandbox allow-scripts', 'Cache-Control': 'no-store' }
    const h = url.searchParams.get('h')
    const f = url.searchParams.get('f')
    if (h && previews.has(h)) return reply(res, 200, previews.get(h), { 'Content-Type': TYPES.html, ...sandbox })
    if (f && path.isAbsolute(f)) return serveFile(res, f, sandbox)
    reply(res, 404)
  }

  async function route(req, res) {
    let url, p
    try { url = new URL(req.url, 'http://x'); p = decodeURIComponent(url.pathname) } catch { return reply(res, 400) }
    if (p.includes('\0')) return reply(res, 400)
    const read = req.method === 'GET' || req.method === 'HEAD'
    if (p === '/pair') {
      if (req.method === 'POST') return pair(req, res)
      if (read) return serveFile(res, path.join(appDir, 'ui/pair.html'), { 'Content-Security-Policy': "frame-ancestors 'none'" })
    }
    if (read && (PUBLIC.has(p) || p.startsWith('/node_modules/@fontsource-variable/'))) return serveStatic(res, p)
    const device = await authed(req)
    if (!device) return p.startsWith('/api/') || p === '/events' ? json(res, 401, { error: 'Not paired' }) : reply(res, 302, '', { Location: '/pair' })
    if (req.method === 'POST' && p.startsWith('/api/')) return api(req, res, device, p.slice(5))
    if (!read) return reply(res, 405)
    if (p === '/') return reply(res, 302, '', { Location: '/ui/index.html' })
    if (p === '/ui/index.html') return index(res)
    if (p === '/boot.js') return boot(res)
    if (p === '/events') return events(req, res, device, url)
    if (p === '/preview') return preview(res, url)
    return serveStatic(res, p)
  }

  return {
    get port() { return server?.address().port },
    listen(port = 4870) {
      const s = server = http.createServer((req, res) => { route(req, res).catch(() => { if (!res.headersSent) reply(res, 500); else res.end() }) })
      sweeper = setInterval(() => { for (const p of [...pages.values()]) if (!p.res && now() - p.lastConn >= PAGE_TTL) dropPage(p) }, 60000)
      sweeper.unref()
      return new Promise((resolve, reject) => {
        s.once('error', e => { clearInterval(sweeper); if (server === s) server = null; reject(e) })
        s.listen(port, '127.0.0.1', resolve)
      })
    },
    async close() {
      clearInterval(sweeper)
      for (const p of [...pages.values()]) dropPage(p)
      const s = server
      server = null
      if (s?.listening) await new Promise(resolve => { s.close(resolve); s.closeAllConnections() })
    },
    previewUrl: file => `/preview?f=${encodeURIComponent(file)}`,
    previewHtml(html) {
      const id = randomUUID()
      previews.set(id, html)
      if (previews.size > 50) previews.delete(previews.keys().next().value)
      return `/preview?h=${id}`
    },
  }
}

export function parseTailscale(statusJson, serveJson, port = 4870) {
  let dnsName
  try { dnsName = JSON.parse(statusJson).Self?.DNSName?.replace(/\.$/, '') || undefined } catch {}
  const serving = typeof serveJson === 'string' && (serveJson.includes(`127.0.0.1:${port}`) || serveJson.includes(`localhost:${port}`))
  return { dnsName, serving }
}

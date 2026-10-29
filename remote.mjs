import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeJson } from './accounts.mjs'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_TTL = 5 * 60000
const MAX_TRIES = 5
const MAX_ATTEMPTS = 10
const sha = s => createHash('sha256').update(s).digest('hex')
const normalize = s => String(s).toUpperCase().replace(/[-\s]/g, '')

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

  const persist = () => (queue = queue.then(async () => {
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
        answered(id, byClientId) {
          if (!entry.pending.delete(id)) return false
          for (const s of entry.subs) if (s.client.id !== byClientId) deliver(s.client, 'claude:permission-done', { tab: s.tab, id })
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

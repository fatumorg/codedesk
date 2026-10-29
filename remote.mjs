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

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDevices, createHub, createOutbox, createRemoteServer, createShared, deviceName, parseTailscale, pickShared } from '../remote.mjs'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'cd-remote-'))
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'

async function devices() {
  const file = path.join(tmp(), 'remote.json')
  const clock = { t: 1e12 }
  const d = createDevices(file, () => clock.t)
  await d.load()
  return { d, file, clock }
}

test('pairing code works once', async () => {
  const { d } = await devices()
  const code = d.startPairing()
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  const r = await d.pair(code.toLowerCase().replace('-', ' '), IPHONE)
  assert.equal(r.device.name, 'iPhone · Safari')
  assert.equal(await d.pair(code, 'x'), null)
})

test('pairing code expires after 5 minutes', async () => {
  const { d, clock } = await devices()
  const code = d.startPairing()
  clock.t += 5 * 60000 + 1
  assert.equal(await d.pair(code, 'x'), null)
})

test('5 wrong tries lock the code', async () => {
  const { d } = await devices()
  const code = d.startPairing()
  for (let i = 0; i < 5; i++) await d.pair('AAAA-AAAA', 'x')
  assert.equal(await d.pair(code, 'x'), null)
})

test('more than 10 attempts a minute are refused', async () => {
  const { d, clock } = await devices()
  for (let i = 0; i < 10; i++) { d.startPairing(); await d.pair('AAAA-AAAA', 'x') }
  assert.equal(await d.pair(d.startPairing(), 'x'), null)
  clock.t += 60001
  assert.ok(await d.pair(d.startPairing(), 'x'))
})

test('token is stored hashed and checks', async () => {
  const { d, file } = await devices()
  const { token, device } = await d.pair(d.startPairing(), 'x')
  assert.ok(!readFileSync(file, 'utf8').includes(token))
  assert.equal((await d.check(token)).id, device.id)
  assert.equal(await d.check('nope'), null)
  assert.equal(d.list()[0].tokenHash, undefined)
})

test('revoke stops the token and notifies', async () => {
  const { d } = await devices()
  const seen = []
  d.onRevoke(id => seen.push(id))
  const { token, device } = await d.pair(d.startPairing(), 'x')
  await d.revoke(device.id)
  assert.equal(await d.check(token), null)
  assert.deepEqual(seen, [device.id])
})

test('revoke all drops every device', async () => {
  const { d } = await devices()
  await d.pair(d.startPairing(), 'x')
  await d.pair(d.startPairing(), 'y')
  await d.revokeAll()
  assert.equal(d.list().length, 0)
})

test('state survives reload', async () => {
  const { d, file } = await devices()
  await d.setEnabled(true)
  await d.pair(d.startPairing(), 'x')
  const d2 = createDevices(file)
  await d2.load()
  assert.equal(d2.enabled, true)
  assert.equal(d2.list().length, 1)
})

test('device names', () => {
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126.0 Mobile Safari/537.36'), 'Android · Chrome')
  assert.equal(deviceName('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'), 'Linux · Firefox')
})

const fake = id => { const log = []; return { id, log, send: (ch, d) => log.push([ch, d]), alive: () => true } }
const last = (c, ch) => c.log.findLast(([x]) => x === ch)?.[1]
const count = (c, ch) => c.log.filter(([x]) => x === ch).length
function rig() {
  const clock = { t: 0 }
  const hub = createHub({ now: () => clock.t, idleMs: 900000 })
  const [a, b, c] = ['a', 'b', 'c'].map(fake)
  for (const x of [a, b, c]) hub.connect(x)
  const r = { hub, clock, a, b, c, stopped: 0, stop: () => { r.stopped++ } }
  return r
}

test('emit fans out with each subscriber tab', () => {
  const { hub, a, b, stop } = rig()
  const e = hub.add('k', a, 't1', stop)
  hub.attach(b, 't9', 'k')
  e.emit('claude:message', { msg: { type: 'x' } })
  assert.equal(last(a, 'claude:message').tab, 't1')
  assert.equal(last(b, 'claude:message').tab, 't9')
})

test('routes resolve per client and tab', () => {
  const { hub, a, b, stop } = rig()
  hub.add('k', a, 't1', stop)
  hub.attach(b, 't9', 'k')
  assert.equal(hub.get('a', 't1').key, 'k')
  assert.equal(hub.get('b', 't9').key, 'k')
  assert.equal(hub.get('b', 't1'), undefined)
})

test('attach replays meta and open permissions to the new subscriber only', () => {
  const { hub, a, c, stop } = rig()
  const e = hub.add('k', a, 't1', stop)
  e.emit('claude:meta', { commands: [1] })
  e.emit('claude:permission', { id: 'p1' })
  hub.attach(c, 't2', 'k')
  assert.equal(last(c, 'claude:permission').id, 'p1')
  assert.equal(last(c, 'claude:meta').tab, 't2')
  assert.equal(count(a, 'claude:permission'), 1)
})

test('first permission answer wins, others are told', () => {
  const { hub, a, b, stop } = rig()
  const e = hub.add('k', a, 't1', stop)
  hub.attach(b, 't9', 'k')
  e.emit('claude:permission', { id: 'p1' })
  assert.equal(e.answered('p1', 'b'), true)
  assert.equal(e.answered('p1', 'a'), false)
  assert.equal(last(a, 'claude:permission-done').id, 'p1')
  assert.equal(last(b, 'claude:permission-done'), undefined)
})

test('another tab of the answering client is told too', () => {
  const { hub, a, stop } = rig()
  const e = hub.add('k', a, 't1', stop)
  hub.attach(a, 't2', 'k')
  e.emit('claude:permission', { id: 'p1' })
  assert.equal(e.answered('p1', 'a', 't2'), true)
  assert.equal(last(a, 'claude:permission-done').tab, 't1')
  assert.equal(count(a, 'claude:permission-done'), 1)
})

test('busy, init and result each announce a change', () => {
  const { hub, a, stop } = rig()
  const e = hub.add('k', a, 't1', stop)
  const n = () => count(a, 'sessions:changed')
  let before = n()
  e.markBusy()
  assert.equal(n(), before + 1)
  before = n()
  e.emit('claude:message', { msg: { type: 'system', subtype: 'init', session_id: 's1' } })
  assert.equal(e.sessionId, 's1')
  assert.equal(n(), before + 1)
  before = n()
  e.emit('claude:message', { msg: { type: 'result' } })
  assert.equal(e.busy, false)
  assert.equal(n(), before + 1)
})

test('dropping a client keeps its session as an orphan', () => {
  const { hub, a, stop } = rig()
  hub.add('k', a, 't1', stop)
  hub.drop('a')
  const [row] = hub.list('z')
  assert.equal(row.key, 'k')
  assert.equal(row.here, false)
})

test('list marks the sessions this client is watching and those waiting for an answer', () => {
  const { hub, a, stop } = rig()
  const e = hub.add('k', a, 't1', stop)
  assert.equal(hub.list('a')[0].here, true)
  assert.equal(hub.list('a')[0].waiting, false)
  e.emit('claude:permission', { id: 'p1' })
  assert.equal(hub.list('z')[0].waiting, true)
  e.answered('p1', 'a')
  assert.equal(hub.list('z')[0].waiting, false)
})

test('sweep stops idle orphans only', () => {
  const r = rig()
  r.hub.add('k', r.a, 't1', r.stop)
  r.hub.drop('a')
  r.clock.t += 900000 - 1
  assert.deepEqual(r.hub.sweep(), [])
  r.clock.t += 1
  assert.deepEqual(r.hub.sweep(), ['k'])
  assert.equal(r.stopped, 1)
  assert.equal(r.hub.list('z').length, 0)
})

test('sweep never stops a busy orphan', () => {
  const r = rig()
  r.hub.add('k2', r.a, 't1', r.stop).markBusy()
  r.hub.drop('a')
  r.clock.t += 10 * 900000
  assert.deepEqual(r.hub.sweep(), [])
})

test('sweep never stops a watched session', () => {
  const r = rig()
  r.hub.add('k', r.a, 't1', r.stop)
  r.clock.t += 10 * 900000
  assert.deepEqual(r.hub.sweep(), [])
})

test('detach reports who is left, remove clears the routes', () => {
  const { hub, a, b, stop } = rig()
  hub.add('k', a, 't1', stop)
  hub.attach(b, 't9', 'k')
  assert.equal(hub.detach('b', 't9'), 1)
  assert.equal(hub.get('b', 't9'), undefined)
  hub.remove('k')
  assert.equal(hub.get('a', 't1'), undefined)
})

test('attach to an unknown session is null', () => {
  const { hub, a } = rig()
  assert.equal(hub.attach(a, 't1', 'nope'), null)
})

test('device keys never get shared', () => {
  assert.deepEqual(pickShared({ theme: 'dark', sidebar: false, workspaces: { '/a': ['/b'] }, v: 2 }), { workspaces: { '/a': ['/b'] } })
})

test('missing shared file reads as null', async () => {
  const s = createShared(path.join(tmp(), 'none.json'))
  await s.load()
  assert.equal(s.get(), null)
})

test('corrupt shared file reads as null and is not overwritten on load', async () => {
  const f = path.join(tmp(), 'shared.json')
  writeFileSync(f, '{"work')
  const s = createShared(f)
  await s.load()
  assert.equal(s.get(), null)
  assert.equal(readFileSync(f, 'utf8'), '{"work')
})

test('shared save merges, skips device keys and persists', async () => {
  const f = path.join(tmp(), 'shared.json')
  const s = createShared(f)
  await s.load()
  await s.save({ pinned: ['x'], theme: 'dark' })
  const merged = await s.save({ account: 'a1' })
  assert.deepEqual(merged, { pinned: ['x'], account: 'a1' })
  const s2 = createShared(f)
  await s2.load()
  assert.deepEqual(s2.get(), { pinned: ['x'], account: 'a1' })
})

const ROOT = path.resolve(import.meta.dirname, '..')

async function boot(t, opts = {}) {
  const dir = tmp()
  const devices = createDevices(path.join(dir, 'remote.json'))
  await devices.load()
  const hub = createHub()
  const shared = createShared(path.join(dir, 'shared.json'))
  await shared.load()
  const clients = []
  const srv = createRemoteServer({
    appDir: ROOT, devices, hub, shared, info: () => ({ home: '/h' }),
    call: async (ch, client, args) => { clients.push(client); return [ch, client.id, args] },
    allowed: new Set(['listDir', 'echo']), ...opts,
  })
  await srv.listen(0)
  t.after(() => srv.close())
  const base = `http://127.0.0.1:${srv.port}`
  const login = async () => {
    const code = devices.startPairing()
    const r = await fetch(base + '/pair', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0], device: devices.list().at(-1) }
  }
  const get = (p, cookie, init = {}) => fetch(base + p, { redirect: 'manual', ...init, headers: { ...(cookie && { cookie }), ...init.headers } })
  const api = (cookie, ch, args = [], headers = {}) => fetch(`${base}/api/${ch}`, {
    method: 'POST', body: JSON.stringify(args),
    headers: { cookie, origin: base, 'x-codedesk': '1', 'x-codedesk-page': 'pg123456', 'content-type': 'application/json', ...headers },
  })
  const sse = (cookie, { page = 'pg123456', lastId } = {}) => {
    const events = []
    const out = { events }
    const req = http.get(`${base}/events?page=${page}`, { headers: { cookie, ...(lastId !== undefined && { 'last-event-id': String(lastId) }) } })
    out.req = req
    out.closed = new Promise(r => req.on('close', r))
    out.status = new Promise(r => req.on('response', res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => {
        buf += c
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (data) events.push({ id: /^id: (.*)$/m.exec(block)?.[1], ...JSON.parse(data) })
        }
      })
      res.on('close', () => out.closed)
      r(res.statusCode)
    }))
    t.after(() => req.destroy())
    return out
  }
  return { srv, devices, hub, base, clients, login, get, api, sse }
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)) }
}

test('outbox caps by count and knows when it is too old', () => {
  const o = createOutbox({ max: 2 })
  o.push('a', 1); o.push('a', 2); o.push('a', 3)
  assert.equal(o.since(0), null)
  assert.deepEqual(o.since(1).map(e => e.id), [2, 3])
  assert.deepEqual(o.since(3), [])
  assert.equal(o.since(9), null)
})

test('outbox caps by bytes', () => {
  const o = createOutbox({ max: 100, maxBytes: 50 })
  o.push('a', 'x'.repeat(30)); o.push('a', 'y'.repeat(30))
  assert.deepEqual(o.since(0), null)
  assert.equal(o.since(1).length, 1)
})

test('without a cookie pages redirect to /pair and api and events are 401', async t => {
  const { get, api, base } = await boot(t)
  const page = await get('/')
  assert.equal(page.status, 302)
  assert.equal(page.headers.get('location'), '/pair')
  assert.equal((await get('/ui/index.html')).status, 302)
  assert.equal((await api('', 'echo')).status, 401)
  assert.equal((await get('/events?page=pg123456')).status, 401)
  assert.equal((await get('/pair')).status, 200)
  assert.equal((await fetch(base + '/ui/pair.js')).status, 200)
})

test('pairing sets a strict HttpOnly cookie and rejects a wrong code', async t => {
  const { login, base, devices } = await boot(t)
  const { r } = await login()
  assert.equal(r.status, 204)
  assert.match(r.headers.get('set-cookie'), /^cd_device=[\w-]{43}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=31536000$/)
  devices.startPairing()
  const bad = await fetch(base + '/pair', { method: 'POST', headers: { origin: base }, body: JSON.stringify({ code: 'AAAA-AAAA' }) })
  assert.equal(bad.status, 403)
  const noOrigin = await fetch(base + '/pair', { method: 'POST', body: JSON.stringify({ code: devices.startPairing() }) })
  assert.equal(noOrigin.status, 403)
})

test('api needs X-Codedesk and the same Origin', async t => {
  const { login, api } = await boot(t)
  const { cookie, device } = await login()
  assert.equal((await api(cookie, 'echo', [], { 'x-codedesk': '' })).status, 403)
  assert.equal((await api(cookie, 'echo', [], { origin: 'https://evil.test' })).status, 403)
  const ok = await api(cookie, 'listDir', ['/'])
  assert.deepEqual(await ok.json(), { ok: ['listDir', `p${device.id}:pg123456`, ['/']] })
})

test('unknown and blocked channels are 404, handler errors come back as { error }', async t => {
  const { login, api } = await boot(t, { call: async () => { throw new Error('boom') } })
  const { cookie } = await login()
  assert.equal((await api(cookie, 'find')).status, 404)
  assert.equal((await api(cookie, 'nope')).status, 404)
  assert.deepEqual(await (await api(cookie, 'echo')).json(), { error: 'boom' })
})

test('api rejects a bad page id', async t => {
  const { login, api } = await boot(t)
  const { cookie } = await login()
  assert.equal((await api(cookie, 'echo', [], { 'x-codedesk-page': '../x' })).status, 400)
})

test('traversal is refused, encoded too', async t => {
  const { login, get } = await boot(t)
  const { cookie } = await login()
  for (const p of ['/ui/../main.mjs', '/ui/%2e%2e/main.mjs', '/ui/..%2fmain.mjs', '/main.mjs', '/package.json', '/node_modules/%40anthropic-ai/claude-agent-sdk/package.json', '/node_modules/marked/../../main.mjs'])
    assert.equal((await get(p, cookie)).status, 404, p)
  assert.equal((await get('/node_modules/marked/lib/marked.umd.js', cookie)).status, 200)
})

test('index.html gets boot and shim before the first script, manifest in head', async t => {
  const { login, get } = await boot(t)
  const { cookie } = await login()
  const r = await get('/ui/index.html', cookie)
  const body = await r.text()
  assert.ok(body.indexOf('/boot.js') < body.indexOf('marked.umd.js'))
  assert.ok(body.indexOf('/ui/remote.js') < body.indexOf('marked.umd.js'))
  assert.ok(body.indexOf('manifest.webmanifest') < body.indexOf('</head>'))
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
})

test('boot.js carries shared settings and info', async t => {
  const { login, get, srv } = await boot(t)
  const { cookie } = await login()
  const body = await (await get('/boot.js', cookie)).text()
  assert.match(body, /^window\.__codedesk=\{"shared":null,"info":\{"home":"\/h"\}\}/)
})

test('events replay after Last-Event-ID', async t => {
  const { login, api, sse, clients } = await boot(t)
  const { cookie } = await login()
  await api(cookie, 'echo')
  for (const n of [1, 2, 3]) clients[0].send('x', { n })
  const s = sse(cookie, { lastId: 1 })
  await until(() => s.events.length >= 2)
  assert.deepEqual(s.events.map(e => [e.id, e.ch, e.d.n]), [['2', 'x', 2], ['3', 'x', 3]])
  clients[0].send('x', { n: 4 })
  await until(() => s.events.length >= 3)
  assert.equal(s.events[2].id, '4')
})

test('events resync when the buffer has passed the client', async t => {
  const { login, api, sse, clients } = await boot(t, { outbox: { max: 2 } })
  const { cookie } = await login()
  await api(cookie, 'echo')
  for (const n of [1, 2, 3]) clients[0].send('x', { n })
  const s = sse(cookie, { lastId: 0 })
  await until(() => s.events.length >= 1)
  assert.equal(s.events[0].ch, 'remote:resync')
})

test('the same page id from another device is a different client', async t => {
  const { login, api, sse, clients } = await boot(t)
  const one = await login()
  const two = await login()
  const a = await (await api(one.cookie, 'echo')).json()
  const b = await (await api(two.cookie, 'echo')).json()
  assert.notEqual(a.ok[1], b.ok[1])
  const s = sse(two.cookie)
  await s.status
  clients.find(c => c.id === a.ok[1]).send('x', { secret: 1 })
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(s.events, [])
})

test('revoking closes an open event stream', async t => {
  const { login, sse, devices } = await boot(t)
  const { cookie, device } = await login()
  const s = sse(cookie)
  assert.equal(await s.status, 200)
  await devices.revoke(device.id)
  await Promise.race([s.closed, new Promise((_, rej) => setTimeout(() => rej(new Error('stream still open')), 2000))])
})

test('a new page load drops the previous page of the same tab', async t => {
  const { login, api, sse, clients, hub } = await boot(t)
  const { cookie, device } = await login()
  await api(cookie, 'echo', [], { 'x-codedesk-page': 'oldpage123' })
  const old = clients.at(-1)
  hub.add('k', old, 't1', () => {})
  const s = sse(cookie, { page: 'newpage123&prev=oldpage123' })
  await s.status
  assert.equal(hub.list(old.id)[0].here, false)
})

test('oversized api body is 413 and the server keeps working', async t => {
  const { login, api } = await boot(t, { bodyLimit: 1024 })
  const { cookie } = await login()
  assert.equal((await api(cookie, 'echo', ['x'.repeat(2000)])).status, 413)
  assert.equal((await api(cookie, 'echo', ['ok'])).status, 200)
})

test('preview is sandboxed', async t => {
  const { login, get, srv } = await boot(t)
  const { cookie } = await login()
  const url = srv.previewHtml('<b>hi</b>')
  const r = await get(url, cookie)
  assert.equal(r.headers.get('content-security-policy'), 'sandbox allow-scripts')
  assert.equal(await r.text(), '<b>hi</b>')
  const f = await get(srv.previewUrl(path.join(ROOT, 'ui/index.html')), cookie)
  assert.equal(f.headers.get('content-security-policy'), 'sandbox allow-scripts')
  assert.equal((await get('/preview', cookie)).status, 404)
  assert.equal((await get('/preview?f=package.json', cookie)).status, 404)
})

test('server can close before listening, listen again after closing, and reports a busy port', async t => {
  const { srv } = await boot(t)
  const base = { appDir: ROOT, devices: createDevices(path.join(tmp(), 'r.json')), hub: createHub(), shared: createShared(path.join(tmp(), 's.json')), info: () => ({}), call: async () => null, allowed: new Set() }
  const fresh = createRemoteServer(base)
  await fresh.close()
  await fresh.listen(0)
  const port = fresh.port
  assert.ok(port > 0)
  await fresh.close()
  await fresh.listen(0)
  await fresh.close()
  const taken = createRemoteServer(base)
  await assert.rejects(taken.listen(srv.port), { code: 'EADDRINUSE' })
})

test('tailscale status is read from the two json outputs', () => {
  const status = JSON.stringify({ Self: { DNSName: 'box.tail1234.ts.net.' } })
  const serve = JSON.stringify({ Web: { 'box.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4870' } } } } })
  assert.deepEqual(parseTailscale(status, serve), { dnsName: 'box.tail1234.ts.net', serving: true })
  assert.deepEqual(parseTailscale(status, '{}'), { dnsName: 'box.tail1234.ts.net', serving: false })
  assert.deepEqual(parseTailscale('not json', null), { dnsName: undefined, serving: false })
})

test('a failed write does not break later writes', async () => {
  const dir = tmp()
  const file = path.join(dir, 'remote.json')
  mkdirSync(path.join(file, 'blocker'), { recursive: true })
  const d = createDevices(file)
  await d.load()
  await assert.rejects(d.setEnabled(true))
  rmSync(file, { recursive: true })
  await d.setEnabled(true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).enabled, true)
  const sfile = path.join(dir, 'shared.json')
  mkdirSync(path.join(sfile, 'blocker'), { recursive: true })
  const sh = createShared(sfile)
  await sh.load()
  await assert.rejects(sh.save({ pinned: ['a'] }))
  rmSync(sfile, { recursive: true })
  await sh.save({ pinned: ['b'] })
  assert.deepEqual(JSON.parse(readFileSync(sfile, 'utf8')), { pinned: ['b'] })
})

test('pairing code accepts the look-alike letters Crockford maps: O is 0, I and L are 1', async () => {
  const { d } = await devices()
  let code
  do code = d.startPairing(); while (!/[01]/.test(code))
  const typed = code.replace(/0/g, 'O').replace(/1/g, 'l')
  assert.ok(await d.pair(typed, 'x'))
})

test('cross-site browser requests are refused, same-origin ones pass even if a tunnel rewrote Host', async t => {
  const { login, base } = await boot(t)
  const { cookie } = await login()
  const post = headers => fetch(`${base}/api/echo`, { method: 'POST', body: '[]', headers: { cookie, 'x-codedesk': '1', 'x-codedesk-page': 'pg123456', 'content-type': 'application/json', ...headers } })
  assert.equal((await post({ origin: base, 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await post({ origin: base, 'sec-fetch-site': 'same-site' })).status, 403)
  assert.equal((await post({ origin: 'https://pc.example.net', 'sec-fetch-site': 'same-origin' })).status, 200)
  assert.equal((await post({ origin: 'https://pc.example.net', 'x-forwarded-host': 'pc.example.net' })).status, 200)
  assert.equal((await post({ origin: 'https://evil.test' })).status, 403)
})

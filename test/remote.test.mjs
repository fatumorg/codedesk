import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDevices, createHub, createShared, deviceName, pickShared } from '../remote.mjs'

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

test('list marks the sessions this client is watching', () => {
  const { hub, a, stop } = rig()
  hub.add('k', a, 't1', stop)
  assert.equal(hub.list('a')[0].here, true)
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

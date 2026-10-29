import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createDevices, deviceName } from '../remote.mjs'

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

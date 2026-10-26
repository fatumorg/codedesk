import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const node = () => ({ append() {}, replaceChildren() {}, classList: { add() {} }, remove() {}, set hidden(v) {}, set textContent(v) {} })
const ctx = vm.createContext({
  settings: { autoContinue: true, continuePrompts: {}, continueFirst: {}, continuePrompt: '', sessionAccounts: {}, projectAccounts: {}, account: 'A' },
  App: { accounts: [{ id: 'A' }, { id: 'B' }], usageByAccount: {} },
  el: node, button: node, icon: node, notify() {}, basename: String, clock: String, until: String, accountName: String, localStorage: { getItem: () => '{}', setItem() {} },
})
vm.runInContext(readFileSync(new URL('../ui/saver.js', import.meta.url), 'utf8') + readFileSync(new URL('../ui/chat.js', import.meta.url), 'utf8') + ';this.Tab = Tab', ctx)

function tab(resets) {
  const t = Object.create(ctx.Tab.prototype)
  Object.assign(t, { sessionId: 's', cwd: '/p', view: { isConnected: true }, sent: [], add() {} })
  t.send = async text => { t.sent.push(text) }
  t.limitReset = async acc => resets[acc]
  return t
}
const flush = () => new Promise(r => setTimeout(r, 0))
const H = 3600e3

test('switching to an account that resets sooner moves the continue time', async () => {
  const t = tab({ A: Date.now() + 5 * H, B: Date.now() + 3 * H })
  await t.scheduleResume(Date.now() + 5 * H, false, 'A')
  ctx.settings.sessionAccounts.s = 'B'
  t.tick(); await flush()
  assert.ok(Math.abs(t.resumeAt - (Date.now() + 3 * H)) < 1000)
  assert.equal(t.resumeAccount, 'B')
  assert.equal(t.sent.length, 0)
  delete ctx.settings.sessionAccounts.s
})

test('switching to an account with room continues right away', async () => {
  const t = tab({ A: Date.now() + 5 * H, B: 0 })
  await t.scheduleResume(Date.now() + 5 * H, false, 'A')
  ctx.settings.sessionAccounts.s = 'B'
  t.tick(); await flush(); await flush()
  assert.equal(t.sent.length, 1)
  delete ctx.settings.sessionAccounts.s
})

test('the continue fires at the reset itself', async () => {
  const t = tab({})
  await t.scheduleResume(Date.now() - 1, false, 'A')
  t.tick(); await flush()
  assert.equal(t.sent.length, 1)
})

test('unknown usage never sends and checks again a minute later', async () => {
  const t = tab({ A: null })
  await t.scheduleResume(0, false, 'A')
  t.tick(); await flush()
  assert.equal(t.sent.length, 0)
  assert.ok(t.resumeUnknown)
  assert.ok(t.resumeAt - Date.now() > 55000)
  t.tick(); await flush()
  assert.equal(t.sent.length, 0)
})

test('room reported right after a rejection counts as unknown', async () => {
  const t = tab({ A: 0 })
  t.rejected = { account: 'A', at: Date.now() }
  await t.scheduleResume(0, false, 'A')
  t.tick(); await flush()
  assert.equal(t.sent.length, 0)
  assert.ok(t.resumeUnknown)
})

test('unreadable usage on the new account keeps the known time', async () => {
  const at = Date.now() + 5 * H
  const t = tab({ A: at, B: null })
  await t.scheduleResume(at, false, 'A')
  ctx.settings.sessionAccounts.s = 'B'
  t.tick(); await flush()
  assert.equal(t.resumeAt, at)
  assert.ok(!t.resumeUnknown)
  assert.ok(t.recheckAfter - Date.now() > 55000)
  delete ctx.settings.sessionAccounts.s
})

test('a failed start does not send or leave the tab busy', async () => {
  const sent = []
  ctx.api = { send: (...a) => sent.push(a) }
  ctx.App.setComposer = () => {}
  const t = Object.create(ctx.Tab.prototype)
  Object.assign(t, { cwd: '/p', busy: false, live: false, sessionId: 's' })
  t.start = async () => { t.live = false; return false }
  await t.send('hello')
  assert.equal(sent.length, 0)
  assert.ok(!t.busy)
})

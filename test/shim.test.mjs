import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = readFileSync(new URL('../ui/remote.js', import.meta.url), 'utf8')

function load({ shared = { pinned: ['x'] }, prev = null, respond = async () => ({ status: 200, body: { ok: 1 } }) } = {}) {
  const calls = []
  const sources = []
  const store = new Map(prev ? [['cdPage', prev]] : [])
  const ctx = {
    __codedesk: { shared, info: { home: '/h' } },
    crypto: webcrypto,
    sessionStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    document: { documentElement: { dataset: {} } },
    location: { href: '/ui/index.html', reload() { ctx.reloaded = true } },
    fetch: async (url, init) => {
      calls.push({ url, init })
      const r = await respond(url, init)
      return { status: r.status, json: async () => r.body }
    },
    EventSource: class { constructor(url) { this.url = url; sources.push(this) } },
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o?.type } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout,
    open: (...a) => { ctx.opened = a },
  }
  ctx.window = ctx
  vm.createContext(ctx)
  vm.runInContext(source, ctx)
  return { ctx, calls, sources, store, api: ctx.api }
}

test('a call posts its arguments with the guard headers and returns the result', async () => {
  const { api, calls, store } = load()
  assert.equal(await api.listDir('/a'), 1)
  assert.equal(calls[0].url, '/api/listDir')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, '["/a"]')
  assert.equal(calls[0].init.headers['x-codedesk'], '1')
  assert.equal(calls[0].init.headers['x-codedesk-page'], store.get('cdPage'))
})

test('a handler error rejects with its message', async () => {
  const { api } = load({ respond: async () => ({ status: 200, body: { error: 'boom' } }) })
  await assert.rejects(api.readFile('/x'), { message: 'boom' })
})

test('a 401 sends the page to /pair', async () => {
  const { api, ctx } = load({ respond: async () => ({ status: 401, body: { error: 'Not paired' } }) })
  api.listDir('/')
  await new Promise(r => setTimeout(r, 10))
  assert.equal(ctx.location.href, '/pair')
})

test('events reach listeners and a resync reloads', () => {
  const { api, sources, ctx } = load()
  const seen = []
  api.on('claude:message', d => seen.push(d))
  sources[0].onmessage({ data: JSON.stringify({ ch: 'claude:message', d: { tab: 't1' } }) })
  sources[0].onmessage({ data: JSON.stringify({ ch: 'other', d: {} }) })
  assert.equal(JSON.stringify(seen), '[{"tab":"t1"}]')
  sources[0].onmessage({ data: JSON.stringify({ ch: 'remote:resync', d: {} }) })
  assert.equal(ctx.reloaded, true)
})

test('each load gets a fresh page id and names the previous one', () => {
  const { sources, store } = load({ prev: 'oldpage-1234' })
  assert.notEqual(store.get('cdPage'), 'oldpage-1234')
  assert.equal(sources[0].url, `/events?page=${store.get('cdPage')}&prev=oldpage-1234`)
  assert.equal(load().sources[0].url.includes('prev='), false)
})

test('desktop-only calls are replaced', async () => {
  const { api, ctx } = load()
  assert.equal(api.pathFor({}), '')
  assert.equal((await api.addAccount()).error, 'Add accounts on the PC: Claude sign-in opens a browser there.')
  assert.equal(await api.find('x'), undefined)
  api.openExternal('https://example.com')
  assert.equal(ctx.opened.join(' '), 'https://example.com _blank noopener')
  ctx.opened = null
  api.openExternal('file:///etc/passwd')
  assert.equal(ctx.opened, null)
})

test('shared settings come from the boot data and remote mode is flagged', () => {
  const { api, ctx } = load({ shared: { pinned: ['x'] } })
  assert.deepEqual(api.shared, { pinned: ['x'] })
  assert.equal(ctx.document.documentElement.dataset.remote, '')
})

test('signing in or out is a PC-only action: the call is not made and the page is told', async () => {
  const { api, ctx, calls } = load()
  const told = []
  ctx.dispatchEvent = e => told.push(e.type)
  ctx.CustomEvent = class { constructor(type) { this.type = type } }
  for (const args of [['auth', 'login'], ['auth', 'logout'], ['mcp', 'login', 'x']]) {
    const r = await api.cli(args)
    assert.equal(r.code, 1)
    assert.equal(r.stderr, 'Add accounts on the PC: Claude sign-in opens a browser there.')
  }
  assert.deepEqual(told, ['pc-only', 'pc-only', 'pc-only'])
  assert.equal(calls.length, 0)
  await api.cli(['--version'])
  assert.equal(calls[0].url, '/api/cli')
})

test('saveFile downloads instead of opening a dialog', async () => {
  const { api, ctx } = load()
  const clicked = []
  ctx.document.createElement = () => ({ click() { clicked.push(this.download) } })
  assert.equal(await api.saveFile('chat.md', '# hi'), true)
  assert.deepEqual(clicked, ['chat.md'])
})

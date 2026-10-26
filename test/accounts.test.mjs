import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { claudeFiles, createAccounts } from '../accounts.mjs'

const loginAs = n => async env => {
  const f = claudeFiles(null, env)
  await writeFile(f.creds, JSON.stringify({ claudeAiOauth: { refreshToken: 'r' + n, subscriptionType: 'max' } }))
  await writeFile(f.config, JSON.stringify({ oauthAccount: { accountUuid: 'u' + n, organizationUuid: 'o', emailAddress: `a${n}@x` } }))
}

test('accounts get their own login and share everything else', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cd-acct-'))
  const main = claudeFiles(home)
  await mkdir(path.join(main.dir, 'projects'), { recursive: true })
  await writeFile(path.join(main.dir, 'projects', 'chat.jsonl'), '{}')
  await writeFile(path.join(main.dir, 'settings.json'), '{}')
  await writeFile(path.join(main.dir, 'daemon.lock'), '')
  await loginAs(1)({ CLAUDE_CONFIG_DIR: main.dir })
  await writeFile(main.config, JSON.stringify({ oauthAccount: { accountUuid: 'u1', organizationUuid: 'o', emailAddress: 'a1@x' }, mcpServers: { m: {} }, projects: { p: {} } }))
  const acc = createAccounts(main, path.join(home, 'accounts'))

  assert.deepEqual((await acc.list()).map(a => [a.id, a.email]), [['system', 'a1@x']])
  assert.match((await acc.add(loginAs(1))).error, /already added/)
  assert.match((await acc.add(async () => ({ stderr: 'cancelled' }))).error, /cancelled/)
  const { id, email } = await acc.add(loginAs(2))
  assert.equal(email, 'a2@x')
  assert.deepEqual((await acc.list()).map(a => a.email), ['a1@x', 'a2@x'])

  assert.deepEqual(await acc.env('system'), {})
  await assert.rejects(acc.env('nope'), /Account not found/)
  await assert.rejects(acc.env('../x'))
  const { CLAUDE_CONFIG_DIR: dir } = await acc.env(id)
  assert.ok((await lstat(path.join(dir, 'projects'))).isSymbolicLink())
  assert.ok((await lstat(path.join(dir, 'settings.json'))).isSymbolicLink())
  assert.ok(!existsSync(path.join(dir, 'daemon.lock')))
  assert.equal(JSON.parse(await readFile(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken, 'r2')
  const cfg = JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8'))
  assert.equal(cfg.oauthAccount.emailAddress, 'a2@x')
  assert.deepEqual(cfg.mcpServers, { m: {} })

  await acc.remove(id)
  assert.ok(!existsSync(dir))
  assert.ok(existsSync(path.join(main.dir, 'projects', 'chat.jsonl')))
  assert.ok(existsSync(path.join(main.dir, 'settings.json')))
  await assert.rejects(acc.remove('system'))
})

test('default paths follow Claude Code', () => {
  assert.deepEqual(claudeFiles('/h'), { dir: '/h/.claude', creds: '/h/.claude/.credentials.json', config: '/h/.claude.json' })
})

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'cd-acct-'))
  const main = claudeFiles(home)
  await mkdir(main.dir, { recursive: true })
  await loginAs(1)({ CLAUDE_CONFIG_DIR: main.dir })
  await writeFile(main.config, JSON.stringify({ oauthAccount: { accountUuid: 'u1', organizationUuid: 'o', emailAddress: 'a1@x' }, mcpServers: { m: {} }, projects: { p: {} } }))
  const acc = createAccounts(main, path.join(home, 'accounts'))
  const { id } = await acc.add(loginAs(2))
  return { main, acc, id, dir: path.join(home, 'accounts', id) }
}

test('accounts keep their record when Claude Code config breaks', async () => {
  const { acc, dir } = await setup()
  await writeFile(path.join(dir, '.claude.json'), '{"oauthAcc')
  let a2 = (await acc.list()).find(a => a.email === 'a2@x')
  assert.equal(a2.signedIn, true)
  await writeFile(path.join(dir, '.claude.json'), '{}')
  a2 = (await acc.list()).find(a => a.email === 'a2@x')
  assert.equal(a2.signedIn, true)
})

test('signed-out accounts stay listed and refuse to run', async () => {
  const { acc, id, dir } = await setup()
  await rm(path.join(dir, '.credentials.json'))
  const a2 = (await acc.list()).find(a => a.id === id)
  assert.equal(a2.signedIn, false)
  assert.equal(typeof a2.signedOutAt, 'number')
  await assert.rejects(acc.env(id), /a2@x is signed out\. Sign in again from the account menu\./)
  await assert.rejects(acc.env('nope'), /Account not found/)
})

test('env leaves an unreadable config alone', async () => {
  const { acc, id, dir } = await setup()
  await writeFile(path.join(dir, '.claude.json'), '{"oauthAcc')
  await acc.env(id)
  assert.equal(await readFile(path.join(dir, '.claude.json'), 'utf8'), '{"oauthAcc')
})

test('concurrent env calls keep the login', async () => {
  const { acc, id, dir } = await setup()
  await Promise.all([acc.env(id), acc.env(id), acc.env(id), acc.list()])
  assert.equal(JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8')).oauthAccount.emailAddress, 'a2@x')
})

test('signing in again revives the signed-out slot', async () => {
  const { acc, id, dir } = await setup()
  await rm(path.join(dir, '.credentials.json'))
  await acc.list()
  assert.deepEqual(await acc.add(loginAs(2)), { id, email: 'a2@x', revived: true })
  const list = await acc.list()
  assert.equal(list.filter(a => a.email === 'a2@x').length, 1)
  assert.equal(list.find(a => a.id === id).signedIn, true)
  assert.equal(list.find(a => a.id === id).signedOutAt, undefined)
  assert.equal((await acc.env(id)).CLAUDE_CONFIG_DIR, dir)
})

test('migrates accounts added before records existed', async () => {
  const { main, acc } = await setup()
  const old = path.join(path.dirname(main.dir), 'accounts', 'legacy')
  await mkdir(old, { recursive: true })
  await loginAs(3)({ CLAUDE_CONFIG_DIR: old })
  assert.ok((await acc.list()).some(a => a.id === 'legacy' && a.email === 'a3@x'))
  assert.equal(JSON.parse(await readFile(path.join(old, 'codedesk.json'), 'utf8')).email, 'a3@x')
})

test('a torn credentials read is not a sign-out', async () => {
  const { acc, id, dir } = await setup()
  await writeFile(path.join(dir, '.credentials.json'), '{"claudeAiOa')
  assert.equal((await acc.list()).find(a => a.id === id).signedIn, true)
  assert.equal((await acc.env(id)).CLAUDE_CONFIG_DIR, dir)
})

test('one broken account folder does not hide the others', async () => {
  const { main, acc, id } = await setup()
  const bad = path.join(path.dirname(main.dir), 'accounts', 'broken')
  await mkdir(path.join(bad, 'codedesk.json'), { recursive: true })
  await loginAs(4)({ CLAUDE_CONFIG_DIR: bad })
  assert.ok((await acc.list()).some(a => a.id === id))
})

test('accounts from before records existed can start before the first list', async () => {
  const { main, acc } = await setup()
  const old = path.join(path.dirname(main.dir), 'accounts', 'legacy')
  await mkdir(old, { recursive: true })
  await loginAs(3)({ CLAUDE_CONFIG_DIR: old })
  assert.equal((await acc.env('legacy')).CLAUDE_CONFIG_DIR, old)
})

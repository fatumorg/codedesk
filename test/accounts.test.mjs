import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
  assert.deepEqual(await acc.env('nope'), {})
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

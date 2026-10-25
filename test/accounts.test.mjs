import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { claudeFiles, createAccounts } from '../accounts.mjs'

const read = f => readFile(f, 'utf8').then(JSON.parse)
const login = (files, n, config) => Promise.all([
  writeFile(files.creds, JSON.stringify({ claudeAiOauth: { refreshToken: 'r' + n, subscriptionType: 'pro' }, mcpOAuth: { keep: 1 } })),
  writeFile(files.config, JSON.stringify({ ...config, oauthAccount: { accountUuid: 'u' + n, organizationUuid: 'o', emailAddress: `a${n}@x` } })),
])

test('captures, switches and forgets accounts without touching other keys', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'cd-acct-'))
  const files = claudeFiles(home, { CLAUDE_CONFIG_DIR: home })
  const acc = createAccounts(files, path.join(home, 'store', 'accounts.json'))

  await login(files, 1, { projects: { p: 1 } })
  assert.deepEqual((await acc.list()).map(a => [a.email, a.active]), [['a1@x', true]])
  await login(files, 2, { projects: { p: 1 } })
  assert.deepEqual((await acc.list()).map(a => [a.email, a.active]), [['a1@x', false], ['a2@x', true]])

  await acc.switchTo('u1/o')
  const [creds, config] = await Promise.all([read(files.creds), read(files.config)])
  assert.equal(creds.claudeAiOauth.refreshToken, 'r1')
  assert.deepEqual(creds.mcpOAuth, { keep: 1 })
  assert.equal(config.oauthAccount.emailAddress, 'a1@x')
  assert.deepEqual(config.projects, { p: 1 })

  await acc.forget('u2/o')
  assert.deepEqual((await acc.list()).map(a => a.email), ['a1@x'])
  await assert.rejects(acc.switchTo('u2/o'))
})

test('default paths follow Claude Code', () => {
  assert.deepEqual(claudeFiles('/h'), { creds: '/h/.claude/.credentials.json', config: '/h/.claude.json' })
})

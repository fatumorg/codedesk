import fs from 'node:fs/promises'
import path from 'node:path'

export function claudeFiles(home, env = {}) {
  const dir = env.CLAUDE_CONFIG_DIR
  return {
    creds: path.join(dir || path.join(home, '.claude'), '.credentials.json'),
    config: dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'),
  }
}

const readJson = f => fs.readFile(f, 'utf8').then(JSON.parse)
async function writeJson(f, data) {
  const tmp = `${f}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmp, f)
}

async function current(files) {
  const [creds, config] = await Promise.all([readJson(files.creds).catch(() => ({})), readJson(files.config).catch(() => ({}))])
  const oauth = creds.claudeAiOauth, acct = config.oauthAccount
  if (!oauth?.refreshToken || !acct?.accountUuid) return null
  return { id: `${acct.accountUuid}/${acct.organizationUuid}`, oauth, account: acct }
}

export function createAccounts(files, storeFile) {
  let queue = Promise.resolve()
  const locked = fn => (queue = queue.then(fn, fn))
  const load = () => readJson(storeFile).catch(() => ({}))
  const save = async store => { await fs.mkdir(path.dirname(storeFile), { recursive: true }); await writeJson(storeFile, store) }
  const capture = async store => {
    const c = await current(files)
    if (c) store[c.id] = { oauth: c.oauth, account: c.account }
    return c?.id
  }
  const summary = (store, active) => Object.entries(store).map(([id, { oauth, account }]) => ({
    id, active: id === active, email: account.emailAddress, org: account.organizationName, plan: oauth.subscriptionType,
  }))

  return {
    list: () => locked(async () => {
      const store = await load()
      const active = await capture(store)
      if (active) await save(store)
      return summary(store, active)
    }),
    switchTo: id => locked(async () => {
      const store = await load()
      const active = await capture(store)
      const next = store[id]
      if (!next) throw new Error('Unknown account')
      await save(store)
      if (id === active) return
      const [creds, config] = await Promise.all([readJson(files.creds).catch(() => ({})), readJson(files.config).catch(() => ({}))])
      await writeJson(files.creds, { ...creds, claudeAiOauth: next.oauth })
      await writeJson(files.config, { ...config, oauthAccount: next.account })
    }),
    forget: id => locked(async () => {
      const store = await load()
      delete store[id]
      await save(store)
    }),
    activeId: () => current(files).then(c => c?.id),
  }
}

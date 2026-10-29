import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function claudeFiles(home, env = {}) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  return {
    dir,
    creds: path.join(dir, '.credentials.json'),
    config: env.CLAUDE_CONFIG_DIR ? path.join(dir, '.claude.json') : path.join(home, '.claude.json'),
  }
}

const SHARED_SKIP = /^(\.credentials\.json|\.claude\.json|codedesk\.json|daemon.*|.*\.lock)$/
const readJson = f => fs.readFile(f, 'utf8').then(JSON.parse).catch(() => ({}))
const readJsonOrNull = f => fs.readFile(f, 'utf8').then(JSON.parse, e => (e.code === 'ENOENT' ? {} : null)).catch(() => null)
export async function writeJson(f, data) {
  const tmp = `${f}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await fs.rename(tmp, f)
}

async function profile(files) {
  const [creds, config] = await Promise.all([readJson(files.creds), readJson(files.config)])
  const oauth = creds.claudeAiOauth, a = config.oauthAccount
  if (!oauth?.refreshToken || !a?.accountUuid) return null
  return { key: `${a.accountUuid}/${a.organizationUuid}`, email: a.emailAddress, org: a.organizationName, plan: oauth.subscriptionType }
}

const signedIn = async files => { const c = await readJsonOrNull(files.creds); return c === null || !!c.claudeAiOauth?.refreshToken }

export function createAccounts(main, root) {
  const filesOf = id => {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid account id')
    return claudeFiles(null, { CLAUDE_CONFIG_DIR: path.join(root, id) })
  }
  const recordFile = id => path.join(filesOf(id).dir, 'codedesk.json')
  const record = async id => { const r = await readJsonOrNull(recordFile(id)); return r?.key ? r : null }
  const chains = new Map()
  const serial = (id, fn) => {
    const next = (chains.get(id) || Promise.resolve()).then(fn, fn)
    chains.set(id, next.catch(() => {}))
    return next
  }

  async function entry(id) {
    return serial(id, async () => {
      const files = filesOf(id)
      const [p, on] = await Promise.all([profile(files), signedIn(files)])
      const rec = await record(id)
      if (!rec && !p) return null
      const next = { ...rec, ...(p && { key: p.key, email: p.email, org: p.org, plan: p.plan }) }
      if (on) delete next.signedOutAt
      else next.signedOutAt ??= Date.now()
      if (JSON.stringify(next) !== JSON.stringify(rec)) await writeJson(recordFile(id), next)
      return { id, ...next, signedIn: on }
    })
  }

  async function list() {
    const ids = await fs.readdir(root).catch(() => [])
    const added = await Promise.all(ids.filter(id => /^[\w-]+$/.test(id)).map(id => entry(id).catch(async () => {
      const rec = await record(id).catch(() => null)
      return rec && { id, ...rec, signedIn: true }
    })))
    const system = { id: 'system', ...(await profile(main)), signedIn: await signedIn(main) }
    return [system, ...added.filter(a => a && a.key !== system.key)]
  }

  async function remove(id) {
    if (id === 'system') throw new Error('The system account is managed by `claude auth`')
    const { dir } = filesOf(id)
    for (const d of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) if (d.isSymbolicLink()) await fs.unlink(path.join(dir, d.name))
    await fs.rm(dir, { recursive: true, force: true })
  }

  return {
    list,
    remove,
    async add(login) {
      const before = await list()
      const id = randomUUID(), files = filesOf(id)
      await fs.mkdir(files.dir, { recursive: true, mode: 0o700 })
      const r = await login({ CLAUDE_CONFIG_DIR: files.dir })
      const p = await profile(files)
      const same = p && before.find(a => a.key === p.key)
      if (same && !same.signedIn && same.id !== 'system') {
        const old = filesOf(same.id)
        await serial(same.id, async () => {
          await fs.rename(files.creds, old.creds)
          await fs.rename(files.config, old.config)
        })
        await remove(id)
        await entry(same.id)
        return { id: same.id, email: p.email, revived: true }
      }
      if (p && !same) {
        await writeJson(recordFile(id), { key: p.key, email: p.email, org: p.org, plan: p.plan })
        return { id, email: p.email }
      }
      await remove(id)
      return { error: same ? `${p.email} is already added` : r?.stderr?.trim() || 'Sign-in did not finish' }
    },
    async env(id) {
      if (!id || id === 'system') return {}
      const files = filesOf(id)
      const rec = (await record(id)) || (await entry(id).catch(() => null))
      if (!rec) throw new Error('Account not found')
      if (!(await signedIn(files))) throw new Error(`${rec.email} is signed out. Sign in again from the account menu.`)
      return serial(id, async () => {
        for (const d of await fs.readdir(main.dir, { withFileTypes: true }).catch(() => [])) {
          if (SHARED_SKIP.test(d.name)) continue
          await fs.symlink(path.join(main.dir, d.name), path.join(files.dir, d.name), d.isDirectory() ? 'junction' : 'file').catch(() => {})
        }
        const [shared, own] = await Promise.all([readJson(main.config), readJsonOrNull(files.config)])
        const differs = JSON.stringify(own?.mcpServers) !== JSON.stringify(shared.mcpServers) || JSON.stringify(own?.projects) !== JSON.stringify(shared.projects)
        if (own && differs) await writeJson(files.config, { ...own, mcpServers: shared.mcpServers, projects: shared.projects })
        return { CLAUDE_CONFIG_DIR: files.dir }
      })
    },
  }
}

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

const SHARED_SKIP = /^(\.credentials\.json|\.claude\.json|daemon.*|.*\.lock)$/
const readJson = f => fs.readFile(f, 'utf8').then(JSON.parse).catch(() => ({}))
async function writeJson(f, data) {
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

export function createAccounts(main, root) {
  const filesOf = id => {
    if (!/^[\w-]+$/.test(id)) throw new Error('Invalid account id')
    return claudeFiles(null, { CLAUDE_CONFIG_DIR: path.join(root, id) })
  }

  async function list() {
    const ids = await fs.readdir(root).catch(() => [])
    const added = await Promise.all(ids.map(async id => ({ id, ...(await profile(filesOf(id))) })))
    return [{ id: 'system', ...(await profile(main)) }, ...added.filter(a => a.key)]
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
      const dupe = p && before.find(a => a.key === p.key)
      if (p && !dupe) return { id, email: p.email }
      await remove(id)
      return { error: dupe ? `${p.email} is already added` : r?.stderr?.trim() || 'Sign-in did not finish' }
    },
    async env(id) {
      if (!id || id === 'system') return {}
      const files = filesOf(id)
      if (!(await profile(files))) return {}
      for (const d of await fs.readdir(main.dir, { withFileTypes: true }).catch(() => [])) {
        if (SHARED_SKIP.test(d.name)) continue
        await fs.symlink(path.join(main.dir, d.name), path.join(files.dir, d.name), d.isDirectory() ? 'junction' : 'file').catch(() => {})
      }
      const [shared, own] = await Promise.all([readJson(main.config), readJson(files.config)])
      await writeJson(files.config, { ...own, mcpServers: shared.mcpServers, projects: shared.projects })
      return { CLAUDE_CONFIG_DIR: files.dir }
    },
  }
}

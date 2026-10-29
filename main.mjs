import { deleteSession, forkSession, getSessionMessages, listSessions, query, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { claudeFiles, createAccounts } from './accounts.mjs'
import { agyArgs, finishTurn, newTurnState, parseAgyModels, parseLine, translateAgyEvent } from './agy.mjs'
import { createHub, createShared, pickShared } from './remote.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appUrl = pathToFileURL(path.join(here, 'ui/index.html')).href
const hub = createHub()
const handlers = new Map()
const winClients = new Map()
const winClient = wc => {
  let c = winClients.get(wc.id)
  if (!c) {
    c = { id: 'w' + wc.id, wc, send: (ch, d) => wc.send(ch, d), alive: () => !wc.isDestroyed() }
    winClients.set(wc.id, c)
    hub.connect(c)
  }
  return c
}
const handle = (ch, fn) => {
  handlers.set(ch, fn)
  ipcMain.handle(ch, (e, ...a) => {
    if (e.senderFrame !== e.sender.mainFrame || !e.senderFrame.url.startsWith(appUrl)) throw new Error('Blocked IPC from untrusted frame')
    return fn(winClient(e.sender), ...a)
  })
}
const win32 = process.platform === 'win32'

function findBin(name) {
  const envKey = name.toUpperCase() + '_PATH'
  if (process.env[envKey]) return process.env[envKey]
  const h = homedir()
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(h, '.local/bin'), path.join(h, '.claude/local'), path.join(h, '.nix-profile/bin'),
    '/run/current-system/sw/bin', '/etc/profiles/per-user/' + (process.env.USER || '') + '/bin',
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ]
  for (const d of dirs) {
    const p = path.join(d, win32 ? `${name}.exe` : name)
    try { if (d && statSync(p).isFile()) return p } catch {}
  }
}
const claudePath = findBin('claude')
const agyPath = findBin('agy')

const run = (cmd, args, opts = {}) => new Promise(resolve =>
  execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 120000, ...opts }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })))

const sessions = new Map()
const route = (client, tab) => {
  const entry = hub.get(client.id, tab)
  return entry && sessions.get(entry.key)
}
const isGemini = m => /^gemini/i.test(m || '')

const storePath = () => path.join(app.getPath('userData'), 'agy-sessions.json')
async function readGeminiStore() {
  try { return JSON.parse(await fs.readFile(storePath(), 'utf8')) } catch { return {} }
}
let storeQueue = Promise.resolve()
const updateStore = fn => (storeQueue = storeQueue.then(async () => {
  const all = await readGeminiStore()
  const r = await fn(all)
  await fs.mkdir(path.dirname(storePath()), { recursive: true })
  await fs.writeFile(storePath(), JSON.stringify(all))
  return r
}))

let agyModelList
const getAgyModels = fresh => (!fresh && agyModelList) || (agyModelList = agyPath
  ? run(agyPath, ['models'], { timeout: 20000 }).then(r => (r.code ? [] : parseAgyModels(r.stdout)))
  : Promise.resolve([]))

handle('googleStatus', async () => {
  const models = await getAgyModels(true)
  return { installed: !!agyPath, loggedIn: models.length > 0, models }
})

async function runGeminiTurn(s, send, msg) {
  const c = msg.message.content
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : c || []
  s.history.push({ type: 'user', uuid: msg.uuid || crypto.randomUUID(), message: { role: 'user', content: blocks } })
  if (msg.shouldQuery === false) return
  const startTs = Date.now()
  const st = newTurnState(s.conversationId, s.tokensUsed)
  const emit = m => { if (m.type === 'assistant' || m.type === 'user') s.history.push(m); send('claude:message', { msg: m }) }
  s.aborted = false
  let code = 0
  try {
    if (!agyPath) throw new Error('Antigravity CLI (agy) is not installed. Install: curl -fsSL https://antigravity.google/cli/install.sh | bash')
    const prompt = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
    const child = s.child = spawn(agyPath, agyArgs({ prompt, model: s.model, permissionMode: s.permissionMode, conversationId: s.conversationId }), { cwd: s.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = new Promise(resolve => {
      child.on('error', e => { st.error ||= String(e.message || e); resolve(-1) })
      child.on('close', resolve)
    })
    createInterface({ input: child.stderr }).on('line', line => send('claude:stderr', { line }))
    for await (const line of createInterface({ input: child.stdout })) translateAgyEvent(parseLine(line), st).forEach(emit)
    code = await exited
  } catch (e) {
    st.error ||= String(e?.message || e)
  }
  s.child = null
  finishTurn(st).forEach(emit)
  s.conversationId = st.conversationId
  s.tokensUsed = st.tokens
  if (!st.error && code && !s.aborted) st.error = `agy exited with code ${code}`
  const failed = !!st.error && !s.aborted
  await updateStore(all => {
    const prev = all[s.sessionId] || {}
    const first = (blocks.find(b => b.type === 'text')?.text || 'Gemini').slice(0, 80)
    all[s.sessionId] = {
      sessionId: s.sessionId, cwd: s.cwd, model: s.model, conversationId: s.conversationId,
      customTitle: prev.customTitle, summary: prev.summary || first, firstPrompt: prev.firstPrompt || first,
      lastModified: Date.now(), messages: s.history, tokensUsed: s.tokensUsed,
    }
  })
  if (failed) send('claude:error', { error: st.error })
  send('claude:message', { msg: { type: 'result', subtype: failed ? 'error' : 'success', is_error: failed, result: failed ? st.error : undefined, duration_ms: Date.now() - startTs, num_turns: 1, total_cost_usd: 0 } })
}

function restartTab(client, tab) {
  const prev = hub.get(client.id, tab)
  if (!prev) return
  hub.detach(client.id, tab)
  stopSession(prev.key)
}

function leaveTab(client, tab) {
  const entry = hub.get(client.id, tab)
  if (entry && hub.detach(client.id, tab) === 0) stopSession(entry.key)
}

async function startGeminiSession(client, tab, opts) {
  restartTab(client, tab)
  const store = await readGeminiStore()
  const existing = opts.resume && store[opts.resume]
  const key = crypto.randomUUID()
  const entry = hub.add(key, client, tab, () => stopSession(key))
  entry.info = { cwd: opts.cwd, model: opts.model, permissionMode: opts.permissionMode || 'default', account: opts.account }
  const send = (ch, data) => entry.emit(ch, data)
  const s = {
    key,
    entry,
    isGemini: true,
    account: opts.account,
    sessionId: existing ? opts.resume : crypto.randomUUID(),
    cwd: opts.cwd,
    model: opts.model,
    permissionMode: opts.permissionMode || 'default',
    conversationId: existing?.conversationId || null,
    history: existing?.messages || [],
    tokensUsed: existing?.tokensUsed || 0,
    pending: new Map(),
    closed: false,
    aborted: false,
    child: null,
    chain: Promise.resolve(),
    push: msg => { if (!s.closed && msg?.message) s.chain = s.chain.then(() => runGeminiTurn(s, send, msg)).catch(e => send('claude:error', { error: String(e?.message || e) })) },
    q: {
      close: () => { s.aborted = true; s.child?.kill() },
      interrupt: async () => { s.aborted = true; s.child?.kill() },
      setModel: async m => { s.model = m },
      setPermissionMode: async m => { s.permissionMode = m },
      getContextUsage: async () => ({
        percentage: Math.min(100, (s.tokensUsed / 1048576) * 100),
        maxTokens: 1048576,
        model: s.model,
        categories: [
          { name: 'Conversation', kind: 'messages', tokens: s.tokensUsed },
          { name: 'Free', kind: 'free', tokens: Math.max(0, 1048576 - s.tokensUsed) },
        ],
      }),
      mcpServerStatus: async () => [],
    },
  }
  sessions.set(key, s)
  send('claude:meta', { commands: [], models: await getAgyModels(), agents: [] })
  send('claude:message', {
    msg: {
      type: 'system', subtype: 'init', session_id: s.sessionId,
      mcp_servers: [], skills: [], model: s.model,
      claude_code_version: 'Antigravity CLI',
      output_style: 'default', permissionMode: s.permissionMode, slash_commands: [],
    },
  })
  return key
}

function saverOptions(saver = {}, accountEnv) {
  const extra = { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' }
  if (['sonnet', 'haiku'].includes(saver.subagentModel)) extra.CLAUDE_CODE_SUBAGENT_MODEL = saver.subagentModel
  const pct = +saver.compactAt
  if (saver.compactAt && Number.isInteger(pct) && pct >= 1 && pct <= 100) extra.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(pct)
  const turns = +saver.maxTurns
  return {
    env: { ...process.env, ...extra, ...accountEnv },
    ...(saver.maxTurns && Number.isInteger(turns) && turns > 0 && { maxTurns: turns }),
    ...(saver.noSubagents === true && { disallowedTools: ['Agent', 'Task'] }),
  }
}

async function startSession(client, tab, opts) {
  const { cwd, resume, model, permissionMode, effort, additionalDirectories, forkSession: fork, resumeSessionAt } = opts
  if (!existsSync(cwd)) return client.send('claude:error', { tab, error: `Project folder not found: ${cwd}` })
  if (isGemini(model)) return startGeminiSession(client, tab, opts)
  const accountEnv = await accounts().env(opts.account)
  restartTab(client, tab)
  const key = crypto.randomUUID()
  const entry = hub.add(key, client, tab, () => stopSession(key))
  entry.info = { cwd, model, permissionMode: permissionMode || 'default', account: opts.account, effort }
  if (resume && !fork) { entry.sessionId = resume; hub.broadcast('sessions:changed', {}) }
  const inbox = []
  let wake = null
  const pending = new Map()
  const s = { key, entry, q: null, pending, closed: false, account: opts.account, push: m => { inbox.push(m); wake?.() } }
  async function* prompts() {
    while (!s.closed) {
      if (inbox.length) yield inbox.shift()
      else await new Promise(r => (wake = r))
    }
  }
  const send = (ch, data) => entry.emit(ch, data)

  s.q = query({
    prompt: prompts(),
    options: {
      cwd,
      resume: resume || undefined,
      forkSession: fork || undefined,
      resumeSessionAt: resumeSessionAt || undefined,
      model: model || undefined,
      effort: effort || undefined,
      additionalDirectories: additionalDirectories?.length ? additionalDirectories : undefined,
      permissionMode: permissionMode || 'default',
      pathToClaudeCodeExecutable: claudePath,
      includePartialMessages: true,
      promptSuggestions: true,
      enableFileCheckpointing: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      ...saverOptions(opts.saver, accountEnv),
      settingSources: ['user', 'project', 'local'],
      stderr: line => send('claude:stderr', { line }),
      canUseTool: (toolName, input, { signal, suggestions, decisionReason, title }) =>
        new Promise(resolve => {
          const id = crypto.randomUUID()
          pending.set(id, resolve)
          signal.addEventListener('abort', () => { pending.delete(id); entry.pending.delete(id); resolve({ behavior: 'deny', message: 'Aborted' }) })
          send('claude:permission', { id, toolName, input, suggestions, decisionReason, title })
        }),
    },
  })
  sessions.set(key, s)

  ;(async () => {
    try {
      for await (const msg of s.q) { if (s.closed) break; send('claude:message', { msg }) }
    } catch (e) {
      if (!s.closed) send('claude:error', { error: String(e?.message || e) })
    }
    if (!s.closed) { sessions.delete(key); send('claude:ended', {}); hub.remove(key) }
  })()

  Promise.all([s.q.supportedCommands(), s.q.supportedModels(), s.q.supportedAgents().catch(() => []), getAgyModels()])
    .then(([commands, models, agents, gm]) => send('claude:meta', { commands, models: [...gm, ...(models || [])], agents }))
    .catch(() => send('claude:meta', { commands: [], models: [], agents: [] }))
  return key
}

function stopSession(key) {
  const s = sessions.get(key)
  if (!s) return
  s.closed = true
  for (const r of s.pending.values()) r({ behavior: 'deny', message: 'Session closed' })
  if (!s.isGemini) s.push(null)
  try { s.q.close() } catch {}
  sessions.delete(key)
  s.entry.emit('claude:ended', {})
  hub.remove(key)
}

const CONTROL = new Set(['interrupt', 'setModel', 'setPermissionMode', 'setMaxThinkingTokens', 'applyFlagSettings',
  'mcpServerStatus', 'reconnectMcpServer', 'toggleMcpServer', 'getContextUsage', 'accountInfo', 'rewindFiles',
  'stopTask', 'reloadSkills', 'reloadPlugins'])

handle('start', (client, tab, opts) => startSession(client, tab, opts))
handle('stop', (client, tab) => leaveTab(client, tab))
handle('send', (client, tab, msg) => {
  const s = route(client, tab)
  if (!s) return
  if (msg?.shouldQuery !== false) s.entry.markBusy()
  s.push({ type: 'user', parent_tool_use_id: null, ...msg })
})
handle('control', async (client, tab, method, ...args) => {
  const s = route(client, tab)
  if (!s || !CONTROL.has(method)) return null
  if (method === 'setModel' && isGemini(args[0]) !== !!s.isGemini) {
    startSession(client, tab, { ...s.entry.info, model: args[0] })
    return null
  }
  if (method === 'setModel') s.entry.info.model = args[0]
  if (method === 'setPermissionMode') s.entry.info.permissionMode = args[0]
  return s.q[method]?.(...args) ?? null
})
handle('permit', (client, tab, id, result) => {
  const s = route(client, tab), r = s?.pending.get(id)
  if (r && s.entry.answered(id, client.id, tab)) { s.pending.delete(id); r(result) }
})
handle('liveSessions', client => hub.list(client.id))
handle('attach', (client, tab, key) => {
  const entry = hub.get(client.id, tab)
  if (entry && entry.key !== key) leaveTab(client, tab)
  return hub.attach(client, tab, key)
})
handle('detach', (client, tab) => { leaveTab(client, tab) })

const idle = new Promise(() => {})
const probes = new Map(), fresh = new Map()
const readUsage = (q, full) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: !full }).catch(() => null)
function probeUsage(account, full) {
  const k = `${account || 'system'}:${!!full}`
  const hit = fresh.get(k)
  if (hit && Date.now() - hit.at < 60000) return hit.u
  if (!probes.has(k)) probes.set(k, (async () => {
    let q
    try {
      q = query({ prompt: (async function* () { await idle })(), options: { cwd: homedir(), pathToClaudeCodeExecutable: claudePath, env: { ...process.env, ...(await accounts().env(account)) } } })
      const u = await readUsage(q, full)
      if (u) fresh.set(k, { u, at: Date.now() })
      return u
    } catch { return null }
    finally { q?.close(); probes.delete(k) }
  })())
  return probes.get(k)
}
handle('usage', async (client, tab, full, account) => {
  const own = route(client, tab)
  const live = full && own && !own.isGemini && !own.closed && (own.account || 'system') === (account || 'system') ? own : null
  const [u, mine] = await Promise.all([probeUsage(account, full), live ? readUsage(live.q, true) : null])
  return u && mine?.session ? { ...u, session: mine.session } : u
})

handle('listSessions', async (_, dir) => {
  const [claudeList, gStore] = await Promise.all([
    listSessions({ dir, limit: 200 }).catch(() => []),
    readGeminiStore(),
  ])
  const gList = Object.values(gStore).filter(s => !dir || s.cwd === dir)
  return [...gList, ...claudeList].sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
})
handle('history', async (_, id, dir) => {
  const live = [...sessions.values()].find(s => s.isGemini && s.sessionId === id)
  if (live) return live.history
  const gStore = await readGeminiStore()
  if (gStore[id]) return gStore[id].messages || []
  return getSessionMessages(id, { dir }).catch(() => [])
})
handle('renameSession', async (_, id, title, dir) => {
  if (await updateStore(all => { if (!all[id]) return false; all[id].customTitle = title; return true })) return
  return renameSession(id, title, { dir })
})
handle('deleteSession', async (_, id, dir) => {
  if (await updateStore(all => { if (!all[id]) return false; delete all[id]; return true })) return
  return deleteSession(id, { dir })
})
handle('forkSession', async (_, id, dir, upToMessageId) => {
  if ((await readGeminiStore())[id]) throw new Error('Fork is not available for Gemini conversations')
  return forkSession(id, { dir, upToMessageId })
})

const SKIP = new Set(['.git', 'node_modules', '.direnv', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', 'result'])

handle('listDir', async (_, dir) => {
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return ents.map(d => ({ name: d.name, dir: d.isDirectory() }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name))
})

handle('listFiles', async (_, cwd) => {
  const g = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd })
  if (!g.code) return g.stdout.split('\n').filter(Boolean).slice(0, 50000)
  const out = []
  async function walk(rel) {
    if (out.length > 20000) return
    for (const d of await fs.readdir(path.join(cwd, rel), { withFileTypes: true }).catch(() => [])) {
      if (SKIP.has(d.name)) continue
      const r = rel ? rel + '/' + d.name : d.name
      if (d.isDirectory()) await walk(r)
      else out.push(r)
    }
  }
  await walk('')
  return out
})

handle('readFile', async (_, file) => {
  const st = await fs.stat(file)
  const ext = path.extname(file).slice(1).toLowerCase()
  const img = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }[ext]
  if (st.size > 5 << 20) return { tooBig: true, size: st.size }
  const buf = await fs.readFile(file)
  if (img) return { image: `data:${img};base64,${buf.toString('base64')}`, text: ext === 'svg' ? buf.toString() : undefined }
  if (buf.subarray(0, 8000).includes(0)) return { binary: true, size: st.size }
  return { text: buf.toString() }
})

handle('createFile', async (_, file, content) => {
  try { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content, { flag: 'wx' }) }
  catch (e) { return { error: e.code === 'EEXIST' ? 'That file already exists' : String(e.message) } }
})
handle('writeFile', (_, file, content) => fs.writeFile(file, content))
handle('git', (_, cwd, args) => run('git', args, { cwd }))
handle('runShell', (_, cwd, command) =>
  run(win32 ? 'powershell.exe' : process.env.SHELL || '/bin/sh', win32 ? ['-NoProfile', '-Command', command] : ['-c', command], { cwd }))
handle('cli', (_, args) => run(claudePath || 'claude', args, { timeout: 600000 }))
let accountStore
const accounts = () => (accountStore ||= createAccounts(claudeFiles(homedir(), process.env), path.join(app.getPath('userData'), 'accounts')))
handle('accounts', () => accounts().list())
handle('addAccount', () => accounts().add(env => run(claudePath || 'claude', ['auth', 'login'], { timeout: 600000, env: { ...process.env, ...env } })))
handle('removeAccount', (_, id) => accounts().remove(id))
handle('appendMemory', async (_, file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const prev = await fs.readFile(file, 'utf8').catch(() => '')
  await fs.appendFile(file, (prev && !prev.endsWith('\n') ? '\n' : '') + '- ' + text + '\n')
})
let tempSeq = 0, tempDir
handle('writeTemp', async (_, html) => {
  tempDir ||= await fs.mkdtemp(path.join(tmpdir(), 'codedesk-'))
  const file = path.join(tempDir, `preview-${++tempSeq}.html`)
  await fs.writeFile(file, html)
  return pathToFileURL(file).href
})
handle('fileUrl', (_, p) => pathToFileURL(p).href)
handle('openPath', (_, p) => shell.openPath(p))
handle('openInEditor', (_, cmd, file, line) => {
  const [bin, ...args] = (cmd || '').trim().split(/\s+/).filter(Boolean)
  if (!bin) return shell.openPath(file)
  const target = line ? `${file}:${line}` : file
  const p = spawn(bin, [...args, ...(/^(code|cursor|codium|windsurf|zed)$/.test(path.basename(bin)) && line ? ['-g'] : []), target], { detached: true, stdio: 'ignore', shell: win32 })
  p.on('error', () => shell.openPath(file))
  p.unref()
})
handle('showItem', (_, p) => shell.showItemInFolder(p))
handle('openExternal', (_, url) => /^https?:\/\//.test(url) && shell.openExternal(url))
handle('pickFolder', async client => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(client.wc), { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
handle('saveFile', async (client, name, content) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(client.wc), { defaultPath: name })
  if (!r.canceled) await fs.writeFile(r.filePath, content)
  return !r.canceled
})
handle('find', (client, text, opts) => text ? client.wc.findInPage(text, opts) : client.wc.stopFindInPage('clearSelection'))
handle('info', () => ({ claudePath: claudePath || 'bundled', agyPath: agyPath || null, home: homedir(), platform: process.platform, version: app.getVersion() }))

handle('statusLine', async (_, input) => {
  const settings = JSON.parse(await fs.readFile(path.join(homedir(), '.claude/settings.json'), 'utf8').catch(() => '{}'))
  const cmd = settings.statusLine?.type === 'command' && settings.statusLine.command
  if (!cmd) return null
  return new Promise(resolve => {
    const p = spawn(cmd, { shell: true, cwd: input.cwd, timeout: 5000 })
    let out = ''
    p.stdout.on('data', d => (out += d))
    p.on('close', () => resolve(out.replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n')[0]))
    p.on('error', () => resolve(null))
    p.stdin.end(JSON.stringify(input))
  })
})

let shared
ipcMain.on('shared', e => {
  if (e.senderFrame !== e.sender.mainFrame || !e.senderFrame.url.startsWith(appUrl)) throw new Error('Blocked IPC from untrusted frame')
  e.returnValue = shared.get()
})
handle('saveShared', async (client, patch) => {
  const own = pickShared(patch)
  await shared.save(own)
  hub.broadcast('shared:changed', own, client.id)
})

const terms = new Map()
const termKey = (client, id) => `${client.id}:${id}`
const killTerms = pred => { for (const [k, t] of terms) if (pred(t)) { t.p.kill(); terms.delete(k) } }

handle('termStart', (client, id, cwd, cols, rows) => {
  const sh = process.env.SHELL || '/bin/bash'
  const [cmd, args] = win32 ? ['powershell.exe', ['-NoLogo']]
    : process.platform === 'darwin' ? ['script', ['-q', '/dev/null', sh, '-il']]
    : ['script', ['-qfec', `${sh} -il`, '/dev/null']]
  const p = spawn(cmd, args, { cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
  const k = termKey(client, id)
  terms.set(k, { p, client })
  const out = d => client.alive() && client.send('term:data', { id, data: d.toString() })
  p.stdout.on('data', out); p.stderr.on('data', out)
  p.on('exit', () => { terms.delete(k); client.alive() && client.send('term:exit', { id }) })
  p.on('error', err => out(String(err)))
  setTimeout(() => resize(k, cols, rows), 300)
})
handle('termWrite', (client, id, data) => terms.get(termKey(client, id))?.p.stdin.write(data))
handle('termResize', (client, id, cols, rows) => resize(termKey(client, id), cols, rows))
handle('termKill', (client, id) => terms.get(termKey(client, id))?.p.kill())
function resize(k, cols, rows) {
  const p = terms.get(k)?.p
  if (!p || win32) return
  try {
    const kid = execFileSync('pgrep', ['-P', String(p.pid)]).toString().split('\n')[0].trim()
    const tty = execFileSync('ps', ['-o', 'tty=', '-p', kid]).toString().trim()
    execFileSync('stty', [process.platform === 'darwin' ? '-f' : '-F', '/dev/' + tty, 'cols', String(cols), 'rows', String(rows)])
  } catch {}
}

const icon = nativeImage.createFromPath(path.join(here, 'build/icon.png'))

function createWindow(cwd) {
  const win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 420, minHeight: 320,
    title: 'Codedesk', icon, autoHideMenuBar: true,
    backgroundColor: '#1c1b19',
    webPreferences: { preload: path.join(here, 'preload.cjs'), backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  })
  const wcId = win.webContents.id
  const client = winClient(win.webContents)
  win.on('closed', () => {
    hub.drop(client.id)
    killTerms(t => t.client === client)
    winClients.delete(wcId)
  })
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('will-navigate', ev => ev.preventDefault())
  win.webContents.on('will-attach-webview', ev => ev.preventDefault())
  win.webContents.on('found-in-page', (_, r) => win.webContents.send('found', r))
  win.loadFile(path.join(here, 'ui/index.html'), { query: cwd ? { cwd } : {} })
}

const send = ch => (_, w) => w?.webContents.send('menu', ch)
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
  { label: 'File', submenu: [
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: send('newTab') },
    { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: () => createWindow() },
    { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: send('openFolder') },
    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('closeTab') },
    { type: 'separator' },
    { label: 'Export Conversation…', accelerator: 'CmdOrCtrl+Shift+E', click: send('export') },
    { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: send('settings') },
    { type: 'separator' }, process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
  ] },
  { role: 'editMenu' },
  { label: 'View', submenu: [
    { label: 'Command Palette', accelerator: 'CmdOrCtrl+K', click: send('palette') },
    { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('find') },
    { label: 'Search Prompt History', accelerator: 'CmdOrCtrl+R', click: send('history') },
    { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('sidebar') },
    { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: send('panel') },
    { label: 'Terminal', accelerator: 'CmdOrCtrl+`', click: send('terminal') },
    { type: 'separator' },
    { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' },
    { type: 'separator' }, { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' }, { role: 'toggleDevTools' },
  ] },
  { role: 'windowMenu' },
]))

const argDir = process.argv.slice(1).find(a => !a.startsWith('-') && path.resolve(a) !== app.getAppPath() && existsSync(a) && statSync(a).isDirectory())

app.setName('Codedesk')
const userData = path.join(app.getPath('appData'), 'Codedesk'), oldData = path.join(app.getPath('appData'), 'Claude Code')
if (!existsSync(userData) && existsSync(oldData)) cpSync(oldData, userData, { recursive: true })
app.setPath('userData', userData)
app.enableSandbox()
const ALLOWED = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])
app.whenReady().then(async () => {
  shared = createShared(path.join(userData, 'shared.json'))
  await shared.load()
  session.defaultSession.setPermissionRequestHandler((_, perm, cb) => cb(ALLOWED.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_, perm) => ALLOWED.has(perm))
  createWindow(argDir && path.resolve(argDir))
})
app.on('will-quit', () => {
  for (const k of [...sessions.keys()]) stopSession(k)
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})
setInterval(() => { hub.sweep(); killTerms(t => !t.client.alive()) }, 60000).unref()
app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow())
app.on('window-all-closed', () => { killTerms(() => true); process.platform !== 'darwin' && app.quit() })
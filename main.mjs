import { deleteSession, forkSession, getSessionMessages, listSessions, query, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { agyArgs, finishTurn, newTurnState, parseAgyModels, parseLine, translateAgyEvent } from './agy.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const appUrl = pathToFileURL(path.join(here, 'ui/index.html')).href
const handle = (ch, fn) => ipcMain.handle(ch, (e, ...a) => {
  if (e.senderFrame !== e.sender.mainFrame || !e.senderFrame.url.startsWith(appUrl)) throw new Error('Blocked IPC from untrusted frame')
  return fn(e, ...a)
})
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
const key = (e, tab) => `${e.sender.id}:${tab}`
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

async function startGeminiSession(wc, tab, opts) {
  const k = `${wc.id}:${tab}`
  stopSession(k)
  const store = await readGeminiStore()
  const existing = opts.resume && store[opts.resume]
  const send = (ch, data) => { if (!wc.isDestroyed()) wc.send(ch, { tab, ...data }) }
  const s = {
    isGemini: true,
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
  sessions.set(k, s)
  send('claude:meta', { commands: [], models: await getAgyModels(), agents: [] })
  send('claude:message', {
    msg: {
      type: 'system', subtype: 'init', session_id: s.sessionId,
      mcp_servers: [], skills: [], model: s.model,
      claude_code_version: 'Antigravity CLI',
      output_style: 'default', permissionMode: s.permissionMode, slash_commands: [],
    },
  })
}

function saverOptions(saver = {}) {
  const extra = { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' }
  if (['sonnet', 'haiku'].includes(saver.subagentModel)) extra.CLAUDE_CODE_SUBAGENT_MODEL = saver.subagentModel
  const pct = +saver.compactAt
  if (saver.compactAt && Number.isInteger(pct) && pct >= 1 && pct <= 100) extra.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(pct)
  const turns = +saver.maxTurns
  return {
    env: { ...process.env, ...extra },
    ...(saver.maxTurns && Number.isInteger(turns) && turns > 0 && { maxTurns: turns }),
    ...(saver.noSubagents === true && { disallowedTools: ['Agent', 'Task'] }),
  }
}

function startSession(wc, tab, opts) {
  const { cwd, resume, model, permissionMode, effort, additionalDirectories, forkSession: fork, resumeSessionAt } = opts
  if (!existsSync(cwd)) return wc.send('claude:error', { tab, error: `Project folder not found: ${cwd}` })
  if (isGemini(model)) return startGeminiSession(wc, tab, opts)
  const k = `${wc.id}:${tab}`
  stopSession(k)
  const inbox = []
  let wake = null
  const pending = new Map()
  const s = { q: null, pending, closed: false, push: m => { inbox.push(m); wake?.() } }
  async function* prompts() {
    while (!s.closed) {
      if (inbox.length) yield inbox.shift()
      else await new Promise(r => (wake = r))
    }
  }
  const send = (ch, data) => { if (!wc.isDestroyed()) wc.send(ch, { tab, ...data }) }

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
      ...saverOptions(opts.saver),
      settingSources: ['user', 'project', 'local'],
      stderr: line => send('claude:stderr', { line }),
      canUseTool: (toolName, input, { signal, suggestions, decisionReason, title }) =>
        new Promise(resolve => {
          const id = crypto.randomUUID()
          pending.set(id, resolve)
          signal.addEventListener('abort', () => { pending.delete(id); resolve({ behavior: 'deny', message: 'Aborted' }) })
          send('claude:permission', { id, toolName, input, suggestions, decisionReason, title })
        }),
    },
  })
  sessions.set(k, s)

  ;(async () => {
    try {
      for await (const msg of s.q) { if (s.closed) break; send('claude:message', { msg }) }
    } catch (e) {
      if (!s.closed) send('claude:error', { error: String(e?.message || e) })
    }
    if (!s.closed) { sessions.delete(k); send('claude:ended', {}) }
  })()

  Promise.all([s.q.supportedCommands(), s.q.supportedModels(), s.q.supportedAgents().catch(() => []), getAgyModels()])
    .then(([commands, models, agents, gm]) => send('claude:meta', { commands, models: [...gm, ...(models || [])], agents }))
    .catch(() => send('claude:meta', { commands: [], models: [], agents: [] }))
}

function stopSession(k) {
  const s = sessions.get(k)
  if (!s) return
  s.closed = true
  for (const r of s.pending.values()) r({ behavior: 'deny', message: 'Session closed' })
  if (!s.isGemini) s.push(null)
  try { s.q.close() } catch {}
  sessions.delete(k)
}

const CONTROL = new Set(['interrupt', 'setModel', 'setPermissionMode', 'setMaxThinkingTokens', 'applyFlagSettings',
  'mcpServerStatus', 'reconnectMcpServer', 'toggleMcpServer', 'getContextUsage', 'accountInfo', 'rewindFiles',
  'stopTask', 'reloadSkills', 'reloadPlugins'])

handle('start', (e, tab, opts) => startSession(e.sender, tab, opts))
handle('stop', (e, tab) => stopSession(key(e, tab)))
handle('send', (e, tab, msg) => sessions.get(key(e, tab))?.push({ type: 'user', parent_tool_use_id: null, ...msg }))
handle('control', async (e, tab, method, ...args) => {
  const s = sessions.get(key(e, tab))
  if (!s || !CONTROL.has(method)) return null
  if (method === 'setModel' && isGemini(args[0]) !== !!s.isGemini) {
    startSession(e.sender, tab, { cwd: s.cwd, model: args[0], permissionMode: s.permissionMode, effort: s.effort })
    return null
  }
  return s.q[method]?.(...args) ?? null
})
handle('permit', (e, tab, id, result) => {
  const s = sessions.get(key(e, tab)), r = s?.pending.get(id)
  if (r) { s.pending.delete(id); r(result) }
})

const idle = new Promise(() => {})
handle('usage', async (e, tab, full) => {
  const s = sessions.get(key(e, tab))
  if (s?.isGemini) return null
  const live = s?.q
  const q = live || query({ prompt: (async function* () { await idle })(), options: { cwd: homedir(), pathToClaudeCodeExecutable: claudePath } })
  try { return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: !full }) }
  catch { return null }
  finally { if (!live) q.close() }
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
handle('pickFolder', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})
handle('saveFile', async (e, name, content) => {
  const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), { defaultPath: name })
  if (!r.canceled) await fs.writeFile(r.filePath, content)
  return !r.canceled
})
handle('find', (e, text, opts) => text ? e.sender.findInPage(text, opts) : e.sender.stopFindInPage('clearSelection'))
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

const terms = new Map()

handle('termStart', (e, id, cwd, cols, rows) => {
  const sh = process.env.SHELL || '/bin/bash'
  const [cmd, args] = win32 ? ['powershell.exe', ['-NoLogo']]
    : process.platform === 'darwin' ? ['script', ['-q', '/dev/null', sh, '-il']]
    : ['script', ['-qfec', `${sh} -il`, '/dev/null']]
  const p = spawn(cmd, args, { cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
  const wc = e.sender
  terms.set(id, p)
  const out = d => !wc.isDestroyed() && wc.send('term:data', { id, data: d.toString() })
  p.stdout.on('data', out); p.stderr.on('data', out)
  p.on('exit', () => { terms.delete(id); !wc.isDestroyed() && wc.send('term:exit', { id }) })
  p.on('error', err => out(String(err)))
  setTimeout(() => resize(id, cols, rows), 300)
})
handle('termWrite', (_, id, data) => terms.get(id)?.stdin.write(data))
handle('termResize', (_, id, cols, rows) => resize(id, cols, rows))
handle('termKill', (_, id) => terms.get(id)?.kill())
function resize(id, cols, rows) {
  const p = terms.get(id)
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
    webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  })
  const id = win.webContents.id
  win.on('closed', () => {
    for (const k of [...sessions.keys()]) if (k.startsWith(id + ':')) stopSession(k)
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
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_, perm, cb) => cb(ALLOWED.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_, perm) => ALLOWED.has(perm))
  createWindow(argDir && path.resolve(argDir))
})
app.on('will-quit', () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }) })
app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow())
app.on('window-all-closed', () => { for (const p of terms.values()) p.kill(); process.platform !== 'darwin' && app.quit() })
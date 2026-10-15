import { deleteSession, forkSession, getSessionMessages, listSessions, query, renameSession } from '@anthropic-ai/claude-agent-sdk'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell } from 'electron'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, rmSync, statSync } from 'node:fs'
import fs from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const agyPath = findBin('agy') || findBin('gemini')

const run = (cmd, args, opts = {}) => new Promise(resolve =>
  execFile(cmd, args, { maxBuffer: 64 << 20, timeout: 120000, ...opts }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })))

const sessions = new Map()
const key = (e, tab) => `${e.sender.id}:${tab}`
const isGemini = m => /^gemini/i.test(m || '')

const GEMINI_MODELS = [
  { value: 'gemini-4-argon', displayName: 'Gemini 4 Argon', description: 'Gemini 4 Argon · Google AI Pro local repo agent', supportsFastMode: false, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'gemini-3.5-flash', displayName: 'Gemini 3.5 Flash', description: 'Gemini 3.5 Flash · Fast multimodal Google model', supportsFastMode: true, supportedEffortLevels: ['low', 'medium', 'high'] },
]

const storePath = () => path.join(app.getPath('userData'), 'gemini-sessions.json')
async function readGeminiStore() {
  try { return JSON.parse(await fs.readFile(storePath(), 'utf8')) } catch { return {} }
}
async function writeGeminiStore(data) {
  await fs.mkdir(path.dirname(storePath()), { recursive: true })
  await fs.writeFile(storePath(), JSON.stringify(data))
}

let googleWin = null
const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

async function getGoogleWindow(show = false) {
  const ses = session.fromPartition('persist:google')
  ses.setUserAgent(CHROME_UA)
  ses.setPermissionRequestHandler((_, perm, cb) => cb(true))

  if (googleWin && !googleWin.isDestroyed()) {
    if (show) {
      googleWin.show()
      googleWin.focus()
      const u = googleWin.webContents.getURL()
      if (!u || u === 'about:blank') await googleWin.loadURL('https://gemini.google.com/app', { userAgent: CHROME_UA })
      else googleWin.webContents.reload()
    }
    return googleWin
  }

  googleWin = new BrowserWindow({
    width: 1100, height: 800, show,
    title: 'Google AI Pro — Gemini 4 Argon',
    backgroundColor: '#131314',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:google',
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  googleWin.webContents.setUserAgent(CHROME_UA)
  googleWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) googleWin.loadURL(url, { userAgent: CHROME_UA })
    return { action: 'deny' }
  })

  googleWin.on('close', e => {
    if (!app.isQuitting) { e.preventDefault(); googleWin.hide() }
  })

  await googleWin.loadURL('https://gemini.google.com/app', { userAgent: CHROME_UA }).catch(() => {})
  return googleWin
}

async function getGoogleStatus() {
  const ses = session.fromPartition('persist:google')
  const cookies = await ses.cookies.get({ domain: '.google.com' }).catch(() => [])
  const loggedIn = cookies.some(c => c.name === 'SID' || c.name === '__Secure-1PSID')
  return { loggedIn, agyPath: agyPath || null, hasEnvKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) }
}

handle('googleStatus', () => getGoogleStatus())
handle('googleLogin', async () => {
  const w = await getGoogleWindow(true)
  return new Promise(resolve => {
    const check = setInterval(async () => {
      if (w.isDestroyed()) { clearInterval(check); return resolve(await getGoogleStatus()) }
      const st = await getGoogleStatus()
      if (st.loggedIn && w.webContents.getURL().startsWith('https://gemini.google.com')) {
        clearInterval(check)
        resolve(st)
      }
    }, 1500)
  })
})
handle('googleLogout', async () => {
  const ses = session.fromPartition('persist:google')
  await ses.clearStorageData()
  if (googleWin && !googleWin.isDestroyed()) googleWin.reload()
  return getGoogleStatus()
})
handle('googleWindow', async (_, show = true) => {
  await getGoogleWindow(show)
  return getGoogleStatus()
})

const TOOL_DECLS = [
  { name: 'Read', description: 'Read a file from the local repository.', parameters: { type: 'OBJECT', properties: { file_path: { type: 'STRING' }, offset: { type: 'INTEGER' }, limit: { type: 'INTEGER' } }, required: ['file_path'] } },
  { name: 'Write', description: 'Create or overwrite a file in the local repository.', parameters: { type: 'OBJECT', properties: { file_path: { type: 'STRING' }, content: { type: 'STRING' } }, required: ['file_path', 'content'] } },
  { name: 'Edit', description: 'Replace old_string with new_string in a file.', parameters: { type: 'OBJECT', properties: { file_path: { type: 'STRING' }, old_string: { type: 'STRING' }, new_string: { type: 'STRING' }, replace_all: { type: 'BOOLEAN' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'MultiEdit', description: 'Apply multiple old_string to new_string replacements in a single file.', parameters: { type: 'OBJECT', properties: { file_path: { type: 'STRING' }, edits: { type: 'ARRAY', items: { type: 'OBJECT', properties: { old_string: { type: 'STRING' }, new_string: { type: 'STRING' }, replace_all: { type: 'BOOLEAN' } }, required: ['old_string', 'new_string'] } } }, required: ['file_path', 'edits'] } },
  { name: 'Bash', description: 'Execute a shell command in the project directory.', parameters: { type: 'OBJECT', properties: { command: { type: 'STRING' }, description: { type: 'STRING' } }, required: ['command'] } },
  { name: 'Glob', description: 'Find files by pattern in the repository.', parameters: { type: 'OBJECT', properties: { pattern: { type: 'STRING' }, path: { type: 'STRING' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents using regex.', parameters: { type: 'OBJECT', properties: { pattern: { type: 'STRING' }, path: { type: 'STRING' } }, required: ['pattern'] } },
  { name: 'TodoWrite', description: 'Update the structured task to-do list.', parameters: { type: 'OBJECT', properties: { todos: { type: 'ARRAY', items: { type: 'OBJECT', properties: { content: { type: 'STRING' }, status: { type: 'STRING' }, activeForm: { type: 'STRING' } }, required: ['content', 'status'] } } }, required: ['todos'] } },
]

async function buildRepoSystemPrompt(cwd, includeXmlTools) {
  const claudeMd = await fs.readFile(path.join(cwd, 'CLAUDE.md'), 'utf8').catch(() => '')
  const geminiMd = await fs.readFile(path.join(cwd, 'GEMINI.md'), 'utf8').catch(() => '')
  const g = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd })
  const files = !g.code ? g.stdout.split('\n').filter(Boolean).slice(0, 400).join('\n') : ''
  const base = [
    `You are Gemini 4 Argon operating as an autonomous local coding agent inside Codedesk.`,
    `Working directory (cwd): ${cwd}`,
    claudeMd ? `Project CLAUDE.md:\n${claudeMd}` : '',
    geminiMd ? `Project GEMINI.md:\n${geminiMd}` : '',
    files ? `Repository files (sample):\n${files}` : '',
    `Always use paths relative to ${cwd} or full paths. Inspect files with Read/Grep/Glob before editing, and use Edit/MultiEdit/Write/Bash to implement changes directly.`,
  ].filter(Boolean).join('\n\n')
  if (!includeXmlTools) return base
  return base + `\n\nTo read or edit the local repository or run shell commands, output one or more tool calls using this exact single-line XML format (do NOT wrap inside markdown code blocks):
<tool_call>{"name": "Read", "input": {"file_path": "package.json"}}</tool_call>
Available tools:
- Read: {"file_path": string, "offset"?: number, "limit"?: number}
- Write: {"file_path": string, "content": string}
- Edit: {"file_path": string, "old_string": string, "new_string": string, "replace_all"?: boolean}
- MultiEdit: {"file_path": string, "edits": [{"old_string": string, "new_string": string, "replace_all"?: boolean}]}
- Bash: {"command": string, "description"?: string}
- Glob: {"pattern": string, "path"?: string}
- Grep: {"pattern": string, "path"?: string}
- TodoWrite: {"todos": [{"content": string, "status": "pending"|"in_progress"|"completed", "activeForm"?: string}]}
Always ensure valid JSON inside <tool_call>...</tool_call>. Wait for the <tool_result> response before continuing.`
}

function resolveFile(cwd, p) {
  if (!p) return cwd
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

async function askToolPermission(s, send, toolName, input) {
  if (s.permissionMode === 'bypassPermissions' || s.permissionMode === 'auto') return { behavior: 'allow', updatedInput: input }
  if (['Read', 'Glob', 'Grep', 'TodoWrite'].includes(toolName)) return { behavior: 'allow', updatedInput: input }
  if (s.alwaysAllowed.has(toolName)) return { behavior: 'allow', updatedInput: input }
  if (s.permissionMode === 'acceptEdits' && ['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    return { behavior: 'allow', updatedInput: input }
  }
  if (s.permissionMode === 'plan' && ['Write', 'Edit', 'MultiEdit', 'Bash'].includes(toolName)) {
    return { behavior: 'deny', message: 'Plan mode is active. Do not modify files or run commands until plan is approved.' }
  }
  return new Promise(resolve => {
    const id = crypto.randomUUID()
    s.pending.set(id, res => {
      if (res?.updatedPermissions) s.alwaysAllowed.add(toolName)
      resolve(res)
    })
    send('claude:permission', {
      id, toolName, input,
      suggestions: [{ type: 'allowTool', toolName }],
      decisionReason: `Gemini 4 Argon wants to run ${toolName}`,
      title: `Allow ${toolName}?`,
    })
  })
}

async function snapshotFile(s, turnUuid, fullPath) {
  if (!turnUuid) return
  if (!s.checkpoints.has(turnUuid)) s.checkpoints.set(turnUuid, new Map())
  const map = s.checkpoints.get(turnUuid)
  if (map.has(fullPath)) return
  const exists = existsSync(fullPath)
  const content = exists ? await fs.readFile(fullPath, 'utf8').catch(() => null) : null
  map.set(fullPath, { exists, content })
}

async function executeLocalTool(s, send, turnUuid, name, rawInput) {
  const perm = await askToolPermission(s, send, name, rawInput)
  if (perm.behavior !== 'allow') {
    send('claude:message', { msg: { type: 'system', subtype: 'permission_denied', tool_name: name } })
    return { is_error: true, content: perm.message || 'Permission denied by user' }
  }
  const input = perm.updatedInput || rawInput
  try {
    if (name === 'Read') {
      const fp = resolveFile(s.cwd, input.file_path)
      const txt = await fs.readFile(fp, 'utf8')
      const lines = txt.split('\n')
      const start = Math.max(0, (input.offset || 1) - 1)
      const lim = input.limit || (s.googleMode === 'web' ? 160 : lines.length)
      const end = Math.min(lines.length, start + lim)
      const slice = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
      const more = end < lines.length ? `\n... (${lines.length - end} more lines, use offset=${end + 1} to read more)` : ''
      return { is_error: false, content: slice + more }
    }
    if (name === 'Write') {
      const fp = resolveFile(s.cwd, input.file_path)
      await snapshotFile(s, turnUuid, fp)
      await fs.mkdir(path.dirname(fp), { recursive: true })
      await fs.writeFile(fp, input.content || '', 'utf8')
      return { is_error: false, content: `Wrote ${fp}` }
    }
    if (name === 'Edit' || name === 'MultiEdit') {
      const fp = resolveFile(s.cwd, input.file_path)
      await snapshotFile(s, turnUuid, fp)
      let content = await fs.readFile(fp, 'utf8')
      const edits = name === 'MultiEdit' ? (input.edits || []) : [input]
      for (const e of edits) {
        if (!content.includes(e.old_string)) return { is_error: true, content: `old_string not found in ${fp}` }
        content = e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, e.new_string)
      }
      await fs.writeFile(fp, content, 'utf8')
      return { is_error: false, content: `Updated ${fp}` }
    }
    if (name === 'Bash') {
      const r = await run(win32 ? 'powershell.exe' : process.env.SHELL || '/bin/sh', win32 ? ['-NoProfile', '-Command', input.command] : ['-c', input.command], { cwd: s.cwd })
      const out = [r.stdout, r.stderr].filter(Boolean).join('\n').trim() || `(exit ${r.code})`
      return { is_error: r.code !== 0, content: out.slice(0, 12000) }
    }
    if (name === 'Glob') {
      const target = resolveFile(s.cwd, input.path || '')
      const g = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: target })
      const rx = new RegExp((input.pattern || '*').replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*'), 'i')
      const list = g.stdout.split('\n').filter(f => f && rx.test(f)).slice(0, 300)
      return { is_error: false, content: list.join('\n') || 'No matching files' }
    }
    if (name === 'Grep') {
      const args = ['grep', '-n', '-I', '-E', input.pattern, ...(input.path ? ['--', input.path] : [])]
      const g = await run('git', args, { cwd: s.cwd })
      return { is_error: false, content: g.stdout.slice(0, 10000) || 'No matches found' }
    }
    if (name === 'TodoWrite') {
      return { is_error: false, content: `Updated ${(input.todos || []).length} todos` }
    }
    return { is_error: true, content: `Unknown tool: ${name}` }
  } catch (err) {
    return { is_error: true, content: String(err?.message || err) }
  }
}

function looseJsonParse(raw) {
  const s = raw.trim().replace(/^```(?:json|xml)?\s*/i, '').replace(/\s*```$/, '').trim()
  try { return JSON.parse(s) } catch {}
  let inStr = false, esc = false, fixed = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (esc) { fixed += ch; esc = false; continue }
    if (ch === '\\') { fixed += ch; esc = true; continue }
    if (ch === '"') { inStr = !inStr; fixed += ch; continue }
    if (inStr && ch === '\n') { fixed += '\\n'; continue }
    if (inStr && ch === '\r') continue
    if (inStr && ch === '\t') { fixed += '\\t'; continue }
    fixed += ch
  }
  try { return JSON.parse(fixed) } catch {}
  const repaired = fixed.replace(/:\s*([A-Za-z_][A-Za-z0-9_]*)\s*([,}])/g, ': "$1"$2')
  try { return JSON.parse(repaired) } catch {}
  const nameMatch = s.match(/"name"\s*:\s*"?([A-Za-z]+)"?/)
  if (!nameMatch) return null
  const name = nameMatch[1]
  if (name === 'Bash') {
    const cmdMatch = s.match(/"command"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"description"\s*:\s*"([\s\S]*?)")?\s*\}/)
    if (cmdMatch) return { name, input: { command: cmdMatch[1].replace(/\\"/g, '"'), description: cmdMatch[2] || '' } }
  }
  return null
}

function parseXmlToolCalls(text) {
  const calls = []
  const cleanedRaw = text.replace(/^!\][\s\S]*?(?=<tool_call>|$)/gm, '')
  const rx = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g
  let m
  while ((m = rx.exec(cleanedRaw))) {
    if (!m[1].trim()) continue
    const parsed = looseJsonParse(m[1])
    if (parsed?.name) calls.push({ id: crypto.randomUUID(), name: parsed.name, input: parsed.input || {} })
  }
  const cleanText = cleanedRaw
    .replace(/```(?:xml|json)?\s*<tool_call>[\s\S]*?(?:<\/tool_call>|$)\s*```/g, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, '')
    .replace(/<\/tool_call>\w*/g, '')
    .trim()
  return { cleanText, calls }
}

async function queryGeminiWeb(promptText, onVisibleText, signal) {
  const w = await getGoogleWindow(false)
  const url = w.webContents.getURL()
  if (!url.startsWith('https://gemini.google.com')) await w.loadURL('https://gemini.google.com/app')

  const readDomState = () => w.webContents.executeJavaScript(`(() => {
    const cleanNode = el => {
      if (!el) return '';
      const clone = el.cloneNode(true);
      clone.querySelectorAll('model-thoughts, .model-thoughts, .thoughts-container, [data-test-id*="thought"]').forEach(n => n.remove());
      return (clone.innerText || '').replace(/^!\\].*$/gm, '').trim();
    };
    const nodes = [...document.querySelectorAll('message-content, .model-response-text')];
    const last = nodes[nodes.length - 1];
    const stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="Zatrzymaj"], .stop-icon');
    return { count: nodes.length, text: cleanNode(last), busy: !!stopBtn };
  })()`).catch(() => ({ count: 0, text: '', busy: false }))

  const before = await readDomState()
  const safePrompt = promptText.length > 16000 ? promptText.slice(0, 16000) + '\n...(truncated)' : promptText

  const sent = await w.webContents.executeJavaScript(`(() => {
    const ed = document.querySelector('div.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea');
    if (!ed) return false;
    ed.focus();
    const txt = ${JSON.stringify(safePrompt)};
    if (ed.tagName === 'TEXTAREA') {
      ed.value = txt;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      ed.textContent = txt;
      ed.dispatchEvent(new InputEvent('input', { bubbles: true, data: txt, inputType: 'insertText' }));
    }
    setTimeout(() => {
      const btn = document.querySelector('button.send-button, button[aria-label*="Send"], button[aria-label*="Wyślij"]');
      if (btn && !btn.disabled) btn.click();
      else ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }, 180);
    return true;
  })()`)
  if (!sent) throw new Error('Nie znaleziono pola czatu na gemini.google.com. Kliknij "Sign in to Google AI Pro" w Settings i upewnij się, że jesteś zalogowany.')

  let lastRaw = ''
  let lastVisible = ''
  let stableTicks = 0
  let started = false
  let waitTicks = 0

  while (!signal.aborted) {
    await new Promise(r => setTimeout(r, 250))
    waitTicks++
    const state = await readDomState()

    const isNewNode = state.count > before.count || (state.count > 0 && state.text !== before.text && waitTicks > 4)
    if (isNewNode && state.text) {
      started = true
      if (state.text !== lastRaw) {
        lastRaw = state.text
        const visible = lastRaw.replace(/<tool_call>[\s\S]*$/g, '').trim()
        if (visible.length > lastVisible.length) {
          onVisibleText(visible.slice(lastVisible.length))
          lastVisible = visible
        }
        stableTicks = 0
      } else if (!state.busy) {
        stableTicks++
        if (stableTicks >= 5) break
      }
    } else if (started && !state.busy) {
      stableTicks++
      if (stableTicks >= 6) break
    }
  }
  return lastRaw
}

async function runGeminiWebTurn(s, send, userBlocks, turnUuid) {
  const textInput = userBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n')
  let promptToSend = textInput
  if (!s.webPrimed) {
    const sys = await buildRepoSystemPrompt(s.cwd, true)
    promptToSend = `${sys}\n\nUser request:\n${textInput}`
    s.webPrimed = true
  }
  let turns = 0
  while (!s.closed && !s.abort?.signal.aborted) {
    turns++
    send('claude:message', { msg: { type: 'stream_event', event: { type: 'message_start' } } })
    let streamStarted = false
    const rawReply = await queryGeminiWeb(promptToSend, chunk => {
      if (!streamStarted) {
        streamStarted = true
        send('claude:message', { msg: { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } } })
      }
      send('claude:message', { msg: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } } })
    }, s.abort.signal)

    const { cleanText, calls } = parseXmlToolCalls(rawReply)
    const assistantBlocks = [
      ...(cleanText ? [{ type: 'text', text: cleanText }] : []),
      ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
    ]
    const assistantMsg = { type: 'assistant', uuid: crypto.randomUUID(), message: { content: assistantBlocks } }
    s.history.push(assistantMsg)
    send('claude:message', { msg: assistantMsg })

    if (!calls.length) break

    const toolResultBlocks = []
    const nextPromptLines = []
    for (const call of calls) {
      const r = await executeLocalTool(s, send, turnUuid, call.name, call.input)
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: r.content, is_error: r.is_error })
      nextPromptLines.push(`<tool_result name="${call.name}" error="${r.is_error}">\n${r.content.slice(0, 6000)}\n</tool_result>`)
    }
    const userToolMsg = { type: 'user', message: { content: toolResultBlocks } }
    s.history.push(userToolMsg)
    send('claude:message', { msg: userToolMsg })
    promptToSend = nextPromptLines.join('\n\n').slice(0, 14000) + '\n\nContinue with the task using <tool_call> if more actions are needed, or provide the final answer.'
  }
  return turns
}

async function startGeminiSession(wc, tab, opts) {
  const k = `${wc.id}:${tab}`
  stopSession(k)
  const store = await readGeminiStore()
  const sessionId = opts.resume && store[opts.resume] ? opts.resume : crypto.randomUUID()
  const existing = store[sessionId]
  const send = (ch, data) => { if (!wc.isDestroyed()) wc.send(ch, { tab, ...data }) }

  const s = {
    isGemini: true,
    sessionId,
    cwd: opts.cwd,
    model: opts.model || 'gemini-4-argon',
    permissionMode: opts.permissionMode || 'default',
    effort: opts.effort || 'medium',
    googleMode: opts.googleMode || 'web',
    googleApiKey: opts.googleApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    pending: new Map(),
    alwaysAllowed: new Set(),
    checkpoints: new Map(),
    history: existing?.messages || [],
    apiContents: existing?.apiContents || [],
    tokensUsed: existing?.tokensUsed || 0,
    webPrimed: false,
    closed: false,
    abort: null,
    push: async msg => {
      if (s.closed || !msg?.message) return
      const startTs = Date.now()
      s.abort = new AbortController()
      const c = msg.message.content
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : c || []
      const userRecord = { type: 'user', uuid: msg.uuid || crypto.randomUUID(), message: { role: 'user', content: blocks } }
      s.history.push(userRecord)
      if (!msg.shouldQuery && msg.shouldQuery !== undefined) return
      try {
        const useApi = (s.googleMode === 'api' || (s.googleApiKey && s.googleMode !== 'web')) && s.googleApiKey
        const turns = useApi
          ? await runGeminiApiTurn(s, send, s.googleApiKey, blocks, userRecord.uuid)
          : await runGeminiWebTurn(s, send, blocks, userRecord.uuid)
        const all = await readGeminiStore()
        const firstText = blocks.find(b => b.type === 'text')?.text || 'Gemini 4 Argon'
        all[s.sessionId] = {
          sessionId: s.sessionId,
          cwd: s.cwd,
          customTitle: all[s.sessionId]?.customTitle,
          summary: all[s.sessionId]?.summary || firstText.slice(0, 80),
          firstPrompt: all[s.sessionId]?.firstPrompt || firstText.slice(0, 80),
          lastModified: Date.now(),
          messages: s.history,
          apiContents: s.apiContents,
          tokensUsed: s.tokensUsed,
        }
        await writeGeminiStore(all)
        send('claude:message', { msg: { type: 'result', subtype: 'success', is_error: false, duration_ms: Date.now() - startTs, num_turns: turns, total_cost_usd: 0 } })
      } catch (e) {
        if (!s.abort?.signal.aborted) send('claude:error', { error: String(e?.message || e) })
        send('claude:message', { msg: { type: 'result', subtype: 'error', is_error: true, result: String(e?.message || e), duration_ms: Date.now() - startTs, num_turns: 1 } })
      }
    },
    q: {
      close: () => { s.abort?.abort() },
      interrupt: async () => { s.abort?.abort() },
      setModel: async m => { s.model = m },
      setPermissionMode: async m => { s.permissionMode = m },
      applyFlagSettings: async f => { if (f.effortLevel) s.effort = f.effortLevel },
      getContextUsage: async () => ({
        percentage: Math.min(100, (s.tokensUsed / 1048576) * 100),
        maxTokens: 1048576,
        model: s.model,
        categories: [
          { name: 'Conversation & repo context', kind: 'messages', tokens: s.tokensUsed || 4096 },
          { name: 'Free (1M Argon window)', kind: 'free', tokens: Math.max(0, 1048576 - (s.tokensUsed || 4096)) },
        ],
      }),
      rewindFiles: async (uuid, opts) => {
        const snap = s.checkpoints.get(uuid)
        if (!snap) return { canRewind: false, error: 'No file checkpoint for this message' }
        const filesChanged = [...snap.keys()]
        if (opts?.dryRun) return { canRewind: true, filesChanged, insertions: filesChanged.length, deletions: 0 }
        for (const [fp, state] of snap.entries()) {
          if (state.exists && state.content != null) await fs.writeFile(fp, state.content, 'utf8')
          else if (!state.exists && existsSync(fp)) await fs.unlink(fp).catch(() => {})
        }
        return { canRewind: true, filesChanged }
      },
      mcpServerStatus: async () => [],
    },
  }
  sessions.set(k, s)
  send('claude:meta', { commands: [], models: GEMINI_MODELS, agents: [] })
  send('claude:message', {
    msg: {
      type: 'system', subtype: 'init', session_id: s.sessionId,
      mcp_servers: [], skills: [], model: s.model,
      claude_code_version: 'Gemini 4 Argon (Google AI Pro)',
      output_style: 'default', permissionMode: s.permissionMode, slash_commands: [],
    },
  })
}

function startSession(wc, tab, opts) {
  const { cwd, resume, model, permissionMode, effort, additionalDirectories, forkSession: fork, resumeSessionAt } = opts
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

  Promise.all([s.q.supportedCommands(), s.q.supportedModels(), s.q.supportedAgents().catch(() => [])])
    .then(([commands, models, agents]) => send('claude:meta', { commands, models: [...GEMINI_MODELS, ...(models || [])], agents }))
    .catch(() => send('claude:meta', { commands: [], models: GEMINI_MODELS, agents: [] }))
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
  const gStore = await readGeminiStore()
  if (gStore[id]) { gStore[id].customTitle = title; await writeGeminiStore(gStore); return }
  return renameSession(id, title, { dir })
})
handle('deleteSession', async (_, id, dir) => {
  const gStore = await readGeminiStore()
  if (gStore[id]) { delete gStore[id]; await writeGeminiStore(gStore); return }
  return deleteSession(id, { dir })
})
handle('forkSession', async (_, id, dir, upToMessageId) => {
  const gStore = await readGeminiStore()
  if (gStore[id]) {
    const src = gStore[id]
    const newId = crypto.randomUUID()
    const idx = upToMessageId ? src.messages.findIndex(m => m.uuid === upToMessageId) : -1
    const messages = idx >= 0 ? src.messages.slice(0, idx + 1) : [...src.messages]
    gStore[newId] = { ...src, sessionId: newId, messages, lastModified: Date.now() }
    await writeGeminiStore(gStore)
    return { sessionId: newId }
  }
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
    { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('sidebar') },
    { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: send('panel') },
    { label: 'Terminal', accelerator: 'CmdOrCtrl+`', click: send('terminal') },
    { type: 'separator' },
    { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' },
    { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' },
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
app.on('before-quit', () => { app.isQuitting = true })
app.on('will-quit', () => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }) })
app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow())
app.on('window-all-closed', () => { for (const p of terms.values()) p.kill(); process.platform !== 'darwin' && app.quit() })
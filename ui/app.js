const input = $('#input')

const App = {
  tabs: new Map(),
  active: null,
  chatEl: $('#chat'),
  info: {},
  google: {},
  fileCache: new Map(),

  newTab(cwd, { activate = true } = {}) {
    const tab = new Tab(cwd)
    this.tabs.set(tab.id, tab)
    this.chatEl.append(tab.view)
    if (activate) this.activate(tab)
    else this.renderTabs()
    return tab
  },

  activate(tab) {
    if (this.active) this.active.draft = input.value
    this.active = tab
    for (const t of this.tabs.values()) t.view.hidden = t !== tab
    $('#welcome').hidden = !!tab.cwd
    input.value = tab.draft
    autosize()
    renderAttachments()
    this.tabChanged(tab)
    this.refreshSessions()
    if (settings.panel) Panels.render()
    tab.scroll(true)
    input.focus()
  },

  closeTab(tab = this.active) {
    const ids = [...this.tabs.keys()]
    const idx = ids.indexOf(tab.id)
    tab.close()
    this.tabs.delete(tab.id)
    if (!this.tabs.size) this.newTab(null)
    else if (this.active === tab) this.activate(this.tabs.get(ids[idx + 1] || ids[idx - 1]))
    else this.renderTabs()
  },

  renderTabs() {
    const bar = $('#tabs')
    bar.replaceChildren(...[...this.tabs.values()].map(t => {
      const state = t.permissions ? 'needs-input' : t.busy ? 'busy' : ''
      const b = el('div', 'tab' + (t === this.active ? ' active' : '') + (state ? ' ' + state : ''),
        el('span', 'tab-dot'),
        el('span', 'tab-label', el('b', '', t.name), t.cwd ? el('span', '', ' · ' + t.title) : null),
        iconButton('x', 'Close tab', e => { e.stopPropagation(); this.closeTab(t) }, 'sm tab-close'))
      b.setAttribute('role', 'tab')
      b.title = t.cwd ? `${t.title}\n${t.cwd}` : 'New tab'
      b.onclick = () => this.activate(t)
      b.onauxclick = e => { if (e.button === 1) this.closeTab(t) }
      return b
    }))
  },

  tabChanged(tab) {
    this.renderTabs()
    if (tab !== this.active) return
    $('#welcome').hidden = !!tab.cwd
    document.body.classList.toggle('no-project', !tab.cwd)
    $('#project-name').textContent = tab.cwd ? basename(tab.cwd) : 'Choose a project'
    $('#chat-title').textContent = tab.cwd ? tab.title : ''
    $('#chat-path').textContent = tab.cwd ? tab.cwd.replace(App.info.home, '~') : ''
    $('#chat-path').title = tab.cwd || ''
    document.title = tab.cwd ? `${tab.title} ·${tab.name}` : 'Codedesk'
    const agentName = /^gemini/i.test(tab.model || '') ? modelInfo(tab).label : 'Claude'
    input.placeholder = tab.suggestion ? `${tab.suggestion}   (Tab to use)` : `Ask ${agentName} to build, fix or explain something`
    $('#send').hidden = tab.busy && !input.value.trim()
    $('#stop').hidden = !tab.busy || !!input.value.trim()
    renderChips(tab)
    renderStatus(tab)
    renderTodoStrip(tab)
    $$('#sessions .session').forEach(s => s.classList.toggle('active', s.dataset.id === tab.sessionId))
  },

  status(tab, text) { tab.statusMsg = text; if (tab === this.active) renderStatus(tab) },

  async openProject(cwd, sessionId, { newTab } = {}) {
    for (const t of this.tabs.values()) if (sessionId && t.sessionId === sessionId) return this.activate(t)
    let tab = this.active
    const reusable = tab && !tab.busy && (!tab.cwd || !tab.messages.childElementCount)
    if (newTab || !reusable) tab = this.newTab(cwd)
    tab.cwd = cwd
    this.activate(tab)
    rememberProject(cwd)
    this.updateBranch(tab)
    await tab.open(sessionId)
    this.refreshSessions()
  },

  async pickFolder(opts) {
    const dir = await api.pickFolder()
    if (dir) this.openProject(dir, null, opts)
  },

  async updateBranch(tab) {
    const r = await api.git(tab.cwd, ['branch', '--show-current'])
    tab.branch = r.code ? '' : r.stdout.trim()
    if (tab === this.active) {
      $('#chat-branch').hidden = !tab.branch
      $('#chat-branch').replaceChildren(icon('git-branch'), tab.branch)
    }
  },

  refreshSessions: debounce(async function () {
    const tab = App.active
    const nav = $('#sessions')
    if (!tab?.cwd) { nav.replaceChildren(el('div', 'side-empty', 'Open a project to see its conversations.')); return }
    const list = await api.listSessions(tab.cwd)
    App.sessionList = list
    renderSessions()
  }, 150),

  relPath(tab, full) { return tab.cwd && full.startsWith(tab.cwd) ? full.slice(tab.cwd.length + 1) : full },

  async projectFiles(tab) {
    const c = this.fileCache.get(tab.cwd)
    if (c && Date.now() - c.at < 30000) return c.files
    const files = await api.listFiles(tab.cwd)
    this.fileCache.set(tab.cwd, { at: Date.now(), files })
    return files
  },

  setComposer(text, sendNow) {
    input.value = text
    autosize()
    input.focus()
    if (sendNow) send()
  },
  insertText(text) {
    const s = input.selectionStart, v = input.value
    const pre = v.slice(0, s) + (s && !/\s$/.test(v.slice(0, s)) ? ' ' : '')
    input.value = pre + text + v.slice(input.selectionEnd)
    input.selectionStart = input.selectionEnd = pre.length + text.length
    autosize()
    input.focus()
  },

  async preview(state) {
    if (state.html && !state.url && !state.file) state.fileUrl = await api.writeTemp(state.html)
    Panels.previewState = state
    Panels.show('preview')
  },

  openInEditor(file, line) { api.openInEditor(settings.editor, file, line) },

  async openFile(file) {
    const r = await api.readFile(file).catch(e => ({ note: String(e.message || e) }))
    const ext = file.split('.').pop().toLowerCase()
    const state = { file, title: this.active?.cwd ? this.relPath(this.active, file) : file }
    if (r.image) Object.assign(state, { image: r.image, text: r.text })
    else if (r.text != null && ['html', 'htm'].includes(ext)) Object.assign(state, { html: r.text, fileUrl: await api.fileUrl(file) })
    else if (r.text != null && ['md', 'markdown', 'mdx'].includes(ext)) state.markdown = r.text
    else if (r.text != null) state.text = r.text
    else if (r.tooBig) state.note = `File is too large to preview (${fmtTokens(r.size)}B).`
    else if (r.binary) state.note = 'Binary file.'
    else state.note = r.note
    Panels.previewState = state
    Panels.show('preview')
  },

  runInTerminal(code) {
    if (!this.active?.cwd) return toast('Open a project first')
    Terminals.run(this.active, code.trim())
  },

  commands: {
    clear: { description: 'Start a new conversation in this tab', run: t => t.open(null) },
    new: { description: 'Start a new conversation in this tab', run: t => t.open(null) },
    resume: { description: 'Find a past conversation', run: () => { saveSettings({ sidebar: true }); $('#session-search').focus() } },
    model: { description: 'Choose the model', run: () => $('#model-chip').click() },
    gemini: { description: 'Switch to Gemini (Antigravity)', run: t => useGemini(t) },
    google: { description: 'Antigravity and Gemini settings', run: () => openSettings('google') },
    permissions: { description: 'Choose the permission mode', run: () => $('#mode-chip').click() },
    config: { description: 'Open settings', run: () => openSettings() },
    settings: { description: 'Open settings', run: () => openSettings() },
    mcp: { description: 'Manage MCP servers', run: () => Panels.show('mcp') },
    plugin: { description: 'Browse and manage plugins', run: () => Panels.show('plugins') },
    plugins: { description: 'Browse and manage plugins', run: () => Panels.show('plugins') },
    terminal: { description: 'Open the terminal panel', run: () => Panels.show('terminal') },
    files: { description: 'Show project files', run: () => Panels.show('files') },
    diff: { description: 'Show changed files', run: () => Panels.show('changes') },
    tasks: { description: 'Show to-dos and background tasks', run: () => Panels.show('tasks') },
    login: { description: 'Sign in to Claude', run: t => t.loginPrompt() },
    logout: { description: 'Sign out', run: async () => { await api.cli(['auth', 'logout']); toast('Signed out'); loadAccount() } },
    export: { description: 'Export conversation as Markdown', run: t => t.exportMarkdown() },
    help: { description: 'Keyboard shortcuts and tips', run: () => openHelp() },
    usage: { description: 'Plan usage, limits and what used them', run: t => openUsage(t) },
    agents: { description: 'Browse and create subagents', run: () => Panels.show('agents') },
    copy: { description: 'Copy last reply', run: t => { const a = $$('.assistant', t.messages).pop(); a ? copy(a.innerText) : toast('Nothing to copy yet') } },
    effort: { description: 'Set reasoning effort', run: () => $('#effort-chip').click() },
    fast: { description: 'Toggle fast mode', run: () => $('#fast-chip').click() },
    cost: { description: 'Plan usage, limits and what used them', run: t => openUsage(t) },
    exit: { description: 'Close this tab', run: t => App.closeTab(t) },
    'add-dir': { description: 'Give agent access to another folder', run: async t => {
      const d = await api.pickFolder()
      if (!d) return
      t.addDirs.push(d)
      await t.start()
      toast(`Added ${d}`)
    } },
    memory: { description: 'Open a CLAUDE.md memory file', run: t => menu($('#slash'), [
      { label: 'Project memory (CLAUDE.md)', icon: 'file-text', run: () => App.openFile(join(t.cwd, 'CLAUDE.md')) },
      { label: 'Personal memory (~/.claude/CLAUDE.md)', icon: 'user', run: () => App.openFile(join(App.info.home, '.claude/CLAUDE.md')) },
    ]) },
    rewind: { description: 'Restore conversation or code to an earlier point', run: t => {
      if (/^gemini/i.test(t.model || '')) return toast('Not available for Gemini')
      const last = $$('.user', t.messages).pop()
      if (!last) return toast('Nothing to rewind')
      last.closest('.user-row').querySelector('[aria-label="Rewind"]').click()
    } },
    theme: { description: 'Switch light / dark theme', run: () => saveSettings({ theme: isDark() ? 'light' : 'dark' }) },
  },

  runCommand(name, args) {
    const c = this.commands[name]
    if (c) { c.run(this.active, args); return true }
    return false
  },
}

function autosize() {
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'
}

async function send() {
  const tab = App.active
  const text = input.value.trim()
  if (!tab.cwd) return App.pickFolder()
  if (!text && !tab.attachments.length) return
  hideSuggest()
  const clear = () => { input.value = ''; tab.draft = ''; tab.attachments = []; renderAttachments(); autosize(); App.tabChanged(tab) }

  if (text.startsWith('!') && text.length > 1) { clear(); return tab.bash(text.slice(1).trim()) }
  if (text.startsWith('#') && text.length > 1 && !tab.attachments.length) {
    const note = text.slice(1).trim()
    return menu($('#composer'), [
      { header: 'Save memory to' },
      ...[['Project memory', join(tab.cwd, 'CLAUDE.md')], ['Project memory (only me)', join(tab.cwd, 'CLAUDE.local.md')], ['Personal memory', join(App.info.home, '.claude/CLAUDE.md')]]
        .map(([label, file]) => ({ label, icon: 'file-text', run: async () => { await api.appendMemory(file, note); clear(); toast(`Saved to ${file}`) } })),
    ])
  }
  rememberPrompt(text)
  const cmd = text.match(/^\/([\w:-]+)\s*(.*)$/s)
  if (cmd && App.commands[cmd[1]] && !tab.attachments.length) { clear(); return App.runCommand(cmd[1], cmd[2]) }

  const content = [
    ...tab.attachments.map(a => a.kind === 'pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name }
      : { type: 'image', source: { type: 'base64', media_type: a.type, data: a.data } }),
    ...(text ? [{ type: 'text', text }] : []),
  ]
  clear()
  tab.send(content)
}

function renderAttachments() {
  const tab = App.active
  const box = $('#attachments')
  box.replaceChildren(...(tab?.attachments || []).map((a, i) => {
    const chip = el('div', 'attachment', a.kind === 'pdf' ? icon('file-pdf') : Object.assign(el('img'), { src: a.url }), el('span', '', a.name),
      iconButton('x', 'Remove', () => { tab.attachments.splice(i, 1); renderAttachments() }, 'sm'))
    return chip
  }))
}

function addFiles(files) {
  const tab = App.active
  if (!tab.cwd) {
    const dir = files.map(f => api.pathFor(f)).find(Boolean)
    if (dir) api.listDir(dir).then(e => e.length && App.openProject(dir))
    return
  }
  const paths = []
  for (const f of files) {
    if (f.type.startsWith('image/') || f.type === 'application/pdf') {
      const r = new FileReader()
      r.onload = () => {
        tab.attachments.push({ kind: f.type === 'application/pdf' ? 'pdf' : 'image', type: f.type, name: f.name || 'pasted image', data: r.result.split(',')[1], url: r.result })
        renderAttachments()
      }
      r.readAsDataURL(f)
    } else {
      const p = api.pathFor(f)
      if (p) paths.push('@' + App.relPath(tab, p))
    }
  }
  if (paths.length) App.insertText(paths.join(' ') + ' ')
}

let sugg = { items: [], sel: 0, kind: null, start: 0 }

async function updateSuggest() {
  const tab = App.active
  const v = input.value, caret = input.selectionStart
  const before = v.slice(0, caret)
  let items = [], kind = null, start = 0
  const slash = before.match(/^\/([\w:-]*)$/)
  const at = before.match(/(?:^|\s)@([^\s]*)$/)
  if (slash) {
    kind = 'slash'
    const q = slash[1].toLowerCase()
    const seen = new Set()
    const all = [
      ...Object.entries(App.commands).map(([name, c]) => ({ name, description: c.description, app: true })),
      ...tab.meta.commands,
    ].filter(c => !seen.has(c.name) && seen.add(c.name))
    items = all.filter(c => c.name.toLowerCase().includes(q) || c.aliases?.some(a => a.includes(q)))
      .sort((a, b) => b.name.startsWith(q) - a.name.startsWith(q) || a.name.localeCompare(b.name))
      .slice(0, 60)
      .map(c => ({ label: '/' + c.name, detail: [c.argumentHint, c.description].filter(Boolean).join(' · '), insert: '/' + c.name + ' ', icon: c.app ? 'app-window' : 'command' }))
  } else if (at && tab.cwd) {
    kind = 'at'
    start = caret - at[1].length - 1
    const q = at[1].toLowerCase()
    const files = await App.projectFiles(tab)
    const agents = tab.meta.agents.filter(a => a.name.toLowerCase().includes(q)).map(a => ({ label: '@agent-' + a.name, detail: a.description, insert: '@agent-' + a.name + ' ', icon: 'robot' }))
    const dirs = new Set()
    for (const f of files) { const i = f.lastIndexOf('/'); if (i > 0) dirs.add(f.slice(0, i) + '/') }
    const score = f => { const l = f.toLowerCase(), b = basename(l); return b.startsWith(q) ? 0 : b.includes(q) ? 1 : l.includes(q) ? 2 : 9 }
    const matched = [...files, ...dirs].map(f => [score(f), f]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, 50)
    items = [...agents.slice(0, 5), ...matched.map(([, f]) => ({ label: f, detail: '', insert: '@' + f + (f.endsWith('/') ? '' : ' '), icon: f.endsWith('/') ? 'folder' : 'file' }))]
  }
  sugg = { items, sel: 0, kind, start }
  renderSuggest()
}

function renderSuggest() {
  const box = $('#suggest')
  if (!sugg.items.length) return hideSuggest()
  box.replaceChildren(...sugg.items.map((it, i) => {
    const row = el('div', 'sugg' + (i === sugg.sel ? ' sel' : ''), icon(it.icon), el('span', 'sugg-label', it.label), el('span', 'sugg-detail', it.detail))
    row.onmousedown = e => { e.preventDefault(); pickSuggest(i) }
    return row
  }))
  box.hidden = false
  box.children[sugg.sel]?.scrollIntoView({ block: 'nearest' })
}
function hideSuggest() { $('#suggest').hidden = true; sugg.items = [] }
function pickSuggest(i) {
  const it = sugg.items[i]
  if (!it) return
  if (sugg.kind === 'slash') input.value = it.insert
  else {
    const caret = input.selectionStart
    input.value = input.value.slice(0, sugg.start) + it.insert + input.value.slice(caret)
    input.selectionStart = input.selectionEnd = sugg.start + it.insert.length
  }
  hideSuggest()
  autosize()
  input.focus()
  if (it.insert.endsWith('/')) updateSuggest()
}

input.addEventListener('input', () => { autosize(); updateSuggest(); App.active.ensureLive(); App.tabChanged(App.active) })
const promptHistory = () => { try { return JSON.parse(localStorage.getItem('history') || '[]') } catch { return [] } }
let hist = { i: -1, draft: '' }
function rememberPrompt(text) {
  hist = { i: -1, draft: '' }
  if (text) localStorage.setItem('history', JSON.stringify([text, ...promptHistory().filter(x => x !== text)].slice(0, 200)))
}
input.addEventListener('click', () => hideSuggest())
input.addEventListener('keydown', e => {
  const open = !$('#suggest').hidden
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault()
    sugg.sel = (sugg.sel + (e.key === 'ArrowDown' ? 1 : -1) + sugg.items.length) % sugg.items.length
    return renderSuggest()
  }
  if (open && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
    const it = sugg.items[sugg.sel]
    if (!(e.key === 'Enter' && sugg.kind === 'slash' && input.value.trim() === it.insert.trim())) { e.preventDefault(); return pickSuggest(sugg.sel) }
  }
  if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); return hideSuggest() }
  const sendCombo = settings.enterSends ? (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) : (e.key === 'Enter' && (e.ctrlKey || e.metaKey))
  if (sendCombo && !e.isComposing) { e.preventDefault(); send() }
  if (e.key === 'Tab' && !e.shiftKey && !open && !input.value && App.active.suggestion) { e.preventDefault(); return App.setComposer(App.active.suggestion) }
  const up = e.key === 'ArrowUp' && input.selectionStart === 0 && input.selectionEnd === 0
  const down = e.key === 'ArrowDown' && hist.i >= 0 && input.selectionStart === input.value.length
  if (!open && (up || down)) {
    const h = promptHistory(), n = hist.i + (up ? 1 : -1)
    if (n < -1 || n >= h.length) return
    e.preventDefault()
    if (hist.i === -1) hist.draft = input.value
    hist.i = n
    input.value = n === -1 ? hist.draft : h[n]
    autosize()
  }
})
input.addEventListener('paste', e => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles([...e.clipboardData.files]) } })

const FALLBACK_MODELS = [
  { value: 'opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsFastMode: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-fable-5-1[1m]', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', description: 'Haiku 4.5 · Fastest for quick answers', supportsEffort: false },
]
const MORE_MODELS = [
  ['claude-fable-5', 'Fable 5'], ['claude-opus-5', 'Opus 5'], ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'],
  ['claude-opus-4-6', 'Opus 4.6'], ['claude-opus-4-5', 'Opus 4.5'], ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-sonnet-4-5', 'Sonnet 4.5'],
  ['claude-opus-4-0', 'Opus 4'], ['claude-sonnet-4-0', 'Sonnet 4'],
]
function mainModels(tab) {
  const raw = tab?.meta.models.length ? tab.meta.models : FALLBACK_MODELS
  const seen = new Set()
  const list = [...(App.google?.models || []), ...raw].filter(m => m.value !== 'default' && !seen.has(m.value) && seen.add(m.value))
  return list.map(m => {
    const [name, ...rest] = (m.description || '').split(' · ')
    return { ...m, label: name || m.displayName || m.value, detail: rest.join(' · ') }
  })
}
function modelInfo(tab, value = tab.model) {
  const m = mainModels(tab).find(x => x.value === value)
  if (m) return m
  const more = MORE_MODELS.find(([id]) => id === value)
  return { value, label: more?.[1] || value || 'Opus', detail: '' }
}

function renderChips(tab) {
  const mode = MODES.find(m => m.value === tab.mode) || MODES[0]
  $('#mode-chip').replaceChildren(icon(mode.icon), el('span', '', mode.label))
  $('#mode-chip').className = 'chip mode-' + mode.value
  const model = modelInfo(tab)
  $('#model-chip').replaceChildren(el('span', '', model.label), icon('caret-down'))
  const effort = EFFORTS.find(l => l.value === tab.effort) || EFFORTS[1]
  $('#effort-chip').replaceChildren(icon(effort.value === 'ultracode' ? 'sparkle' : 'brain'), el('span', '', effort.label))
  $('#effort-chip').className = 'chip effort-chip lvl-' + effort.value
  $('#effort-chip').hidden = model.supportsEffort === false || (!!model.description && !model.supportsEffort && !model.supportedEffortLevels)
  $('#fast-chip').hidden = !model.supportsFastMode
  $('#fast-chip').classList.toggle('on', tab.fast)
}

function setMode(tab, value) {
  tab.mode = value
  if (tab.live) api.control(tab.id, 'setPermissionMode', value)
  App.tabChanged(tab)
}
function setModel(tab, value) {
  const prevGemini = /^gemini/i.test(tab.model || '')
  const nextGemini = /^gemini/i.test(value || '')
  tab.model = value
  if (tab.live) {
    if (prevGemini !== nextGemini) tab.start()
    else api.control(tab.id, 'setModel', value).catch(e => toast(String(e.message || e), 'err'))
  }
  App.tabChanged(tab)
}
function setEffort(tab, value) {
  const was = tab.effort
  tab.effort = value
  const flags = value === 'ultracode' ? { effortLevel: 'max', ultracode: true } : { effortLevel: value, ...(was === 'ultracode' && { ultracode: false }) }
  if (tab.live) api.control(tab.id, 'applyFlagSettings', flags).catch(() => toast('Ultracode is not available for this model or account', 'err'))
  App.tabChanged(tab)
}

$('#mode-chip').onclick = e => {
  const tab = App.active
  menu(e.currentTarget, [{ header: 'Permission mode  ·  Shift+Tab' }, ...MODES.map(m => ({ label: m.label, icon: m.icon, checked: tab.mode === m.value, run: () => setMode(tab, m.value) }))])
}
$('#model-chip').onclick = e => {
  const tab = App.active
  const more = MORE_MODELS.map(([id, label]) => ({ label, detail: id, icon: 'clock-counter-clockwise', checked: tab.model === id, run: () => setModel(tab, id) }))
  const legacySelected = MORE_MODELS.some(([id]) => id === tab.model)
  menu(e.currentTarget, [{ header: 'Model' },
    ...mainModels(tab).map(m => ({ label: m.label, detail: m.detail, icon: /^gemini/i.test(m.value) ? 'sparkle' : 'cpu', checked: tab.model === m.value, run: () => setModel(tab, m.value) })),
    '-', ...(legacySelected ? [{ header: 'More models' }, ...more] : [{ label: 'More models', icon: 'stack', more }])])
}
$('#effort-chip').onclick = e => {
  const tab = App.active
  const supported = modelInfo(tab).supportedEffortLevels
  const levels = EFFORTS.filter(l => !supported || supported.includes(l.value) || l.value === 'ultracode')
  const range = el('input', 'effort-range')
  Object.assign(range, { type: 'range', min: 0, max: levels.length - 1, step: 1, value: Math.max(0, levels.findIndex(l => l.value === tab.effort)) })
  range.setAttribute('aria-label', 'Reasoning effort')
  const name = el('b'), hint = el('span', 'muted small')
  const ticks = el('div', 'effort-ticks', ...levels.map((l, k) => {
    const b = el('button', 'ghost', l.label)
    b.onclick = () => { range.value = k; update(true) }
    return b
  }))
  const box = el('div', 'effort-pop', el('div', 'effort-top', name, hint), el('div', 'effort-track', range), ticks)
  function update(commit) {
    const k = +range.value, l = levels[k]
    name.textContent = l.label
    hint.textContent = l.hint
    box.classList.toggle('ultra', l.value === 'ultracode')
    range.style.setProperty('--p', k / (levels.length - 1))
    ;[...ticks.children].forEach((b, j) => b.classList.toggle('on', j === k))
    if (commit && l.value !== tab.effort) setEffort(tab, l.value)
  }
  range.oninput = () => update(false)
  range.onchange = () => update(true)
  update(false)
  popover(e.currentTarget, box, 'effort-menu')
  range.focus()
}
$('#fast-chip').onclick = () => {
  const tab = App.active
  tab.fast = !tab.fast
  if (tab.live) api.control(tab.id, 'applyFlagSettings', { fastMode: tab.fast })
  App.tabChanged(tab)
}

function renderStatus(tab) {
  const mode = MODES.find(m => m.value === tab.mode) || MODES[0]
  $('#st-mode').replaceChildren(el('kbd', '', 'Shift+Tab'), el('span', '', 'mode'))
  $('#mode-chip').title = `${mode.label} (Shift+Tab to switch)`
  $('#st-msg').textContent = tab.busy ? (tab.permissions ? 'Waiting for you' : 'Working… Esc to stop') : tab.statusMsg || ''
  $('#st-msg').classList.toggle('working', tab.busy && !tab.permissions)
  $('#st-line').textContent = tab.statusLine || ''
  $('#st-cost').textContent = tab.cost ? `$${tab.cost.toFixed(tab.cost < 1 ? 3 : 2)}` : ''
  const ctx = $('#st-ctx')
  if (tab.context) {
    const pct = Math.round(tab.context.percentage)
    const ring = `<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-opacity=".2" stroke-width="3"/><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="${pct * 0.503} 50.3" transform="rotate(-90 10 10)" stroke-linecap="round"/></svg>`
    ctx.innerHTML = ring
    ctx.append(el('span', '', `${pct}% context`))
    ctx.classList.toggle('warn', pct > 75)
    ctx.hidden = false
  } else ctx.hidden = true
}
$('#st-ctx').onclick = () => Panels.show('context')

function renderTodoStrip(tab) {
  const strip = $('#todo-strip')
  const todos = tab.todos
  if (!todos.length || todos.every(t => t.status === 'completed')) { strip.hidden = true; return }
  const done = todos.filter(t => t.status === 'completed').length
  const cur = todos.find(t => t.status === 'in_progress') || todos.find(t => t.status === 'pending')
  const list = tab.todoList(todos)
  list.hidden = !strip.classList.contains('open')
  const head = el('button', 'todo-head ghost', icon('list-checks'), el('span', 'grow', cur?.activeForm || cur?.content || ''),
    el('span', 'muted', `${done}/${todos.length}`), icon(list.hidden ? 'caret-up' : 'caret-down'))
  head.onclick = () => { strip.classList.toggle('open'); renderTodoStrip(tab) }
  strip.replaceChildren(head, list)
  strip.hidden = false
}

function renderSessions() {
  const tab = App.active
  const q = $('#session-search').value.toLowerCase()
  const list = (App.sessionList || []).filter(s => !q || [s.customTitle, s.summary, s.firstPrompt, s.gitBranch].join(' ').toLowerCase().includes(q))
  const nav = $('#sessions')
  if (!list.length) { nav.replaceChildren(el('div', 'side-empty', q ? 'No matching conversations.' : 'No conversations yet.')); return }
  const day = 86400000, now = new Date().setHours(0, 0, 0, 0)
  const group = t => t >= now ? 'Today' : t >= now - day ? 'Yesterday' : t >= now - 7 * day ? 'Previous 7 days' : t >= now - 30 * day ? 'Previous 30 days' : 'Older'
  const out = []
  let last
  const pinned = new Set(settings.pinned)
  list.sort((a, b) => pinned.has(b.sessionId) - pinned.has(a.sessionId))
  for (const s of list) {
    const g = pinned.has(s.sessionId) ? 'Pinned' : group(s.lastModified)
    if (g !== last) { out.push(el('div', 'side-group', g)); last = g }
    const title = s.customTitle || s.summary || s.firstPrompt || 'Untitled'
    const item = el('div', 'session' + (s.sessionId === tab.sessionId ? ' active' : ''),
      pinned.has(s.sessionId) ? icon('push-pin', 'pin') : null,
      el('span', 'session-title', title),
      iconButton('dots-three', 'More', e => { e.stopPropagation(); sessionMenu(e.currentTarget, s, title) }, 'sm session-more'))
    item.dataset.id = s.sessionId
    item.title = `${title}\n${ago(s.lastModified)}${s.gitBranch ? ' · ' + s.gitBranch : ''}`
    item.onclick = e => App.openProject(tab.cwd, s.sessionId, { newTab: e.ctrlKey || e.metaKey })
    item.onauxclick = e => { if (e.button === 1) App.openProject(tab.cwd, s.sessionId, { newTab: true }) }
    item.oncontextmenu = e => { e.preventDefault(); sessionMenu(e, s, title) }
    out.push(item)
  }
  nav.replaceChildren(...out)
}
$('#session-search').oninput = debounce(renderSessions, 80)

function sessionMenu(anchor, s, title) {
  const cwd = App.active.cwd
  menu(anchor, [
    { label: 'Open in new tab', icon: 'plus', run: () => App.openProject(cwd, s.sessionId, { newTab: true }) },
    settings.pinned.includes(s.sessionId)
      ? { label: 'Unpin', icon: 'push-pin-slash', run: () => { saveSettings({ pinned: settings.pinned.filter(x => x !== s.sessionId) }); renderSessions() } }
      : { label: 'Pin to top', icon: 'push-pin', run: () => { saveSettings({ pinned: [...settings.pinned, s.sessionId] }); renderSessions() } },
    { label: 'Rename', icon: 'pencil-simple', run: async () => {
      const t = await prompt('Rename conversation', title)
      if (t) { await api.renameSession(s.sessionId, t, cwd); App.refreshSessions(); for (const tab of App.tabs.values()) if (tab.sessionId === s.sessionId) { tab.title = t; App.tabChanged(tab) } }
    } },
    ...(/^gemini/i.test(s.model || '') ? [] : [{ label: 'Fork (duplicate)', icon: 'git-fork', run: async () => { const r = await api.forkSession(s.sessionId, cwd); App.openProject(cwd, r.sessionId, { newTab: true }) } }]),
    { label: 'Export as Markdown', icon: 'export', run: async () => { const t = new Tab(cwd); t.sessionId = s.sessionId; t.title = title; await t.exportMarkdown() } },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      if (!await confirmDialog('Delete conversation?', `"${title}" will be permanently deleted.`, 'Delete', true)) return
      for (const tab of App.tabs.values()) if (tab.sessionId === s.sessionId) await tab.open(null)
      await api.deleteSession(s.sessionId, cwd)
      App.refreshSessions()
    } },
  ])
}

async function recentProjects() {
  const all = await api.listSessions()
  const map = new Map()
  for (const s of all) if (s.cwd) {
    const p = map.get(s.cwd) || { cwd: s.cwd, last: 0, count: 0 }
    p.last = Math.max(p.last, s.lastModified); p.count++
    map.set(s.cwd, p)
  }
  let mine = []
  try { mine = JSON.parse(localStorage.getItem('projects') || '[]') } catch {}
  for (const m of mine) if (!map.has(m.cwd)) map.set(m.cwd, { cwd: m.cwd, last: m.last, count: 0 })
  return [...map.values()].sort((a, b) => b.last - a.last)
}
function rememberProject(cwd) {
  try {
    const list = JSON.parse(localStorage.getItem('projects') || '[]').filter(p => p.cwd !== cwd)
    localStorage.setItem('projects', JSON.stringify([{ cwd, last: Date.now() }, ...list].slice(0, 30)))
  } catch {}
}

async function renderWelcome() {
  const projects = (await recentProjects()).slice(0, 9)
  $('#recent').replaceChildren(...projects.map((p, i) => {
    const card = el('button', 'project-card', el('span', 'pc-name', icon('folder'), basename(p.cwd)), el('span', 'pc-path', p.cwd),
      el('span', 'pc-meta', `${ago(p.last)}${p.count ? ` · ${p.count} conversation${p.count === 1 ? '' : 's'}` : ''}`))
    card.style.setProperty('--i', i)
    card.onclick = () => App.openProject(p.cwd)
    return card
  }))
  if (!projects.length) $('#recent').append(el('div', 'muted', 'No recent projects yet.'))
}

$('#project-switch').onclick = async e => {
  const anchor = e.currentTarget
  const projects = (await recentProjects()).slice(0, 12)
  menu(anchor, [
    { label: 'Open folder…', icon: 'folder-open', hint: 'Ctrl O', run: () => App.pickFolder() },
    { label: 'Open folder in new tab…', icon: 'plus', run: () => App.pickFolder({ newTab: true }) },
    '-', { header: 'Recent' },
    ...projects.map(p => ({ label: basename(p.cwd) + '  ' + p.cwd.replace(App.info.home, '~'), icon: 'folder', checked: p.cwd === App.active.cwd, run: () => App.openProject(p.cwd) })),
  ])
}

App.usage = null
App.refreshUsage = debounce(async tab => {
  const u = await api.usage(tab?.live ? tab.id : null).catch(() => null)
  if (u) { App.usage = u; renderUsageMeter() }
}, 1500)

function renderUsageMeter() {
  const w = App.usage?.rate_limits?.five_hour
  const b = $('#st-usage')
  b.hidden = !w || w.utilization == null
  if (b.hidden) return
  const pct = Math.round(w.utilization)
  b.className = 'ghost' + (pct >= 100 ? ' full' : pct >= 75 ? ' warn' : '')
  b.replaceChildren(el('span', 'mini-bar', Object.assign(el('span'), { style: `width:${Math.min(pct, 100)}%` })), el('span', '', `${pct}% session`))
  b.title = `Session limit ${pct}% used` + (w.resets_at ? ` · resets ${clock(Date.parse(w.resets_at))}` : '')
}

const BEHAVIORS = {
  long_context: ['Long conversations', 'Requests sent with more than 150k tokens of context. /compact or a fresh conversation helps.'],
  subagent_heavy: ['Subagent-heavy sessions', 'Each subagent reads its own context, so many subagents add up fast.'],
  cache_miss: ['Cache misses', 'Coming back to a conversation after a long break re-reads all of it.'],
  high_parallel: ['Many sessions at once', 'Parallel sessions all draw from the same limit.'],
  cron: ['Scheduled and looping tasks', 'Loops and scheduled tasks keep running on their own.'],
}

function usageView(u, tab) {
  if (!u) return [el('p', 'muted', 'Could not load usage. Make sure Claude Code is signed in.')]
  const r = u.rate_limits || {}
  const meter = (label, pct, detail) => {
    pct = Math.round(pct ?? 0)
    return el('div', 'meter' + (pct >= 100 ? ' full' : pct >= 75 ? ' warn' : ''),
      el('div', 'meter-head', el('b', '', label), el('span', 'mono', `${pct}% used`)),
      el('div', 'meter-bar', Object.assign(el('span'), { style: `width:${Math.min(pct, 100)}%` })),
      detail ? el('div', 'muted small', detail) : null)
  }
  const resets = w => w.resets_at ? `Resets ${clock(Date.parse(w.resets_at))}, in${until(Date.parse(w.resets_at))}` : ''
  const windows = [['Current session', r.five_hour], ['This week, all models', r.seven_day], ['This week, Opus', r.seven_day_opus],
    ['This week, Sonnet', r.seven_day_sonnet], ...(r.model_scoped || []).map(w => [`This week, ${w.display_name}`, w])]
    .filter(([, w]) => w && w.utilization != null)
  const acct = App.account || {}
  const out = [el('div', 'usage-head',
    el('span', 'pill', u.subscription_type ? `Claude ${u.subscription_type[0].toUpperCase() + u.subscription_type.slice(1)}` : acct.authMethod || 'API'),
    el('span', 'muted', acct.email || ''))]
  if (!u.rate_limits_available) out.push(el('p', 'muted', 'Plan limits don\'t apply to this sign-in (API key, Bedrock, Vertex or similar). You pay per token instead.'))
  out.push(el('div', 'meters', ...windows.map(([l, w]) => meter(l, w.utilization, resets(w)))))
  const x = r.extra_usage
  if (x) out.push(x.is_enabled
    ? meter('Extra usage', x.utilization, x.monthly_limit != null ? `${x.used_credits ?? 0} of ${x.monthly_limit}${x.currency || ''} this month` : '')
    : el('p', 'muted small', 'Extra usage is off. Claude stops at the limit and continues after it resets.'))
  const rows = r.seven_day_breakdown?.rows?.filter(x => x.percent > 0)
  if (rows?.length) out.push(el('h3', '', 'This week by product'), el('div', 'bars', ...rows.map(x => meter(x.display_name, x.percent))))
  const s = u.session
  if (s && (s.total_cost_usd || Object.keys(s.model_usage || {}).length)) {
    out.push(el('h3', '', 'This conversation'), el('div', 'kv',
      el('span', '', 'Cost (API pricing)'), el('span', 'mono', `$${s.total_cost_usd.toFixed(3)}`),
      el('span', '', 'Time spent'), el('span', 'mono', `${(s.total_api_duration_ms / 1000).toFixed(0)} s API,${(s.total_duration_ms / 60000).toFixed(1)} min total`),
      el('span', '', 'Code changed'), el('span', 'mono', `+${s.total_lines_added} −${s.total_lines_removed} lines`),
      ...Object.entries(s.model_usage).flatMap(([m, v]) => [el('span', '', m), el('span', 'mono',
        `${fmtTokens(v.inputTokens + v.cacheReadInputTokens + v.cacheCreationInputTokens)} in (${fmtTokens(v.cacheReadInputTokens)} cached) · ${fmtTokens(v.outputTokens)} out · $${v.costUSD.toFixed(3)}`)])))
  }
  const b = u.behaviors
  if (b) {
    const period = (title, p) => el('div', 'period',
      el('div', 'meter-head', el('b', '', title), el('span', 'muted small', `${p.request_count} requests · ${p.session_count} sessions`)),
      ...p.behaviors.map(x => el('div', 'behavior', el('span', 'mono', `${x.pct}%`), el('div', '', el('div', '', BEHAVIORS[x.key]?.[0] || x.key), el('div', 'muted small', BEHAVIORS[x.key]?.[1] || '')))),
      ...[['Skills', p.skills], ['Subagents', p.agents], ['Plugins', p.plugins], ['MCP servers', p.mcp_servers]].filter(([, l]) => l?.length)
        .map(([t, l]) => el('div', 'muted small', `${t}: ` + l.slice(0, 5).map(x => `${x.name}${x.pct}%`).join(', '))))
    out.push(el('h3', '', 'What used it'), el('p', 'muted small', 'Estimated from conversations on this computer. Other devices and claude.ai are not included. These overlap, so they don\'t add up to 100%.'),
      el('div', 'periods', period('Last 24 hours', b.day), period('Last 7 days', b.week)))
  }
  const auto = el('input', 'switch'); auto.type = 'checkbox'; auto.checked = settings.autoContinue
  auto.onchange = () => { saveSettings({ autoContinue: auto.checked }); App.tabs.forEach(t => t.renderResume()) }
  out.push(el('label', 'setting', el('div', '', el('div', 'setting-label', 'Continue automatically after a limit resets'),
    el('div', 'muted small', 'If Claude is stopped mid-task by a usage limit, it picks the task back up when the limit resets, even after restarting the app.')), auto))
  out.push(el('div', 'row end', button('Open usage on claude.ai', () => api.openExternal('https://claude.ai/settings/usage'), 'ghost', 'arrow-square-out'),
    button('Refresh', () => openUsage(tab), '', 'arrows-clockwise')))
  return out
}

async function openUsage(tab = App.active) {
  $('.modal-back.usage-modal')?.remove()
  const body = el('div', 'usage stack', el('p', 'muted', 'Loading usage…'))
  const m = modal('Usage and limits', body, { wide: true })
  m.box.parentElement.classList.add('usage-modal')
  const u = await api.usage(tab?.live ? tab.id : null, true).catch(() => null)
  if (u) { App.usage = u; renderUsageMeter() }
  body.replaceChildren(...usageView(u, tab))
}
$('#open-usage').onclick = () => openUsage()
$('#st-usage').onclick = () => openUsage()

function signInAgy() {
  if (!App.info.agyPath) return toast('Install the Antigravity CLI first: curl -fsSL https://antigravity.google/cli/install.sh | bash', 'err')
  Terminals.run(App.active, JSON.stringify(App.info.agyPath))
  toast('Finish signing in to Google in the terminal, then press Refresh in Antigravity settings')
}
function useGemini(tab) {
  const m = App.google?.models?.[0]?.value
  if (!m) return toast(App.info.agyPath ? 'Sign in to Antigravity first' : 'Install the Antigravity CLI first', 'err')
  setModel(tab, m)
  toast('Switched to ' + modelInfo(tab, m).label)
}

async function loadAccount() {
  const [r, g] = await Promise.all([api.cli(['auth', 'status']), api.googleStatus().catch(() => ({}))])
  let s = {}
  try { s = JSON.parse(r.stdout) } catch {}
  App.account = s
  App.google = g || {}
  const label = s.loggedIn
    ? (s.email || s.account?.email || (s.authMethod === 'claude.ai' ? 'Claude account' : s.authMethod))
    : g?.loggedIn ? 'Antigravity' : 'Sign in'
  $('#account-name').textContent = label
}
$('#account').onclick = e => {
  const s = App.account || {}
  const g = App.google || {}
  menu(e.currentTarget, [
    ...(s.loggedIn ? [
      { header: [s.email, s.subscriptionType || s.authMethod, s.apiProvider].filter(Boolean).join(' · ') },
      { label: 'Usage and limits', icon: 'gauge', run: () => openUsage() },
      { label: 'Sign out of Claude', icon: 'sign-out', run: () => App.runCommand('logout') },
    ] : [{ label: 'Sign in to Claude', icon: 'sign-in', run: async () => { toast('Finish signing in in your browser'); await api.cli(['auth', 'login']); loadAccount() } }]),
    '-',
    { header: `Antigravity · ${!g.installed ? 'Not installed' : g.loggedIn ? 'Signed in' : 'Not signed in'}` },
    ...(g.loggedIn ? [] : [{ label: 'Sign in with Google (Antigravity)', icon: 'sign-in', run: signInAgy }]),
    { label: 'Use Gemini in this tab', icon: 'cpu', run: () => useGemini(App.active) },
    { label: 'Antigravity Settings', icon: 'gear', run: () => openSettings('google') },
  ])
}

$('#chat-title').onclick = async () => {
  const tab = App.active
  if (!tab.sessionId) return
  const t = await prompt('Rename conversation', tab.title)
  if (!t) return
  await api.renameSession(tab.sessionId, t, tab.cwd)
  tab.title = t
  App.tabChanged(tab)
  App.refreshSessions()
}
$('#chat-path').onclick = e => {
  const tab = App.active
  menu(e.currentTarget, [
    { label: 'Open in file manager', icon: 'folder-open', run: () => api.openPath(tab.cwd) },
    { label: 'Open terminal here', icon: 'terminal-window', run: () => Panels.show('terminal') },
    { label: 'Copy path', icon: 'copy', run: () => copy(tab.cwd) },
    { label: 'Add another folder…', icon: 'plus', run: () => App.runCommand('add-dir') },
    ...tab.addDirs.map(d => ({ label: 'Also: ' + d, icon: 'folder', run: () => api.openPath(d) })),
  ])
}

function openPalette() {
  const tab = App.active
  const inputEl = el('input', 'field'); inputEl.placeholder = 'Type a command, conversation or project'
  const list = el('div', 'palette-list')
  const actions = [
    ['Use Gemini (Antigravity)', 'sparkle', () => useGemini(tab)],
    ['Antigravity Settings', 'gear', () => openSettings('google')],
    ['New tab', 'plus', () => App.newTab(null), 'Ctrl T'],
    ['New conversation', 'chat-circle', () => tab.cwd ? tab.open(null) : App.pickFolder()],
    ['Open folder…', 'folder-open', () => App.pickFolder(), 'Ctrl O'],
    ['Close tab', 'x', () => App.closeTab(), 'Ctrl W'],
    ['Settings', 'gear', () => openSettings(), 'Ctrl ,'],
    ['Find in conversation', 'magnifying-glass', () => openFind(), 'Ctrl F'],
    ['Export conversation', 'export', () => tab.exportMarkdown(), 'Ctrl Shift E'],
    ['Toggle sidebar', 'sidebar-simple', () => saveSettings({ sidebar: !settings.sidebar }), 'Ctrl B'],
    ['Toggle panel', 'columns', () => Panels.toggle(), 'Ctrl J'],
    ...PANELS.map(p => [`Show ${p.label}`, p.icon, () => Panels.show(p.id)]),
    ...MODES.map(m => [`Mode: ${m.label}`, m.icon, () => setMode(tab, m.value)]),
    ['Theme: light', 'sun', () => saveSettings({ theme: 'light' })],
    ['Theme: dark', 'moon', () => saveSettings({ theme: 'dark' })],
    ['Theme: system', 'circle-half', () => saveSettings({ theme: 'system' })],
    ['Keyboard shortcuts', 'keyboard', () => openHelp()],
    ['Copy conversation as Markdown', 'copy', async () => copy(await tab.markdown())],
    ['Copy last reply', 'copy', () => App.runCommand('copy')],
    ['Usage and limits', 'gauge', () => openUsage()],
  ].map(([label, ic, run, hint]) => ({ label, icon: ic, run, hint }))
  const commands = [...Object.entries(App.commands).map(([n, c]) => ({ name: n, description: c.description })), ...tab.meta.commands]
    .filter((c, i, a) => a.findIndex(x => x.name === c.name) === i)
    .map(c => ({ label: '/' + c.name, detail: c.description, icon: 'command', run: () => App.setComposer('/' + c.name + ' ') }))
  const sessions = (App.sessionList || []).slice(0, 50).map(s => ({ label: s.customTitle || s.summary || s.firstPrompt || 'Untitled', detail: ago(s.lastModified), icon: 'chats', run: () => App.openProject(tab.cwd, s.sessionId) }))
  let projects = []
  recentProjects().then(p => { projects = p.slice(0, 20).map(x => ({ label: basename(x.cwd), detail: x.cwd, icon: 'folder', run: () => App.openProject(x.cwd) })); draw() })
  let sel = 0, shown = []
  function draw() {
    const words = inputEl.value.toLowerCase().split(/\s+/).filter(Boolean)
    shown = [...actions, ...commands, ...sessions, ...projects].filter(it => words.every(w => (it.label + ' ' + (it.detail || '')).toLowerCase().includes(w))).slice(0, 80)
    sel = Math.min(sel, Math.max(0, shown.length - 1))
    list.replaceChildren(...shown.map((it, i) => {
      const row = el('div', 'sugg' + (i === sel ? ' sel' : ''), icon(it.icon), el('span', 'sugg-label', it.label), el('span', 'sugg-detail', it.detail || ''), it.hint ? el('kbd', '', it.hint) : null)
      row.onclick = () => { m.close(); it.run() }
      return row
    }))
    list.children[sel]?.scrollIntoView({ block: 'nearest' })
  }
  inputEl.oninput = () => { sel = 0; draw() }
  inputEl.onkeydown = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; draw() }
    if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); m.close(); shown[sel].run() }
  }
  const m = modal('Command palette', el('div', 'stack', inputEl, list), { wide: true })
  m.box.classList.add('palette')
  draw()
}

function openSettings(section = 'appearance') {
  const tab = App.active
  const row = (label, control, hint) => el('div', 'setting', el('div', 'setting-text', el('div', 'setting-label', label), hint ? el('div', 'muted small', hint) : null), control)
  const select = (key, options, onchange) => {
    const opt = ([v, l]) => Object.assign(el('option', '', l), { value: v, selected: settings[key] === v })
    const group = o => { const g = el('optgroup'); g.label = o.group; g.append(...o.items.map(opt)); return g }
    const s = el('select', 'field', ...options.map(o => Array.isArray(o) ? opt(o) : group(o)))
    s.onchange = () => { saveSettings({ [key]: s.value }); onchange?.(s.value) }
    return s
  }
  const segmented = (key, options, after) => {
    const g = el('div', 'segmented')
    const draw = () => g.replaceChildren(...options.map(([v, l, ic]) => {
      const b = button(l, () => { saveSettings({ [key]: v }); draw(); after?.() }, settings[key] === v ? 'on' : '', ic)
      return b
    }))
    draw()
    return g
  }
  const toggle = key => { const c = el('input', 'switch'); c.type = 'checkbox'; c.checked = settings[key]; c.onchange = () => saveSettings({ [key]: c.checked }); return c }
  const range = (key, min, max, step, unit = '') => {
    const out = el('span', 'mono muted', settings[key] + unit)
    const r = el('input'); Object.assign(r, { type: 'range', min, max, step, value: settings[key] })
    r.oninput = () => { saveSettings({ [key]: +r.value }); out.textContent = r.value + unit }
    return el('div', 'range-row', r, out)
  }
  const swatches = () => {
    const g = el('div', 'swatches')
    const draw = () => g.replaceChildren(...Object.entries(ACCENTS).map(([k, [label, light, dark]]) => {
      const b = el('button', 'swatch' + (settings.accent === k ? ' on' : ''))
      b.style.setProperty('--sw', isDark() ? dark : light)
      b.title = label
      b.setAttribute('aria-label', label)
      b.onclick = () => { saveSettings({ accent: k }); draw() }
      return b
    }), (() => {
      const c = el('input', 'swatch custom' + (settings.accent === 'custom' ? ' on' : ''))
      Object.assign(c, { type: 'color', value: settings.accentCustom, title: 'Custom color' })
      c.oninput = () => saveSettings({ accent: 'custom', accentCustom: c.value })
      c.onchange = draw
      return c
    })())
    draw()
    return g
  }
  const palettes = () => {
    const g = el('div', 'palettes')
    const draw = () => g.replaceChildren(...Object.entries(PALETTES).map(([k, label]) => {
      const b = el('button', 'palette-card' + (settings.palette === k ? ' on' : ''), el('span', 'pc-swatch p-' + k), el('span', '', label))
      b.onclick = () => { saveSettings({ palette: k }); draw() }
      return b
    }))
    draw()
    return g
  }
  const models = mainModels(tab).map(m => [m.value, m.label])
  const acct = App.account || {}
  const css = el('textarea', 'field mono css-box')
  css.value = settings.customCss
  css.placeholder = '.md { letter-spacing: .01em; }'
  css.spellcheck = false
  css.oninput = debounce(() => saveSettings({ customCss: css.value }), 300)
  const editor = el('input', 'field mono')
  Object.assign(editor, { value: settings.editor, placeholder: 'code, cursor, zed, subl, or empty for the system default' })
  editor.onchange = () => saveSettings({ editor: editor.value.trim() })

  const sections = {
    appearance: ['Appearance', 'palette', () => [
      row('Theme', segmented('theme', [['system', 'System', 'circle-half'], ['light', 'Light', 'sun'], ['dark', 'Dark', 'moon']], () => { pane.replaceChildren(...sections.appearance[2]()) })),
      row('Background', palettes(), 'Midnight is near-black in dark mode, crisp white in light mode.'),
      row('Accent color', swatches()),
      row('Interface font', segmented('uiFont', [['geist', 'Geist'], ['system', 'System']])),
      row('Reading font', segmented('proseFont', [['serif', 'Serif'], ['sans', 'Sans'], ['mono', 'Mono']]), 'Used for replies and headings.'),
      row('Code font', segmented('monoFont', [['geist', 'Geist Mono'], ['system', 'System']])),
      row('Text size', range('fontSize', 12, 19, 1, 'px')),
      row('Conversation width', range('chatWidth', 560, 1400, 20, 'px')),
      row('Density', segmented('density', [['compact', 'Compact'], ['comfortable', 'Comfortable'], ['spacious', 'Spacious']])),
      row('Corners', segmented('radius', [['sharp', 'Sharp'], ['soft', 'Soft'], ['round', 'Round']])),
      row('Animations', toggle('motion'), 'Off also follows your system\'s reduced motion setting.'),
    ]],
    chat: ['Chat', 'chat-circle', () => [
      row('Enter sends', toggle('enterSends'), 'Off: Ctrl+Enter sends and Enter adds a new line.'),
      row('Show thinking', toggle('showThinking')),
      row('Expand tool details', toggle('expandTools'), 'Open every tool call by default instead of only edits and plans.'),
      row('Desktop notifications', toggle('notifications'), 'When agent finishes or needs you while the window is in the background.'),
      row('Sound when done', toggle('sounds')),
      row('Continue after a usage limit resets', toggle('autoContinue')),
    ]],
    defaults: ['New conversations', 'sliders-horizontal', () => [
      row('Permission mode', select('defaultMode', MODES.map(m => [m.value, m.label]))),
      row('Model', select('defaultModel', [...models, { group: 'More models', items: MORE_MODELS }])),
      row('Reasoning effort', select('defaultEffort', EFFORTS.map(l => [l.value, l.label]))),
    ]],
    google: ['Antigravity', 'sparkle', () => [
      el('div', 'kv',
        el('span', '', 'Antigravity CLI'), el('span', 'mono', App.info.agyPath || 'Not installed'),
        el('span', '', 'Google account'), el('span', '', App.google?.loggedIn ? 'Signed in' : 'Not signed in'),
        el('span', '', 'Models'), el('span', 'mono', (App.google?.models || []).map(x => x.value).join(', ') || 'None')),
      ...(App.info.agyPath ? [] : [row('Install', el('code', 'mono', 'curl -fsSL https://antigravity.google/cli/install.sh | bash'), 'Restart Codedesk after installing.')]),
      el('div', 'row wrap',
        App.google?.loggedIn ? null : button('Sign in with Google', () => { m.close(); signInAgy() }, 'primary', 'sign-in'),
        button('Refresh', async () => { await loadAccount(); show('google') }, 'ghost', 'arrows-clockwise'),
        button('Use Gemini now', () => { m.close(); useGemini(tab) }, '', 'sparkle')),
    ]],
    claude: ['Claude Code', 'terminal', () => [
      el('div', 'kv',
        el('span', '', 'Account'), el('span', '', acct.loggedIn ? [acct.email, acct.subscriptionType || acct.authMethod].filter(Boolean).join(', ') : 'Not signed in'),
        el('span', '', 'CLI'), el('span', 'mono', App.info.claudePath),
        el('span', '', 'Claude Code'), el('span', 'cc-version', tab.meta.version || '…'),
        el('span', '', 'Codedesk'), el('span', '', App.info.version)),
      row('Editor command', editor, 'Used by "Open in editor". Line numbers are passed with -g for VS Code style editors.'),
      el('div', 'row wrap',
        button('settings.json', () => App.openInEditor(join(App.info.home, '.claude/settings.json')), '', 'file-text'),
        button('Personal CLAUDE.md', () => App.openFile(join(App.info.home, '.claude/CLAUDE.md')), '', 'file-text'),
        button('Usage and limits', () => openUsage(), '', 'gauge'),
        acct.loggedIn ? button('Sign out', () => App.runCommand('logout'), 'ghost', 'sign-out') : button('Sign in', () => App.runCommand('login'), 'primary', 'sign-in')),
    ]],
    advanced: ['Advanced', 'code', () => [
      el('div', 'setting-text', el('div', 'setting-label', 'Custom CSS'), el('div', 'muted small', 'Applied on top of the app styles. Every variable in the theme can be overridden here.')),
      css,
      el('div', 'row', button('Reset all settings', async () => {
        if (!await confirmDialog('Reset settings?', 'Appearance and defaults go back to how they were on first launch.', 'Reset', true)) return
        localStorage.removeItem('settings'); Object.assign(settings, DEFAULTS); applySettings(); m.close(); openSettings()
      }, 'ghost danger', 'arrow-counter-clockwise')),
    ]],
  }
  const pane = el('div', 'settings-pane')
  const nav = el('nav', 'settings-nav')
  const show = id => {
    section = id
    pane.replaceChildren(el('h3', '', sections[id][0]), ...sections[id][2]())
    $$('button', nav).forEach(b => b.classList.toggle('on', b.dataset.id === id))
    if (id === 'claude' && !tab.meta.version) api.cli(['--version']).then(r => { const v = $('.cc-version'); if (v) v.textContent = r.stdout.trim() || '-' })
  }
  for (const [id, [label, ic]] of Object.entries(sections)) { const b = button(label, () => show(id), '', ic); b.dataset.id = id; nav.append(b) }
  const m = modal('Settings', el('div', 'settings', nav, pane), { wide: true })
  m.box.classList.add('settings-modal')
  show(section)
  $('button.on', nav).focus()
}

function openHelp() {
  const rows = [
    ['Enter', 'Send (Shift+Enter for a new line)'], ['Esc', 'Stop agent'], ['Shift+Tab', 'Cycle permission mode'],
    ['↑ / ↓', 'Previous prompts'], ['Tab in empty box', 'Use the suggested prompt'], ['Esc Esc', 'Rewind to an earlier message'], ['/', 'Slash commands, skills and custom commands'], ['@', 'Mention files, folders or agents'],
    ['!command', 'Run a shell command and give agent the output'], ['#note', 'Save a note to CLAUDE.md memory'],
    ['Ctrl+K', 'Command palette'], ['Ctrl+T / Ctrl+W', 'New tab / close tab'], ['Ctrl+Tab', 'Next tab'], ['Ctrl+1…9', 'Go to tab'],
    ['Ctrl+O', 'Open folder'], ['Ctrl+F', 'Find in conversation'], ['Ctrl+B', 'Toggle sidebar'], ['Ctrl+J', 'Toggle panel'],
    ['Ctrl+`', 'Terminal'], ['Ctrl+,', 'Settings'], ['Ctrl+Shift+E', 'Export conversation'], ['Ctrl+= / Ctrl+-', 'Zoom'],
    ['1 / 2 / 3', 'Answer a permission prompt'],
  ]
  modal('Keyboard shortcuts', el('div', 'kv wide', ...rows.flatMap(([k, d]) => [el('span', '', ...k.split(/(?<=\S)\s?\/\s?(?=\S)|\+/).flatMap((p, i, a) => [el('kbd', '', p.trim()), i < a.length - 1 ? '' : null])), el('span', '', d)])))
}

function openFind() {
  $('#findbar').hidden = false
  $('#find-input').select()
  $('#find-input').focus()
}
function closeFind() { $('#findbar').hidden = true; api.find(''); $('#find-count').textContent = ''; input.focus() }
$('#find-input').oninput = () => api.find($('#find-input').value, { findNext: false })
$('#find-input').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); api.find($('#find-input').value, { findNext: true, forward: !e.shiftKey }) }
  if (e.key === 'Escape') closeFind()
}
$('#find-next').onclick = () => api.find($('#find-input').value, { findNext: true, forward: true })
$('#find-prev').onclick = () => api.find($('#find-input').value, { findNext: true, forward: false })
$('#find-close').onclick = closeFind
api.on('found', r => { if (r.finalUpdate) $('#find-count').textContent = r.matches ? `${r.activeMatchOrdinal}/${r.matches}` : 'No results' })

api.on('claude:message', ({ tab, msg }) => {
  const t = App.tabs.get(tab)
  if (!t) return
  if (msg.type === 'assistant' && t.liveText && !(msg.message?.content || []).some(b => b.type === 'text' && b.text.trim())) {
    cancelAnimationFrame(t.liveText.raf)
    t.liveText.node.closest('.msg')?.remove()
    t.liveText = null
  }
  t.handle(msg)
})
api.on('claude:permission', d => App.tabs.get(d.tab)?.permission(d))
api.on('claude:meta', ({ tab, commands, models, agents }) => {
  const t = App.tabs.get(tab)
  if (!t) return
  Object.assign(t.meta, { commands, models, agents })
  if (models?.length) localStorage.setItem('models', JSON.stringify(models))
  Panels.refresh('agents')
  App.tabChanged(t)
})
api.on('claude:stderr', ({ tab, line }) => { const t = App.tabs.get(tab); if (t) t.stderr = [...t.stderr, line].slice(-40) })
api.on('claude:error', ({ tab, error }) => {
  const t = App.tabs.get(tab)
  if (!t) return
  t.live = false
  t.setBusy(false)
  t.add(el('div', 'notice err', icon('warning'), el('pre', '', error + (t.stderr.length ? '\n\n' + t.stderr.join('') : ''))))
})
api.on('claude:ended', ({ tab }) => { const t = App.tabs.get(tab); if (t) { t.live = false; t.setBusy(false) } })
api.on('menu', ch => ({
  newTab: () => App.newTab(null), openFolder: () => App.pickFolder(), closeTab: () => App.closeTab(),
  export: () => App.active.exportMarkdown(), settings: openSettings, palette: openPalette, find: openFind,
  sidebar: () => saveSettings({ sidebar: !settings.sidebar }), panel: () => { Panels.toggle(); Terminals.fit() },
  terminal: () => Panels.toggle('terminal'),
})[ch]?.())

$('#send').onclick = send
$('#stop').onclick = () => api.control(App.active.id, 'interrupt')
$('#attach').onclick = () => $('#file').click()
$('#file').onchange = e => { addFiles([...e.target.files]); e.target.value = '' }
$('#mention').onclick = () => { App.insertText('@'); updateSuggest() }
$('#slash').onclick = () => { App.setComposer('/'); updateSuggest() }
$('#new-chat').onclick = () => App.active.cwd ? App.openProject(App.active.cwd) : App.pickFolder()
$('#new-tab').onclick = () => App.newTab(App.active?.cwd || null)
$('#welcome-open').onclick = () => App.pickFolder()
$('#hide-sidebar').onclick = $('#show-sidebar').onclick = () => saveSettings({ sidebar: !settings.sidebar })
$('#open-settings').onclick = openSettings
$('#open-palette').onclick = openPalette
$('#toggle-panel').onclick = () => { Panels.toggle(); Terminals.fit() }
$('#toggle-terminal').onclick = () => Panels.toggle('terminal')
$('#close-panel').onclick = () => saveSettings({ panel: false })

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey
  const tab = App.active
  if (e.key === 'Escape' && !$('.modal-back') && !$('.menu')) {
    if (!$('#findbar').hidden) return closeFind()
    if (tab?.busy) api.control(tab.id, 'interrupt')
    else if (!input.value && tab?.cwd && Date.now() - (App.lastEsc || 0) < 500) App.runCommand('rewind')
    App.lastEsc = Date.now()
  }
  if (e.key === 'Tab' && e.shiftKey && !mod && tab?.cwd && (e.target === input || e.target === document.body)) {
    e.preventDefault()
    setMode(tab, MODES[(MODES.findIndex(m => m.value === tab.mode) + 1) % MODES.length].value)
  }
  if (mod && e.key === 'Tab') {
    e.preventDefault()
    const ids = [...App.tabs.keys()], i = ids.indexOf(tab.id)
    App.activate(App.tabs.get(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]))
  }
  if (mod && /^[1-9]$/.test(e.key)) {
    const t = [...App.tabs.values()][+e.key - 1]
    if (t) { e.preventDefault(); App.activate(t) }
  }
})

let dragDepth = 0
addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false } })
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true } })
addEventListener('dragover', e => e.preventDefault())
addEventListener('drop', e => {
  e.preventDefault()
  dragDepth = 0
  $('#drop-overlay').hidden = true
  if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files])
  else if (e.target === input || e.target.closest('#composer')) App.insertText(e.dataTransfer.getData('text/plain'))
})

document.addEventListener('click', e => {
  const a = e.target.closest('a[href]')
  if (!a) return
  e.preventDefault()
  const href = a.getAttribute('href')
  if (/^https?:/.test(href)) api.openExternal(href)
  else if (App.active?.cwd && !/^[a-z]+:/i.test(href)) App.openFile(href.startsWith('/') ? href : join(App.active.cwd, href))
})

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings)
let wasWide = innerWidth > 1100
addEventListener('resize', debounce(() => {
  const wide = innerWidth > 1100
  if (wasWide && !wide && settings.sidebar) saveSettings({ sidebar: false })
  wasWide = wide
}, 150))
$('#main').addEventListener('mousedown', e => { if (e.target === e.currentTarget && innerWidth <= 1100 && settings.sidebar) saveSettings({ sidebar: false }) })

;(async () => {
  App.info = await api.info()
  if (innerWidth <= 1100) settings.sidebar = false
  applySettings()
  Panels.init()
  const initial = new URLSearchParams(location.search).get('cwd')
  const tab = App.newTab(null)
  renderWelcome()
  loadAccount()
  if (settings.panel) Panels.render()
  if (initial) await App.openProject(initial)
  App.refreshUsage(null)
  for (const [id, r] of Object.entries(Tab.resumes())) {
    await App.openProject(r.cwd, id)
    ;[...App.tabs.values()].find(t => t.sessionId === id)?.scheduleResume(r.at - 30000)
  }
  setInterval(() => App.tabs.forEach(t => t.tick()), 30000)
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
})()
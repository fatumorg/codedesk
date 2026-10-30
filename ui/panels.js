const PANELS = [
  { id: 'files', label: 'Files', icon: 'folder' },
  { id: 'changes', label: 'Changes', icon: 'git-diff' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal-window' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
  { id: 'tasks', label: 'Tasks', icon: 'list-checks' },
  { id: 'context', label: 'Context', icon: 'chart-pie' },
  { id: 'agents', label: 'Agents', icon: 'robot' },
  { id: 'mcp', label: 'MCP', icon: 'plugs' },
  { id: 'plugins', label: 'Plugins', icon: 'puzzle-piece' },
]

const Panels = {
  current: settings.panelTab,
  previewState: null,

  init() {
    const tabs = $('#panel-tabs')
    for (const p of PANELS) {
      const b = iconButton(p.icon, p.label, () => this.show(p.id))
      b.dataset.panel = p.id
      tabs.append(b)
    }
    $('#panel-resize').onmousedown = e => {
      e.preventDefault()
      const move = ev => saveSettings({ panelWidth: Math.max(300, Math.min(innerWidth - 500, innerWidth - ev.clientX)) })
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); Terminals.fit() }
      addEventListener('mousemove', move); addEventListener('mouseup', up)
    }
  },

  show(id) {
    this.current = id
    saveSettings({ panel: true, panelTab: id })
    this.render()
  },

  toggle(id) {
    if (settings.panel && (!id || this.current === id)) saveSettings({ panel: false })
    else this.show(id || this.current)
    if (settings.panel) this.render()
  },

  canLeave() {
    const p = this.previewState
    return !p?.dirty || confirmDialog('Discard unsaved changes?', `${basename(p.file)} has edits that are not saved.`, 'Discard', true)
  },

  refresh(id) { if (settings.panel && this.current === id) this.render() },

  async render() {
    $$('#panel-tabs button').forEach(b => b.classList.toggle('active', b.dataset.panel === this.current))
    const p = PANELS.find(x => x.id === this.current)
    $('#panel-title').textContent = p.label
    const body = $('#panel-body')
    const actions = $('#panel-actions')
    actions.replaceChildren()
    const tab = App.active
    if (this.current !== 'terminal') Terminals.detach()
    if (!tab?.cwd && !['preview', 'plugins'].includes(this.current)) {
      body.replaceChildren(el('div', 'panel-empty', 'Open a project folder first.'))
      return
    }
    if (['context', 'mcp', 'agents'].includes(this.current)) await tab.ensureLive()
    const content = await this[this.current](tab, actions)
    if (content && this.current === p.id) body.replaceChildren(content)
  },

  async files(tab, actions) {
    actions.append(iconButton('file-plus', 'New file', async () => {
      const name = await prompt('New file', '', { placeholder: 'src/example.js' })
      if (!name?.trim()) return
      const full = join(tab.cwd, name.trim())
      const r = await api.createFile(full, '')
      if (r?.error) return toast(r.error, 'err')
      App.fileCache.delete(tab.cwd)
      App.openFile(full)
    }), iconButton('arrows-clockwise', 'Refresh', () => this.render()),
      iconButton('folder-open', onPc('Open folder in file manager'), () => api.openPath(tab.cwd)))
    const tree = el('div', 'tree')
    const filter = el('input', 'field sm'); filter.placeholder = 'Find file…'
    const results = el('div', 'tree')
    filter.oninput = debounce(async () => {
      const q = filter.value.toLowerCase()
      tree.hidden = !!q
      results.hidden = !q
      if (!q) return
      const files = await App.projectFiles(tab)
      results.replaceChildren(...files.filter(f => f.toLowerCase().includes(q)).slice(0, 200).map(f => this.fileRow(tab, join(tab.cwd, f), f, 0)))
    }, 120)
    await this.dirInto(tab, tab.cwd, tree, 0)
    return el('div', 'stack fill', filter, results, tree)
  },

  async dirInto(tab, dir, container, depth) {
    const ents = await api.listDir(dir)
    container.replaceChildren(...ents.filter(e => e.name !== '.git').map(e => {
      const full = join(dir, e.name)
      if (!e.dir) return this.fileRow(tab, full, e.name, depth)
      const kids = el('div', 'tree-kids')
      kids.hidden = true
      const row = el('div', 'tree-row', el('span', 'indent'), icon('caret-right', 'caret'), icon('folder'), el('span', '', e.name))
      row.style.setProperty('--depth', depth)
      row.onclick = async () => {
        kids.hidden = !kids.hidden
        row.classList.toggle('open', !kids.hidden)
        if (!kids.hidden && !kids.childElementCount) await this.dirInto(tab, full, kids, depth + 1)
      }
      row.oncontextmenu = e => { e.preventDefault(); menu(e, this.fileMenu(tab, full, true)) }
      return el('div', '', row, kids)
    }))
  },

  fileRow(tab, full, label, depth) {
    const row = el('div', 'tree-row', el('span', 'indent'), el('span', 'caret'), icon('file'), el('span', '', label))
    row.style.setProperty('--depth', depth)
    row.title = full
    if (tab.changes.has(full)) row.classList.add('changed')
    row.onclick = () => App.openFile(full)
    row.oncontextmenu = e => { e.preventDefault(); menu(e, this.fileMenu(tab, full)) }
    row.draggable = true
    row.ondragstart = e => e.dataTransfer.setData('text/plain', '@' + App.relPath(tab, full))
    return row
  },

  fileMenu(tab, full, dir) {
    return [
      { label: 'Mention in chat', icon: 'at', run: () => App.insertText('@' + App.relPath(tab, full) + ' ') },
      ...(dir ? [] : [{ label: 'Edit', icon: 'pencil-simple', run: () => App.openFile(full, { edit: true }) }, { label: onPc('Open in editor'), icon: 'code', run: () => App.openInEditor(full) }]),
      { label: onPc('Open with default app'), icon: 'arrow-square-out', run: () => api.openPath(full) },
      { label: onPc('Show in file manager'), icon: 'folder-open', run: () => api.showItem(full) },
      { label: 'Copy path', icon: 'copy', run: () => copy(full) },
    ]
  },

  async changes(tab, actions) {
    const git = await api.git(tab.cwd, ['status', '--porcelain=v1', '-uall'])
    actions.append(iconButton('arrows-clockwise', 'Refresh', () => this.render()))
    const list = el('div', 'stack')
    if (!git.code) {
      const files = git.stdout.split('\n').filter(Boolean).map(l => ({ status: l.slice(0, 2).trim() || 'M', file: l.slice(3).replace(/^.* -> /, '') }))
      const branch = (await api.git(tab.cwd, ['branch', '--show-current'])).stdout.trim()
      list.append(el('div', 'panel-sub', icon('git-branch'), branch || 'detached', el('span', 'muted', ` · ${files.length} changed`)))
      if (!files.length) list.append(el('div', 'panel-empty', 'Working tree clean.'))
      for (const f of files) {
        const full = join(tab.cwd, f.file)
        const diff = el('div', 'change-diff')
        diff.hidden = true
        const row = el('div', 'change-row' + (tab.changes.has(full) ? ' by-claude' : ''),
          el('span', 'git-status s-' + f.status.replace('?', 'U'), f.status === '??' ? 'U' : f.status), el('span', 'path', f.file),
          tab.changes.has(full) ? el('span', 'pill', 'Claude') : null)
        row.onclick = async () => {
          diff.hidden = !diff.hidden
          if (diff.hidden || diff.childElementCount) return
          const d = f.status === '??' ? { stdout: '' } : await api.git(tab.cwd, ['diff', 'HEAD', '--', f.file])
          if (d.stdout) diff.append(diffView(parseUnified(d.stdout)))
          else {
            const r = await api.readFile(full).catch(() => null)
            diff.append(r?.text != null ? diffView(r.text.split('\n').map((s, i) => ({ t: '+', s, b: i + 1 }))) : el('div', 'muted', 'Binary or deleted file'))
          }
        }
        row.oncontextmenu = e => { e.preventDefault(); menu(e, [
          { label: 'Open', icon: 'eye', run: () => App.openFile(full) },
          { label: 'Mention in chat', icon: 'at', run: () => App.insertText('@' + f.file + ' ') },
          { label: 'Discard changes', icon: 'arrow-counter-clockwise', danger: true, run: async () => {
            if (await confirmDialog('Discard changes?', `Revert ${f.file} to the last commit. This cannot be undone.`, 'Discard', true)) {
              await api.git(tab.cwd, f.status === '??' ? ['clean', '-f', '--', f.file] : ['checkout', 'HEAD', '--', f.file])
              this.render()
            }
          } },
        ]) }
        list.append(row, diff)
      }
      list.append(el('div', 'row', button('Ask Claude to review', () => tab.send('Review my uncommitted changes (git diff) and point out bugs, risky spots and missing tests.'), '', 'magnifying-glass'),
        button('Commit with Claude', () => tab.send('Commit my changes with a clear, conventional commit message. Group into multiple commits if they are unrelated.'), '', 'git-commit')))
      return list
    }
    if (!tab.changes.size) return el('div', 'panel-empty', 'No files changed in this conversation yet.')
    for (const [file, edits] of tab.changes) {
      const diff = el('div', 'change-diff')
      diff.hidden = true
      const row = el('div', 'change-row by-claude', el('span', 'git-status s-M', 'M'), el('span', 'path', App.relPath(tab, file)))
      row.onclick = () => {
        diff.hidden = !diff.hidden
        if (!diff.childElementCount) diff.append(diffView(edits.flatMap(e => e.content != null ? e.content.split('\n').map(s => ({ t: '+', s })) : (e.edits || [e]).flatMap(x => lineDiff(x.old_string || '', x.new_string || '')))))
      }
      list.append(row, diff)
    }
    return list
  },

  async terminal(tab, actions) {
    actions.append(iconButton('plus', 'New terminal', () => { Terminals.kill(tab); this.render() }),
      iconButton('trash', 'Kill terminal', () => { Terminals.kill(tab); this.render() }))
    const box = el('div', 'term-host')
    setTimeout(() => Terminals.attach(tab, box), 0)
    return box
  },

  async preview(tab, actions) {
    const s = this.previewState
    const urlBar = el('input', 'field sm grow')
    urlBar.placeholder = 'http://localhost:3000'
    urlBar.value = s?.url || ''
    urlBar.onkeydown = e => { if (e.key === 'Enter') App.preview({ url: /^https?:/.test(urlBar.value) ? urlBar.value : 'http://' + urlBar.value }) }
    const wrap = el('div', 'stack fill', el('div', 'row', urlBar))
    if (!s) { wrap.append(el('div', 'panel-empty', 'Open a file, an HTML/SVG code block, a diagram, or a local dev server URL to preview it here.')); return wrap }
    actions.append(...[
      s.file && iconButton('arrow-square-out', onPc('Open with default app'), () => api.openPath(s.file)),
      s.file && iconButton('at', 'Mention in chat', () => App.insertText('@' + App.relPath(tab, s.file) + ' ')),
      (s.html || s.markdown) && iconButton(s.source ? 'eye' : 'code', s.source ? 'Rendered' : 'Source', () => { s.source = !s.source; this.render() }),
      s.url && iconButton('arrows-clockwise', 'Reload', () => this.render()),
      s.file && !s.image && iconButton('arrows-clockwise', 'Reload from disk', async () => { if (await this.canLeave()) { s.dirty = false; App.openFile(s.file) } }),
      s.url && iconButton('globe', 'Open in browser', () => api.openExternal(s.url)),
    ].filter(Boolean))
    wrap.append(el('div', 'panel-sub', icon(s.url ? 'globe' : 'file'), s.title || s.file || s.url))
    if (s.url) {
      const f = el('iframe', 'preview-frame'); f.src = s.url
      f.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups')
      wrap.append(f)
    } else if (s.image && !s.source) {
      const img = el('img', 'preview-img'); img.src = s.image
      wrap.append(img)
    } else if (s.html && !s.source) {
      const f = el('iframe', 'preview-frame white'); f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals')
      f.src = s.fileUrl
      wrap.append(f)
    } else if (s.markdown && !s.source) wrap.append(el('div', 'preview-md', md(s.markdown)))
    else if (s.file && (s.text ?? s.html ?? s.markdown) != null) wrap.append(this.editor(s))
    else if (s.text != null || s.html || s.markdown) {
      const text = s.text ?? s.html ?? s.markdown
      const pre = el('pre', 'code-view numbered')
      pre.innerHTML = highlightFile(text, s.file || 'x.html').split('\n').map(l => `<span class="cl">${l || ' '}</span>`).join('')
      wrap.append(pre)
    } else wrap.append(el('div', 'panel-empty', s.note || 'Cannot preview this file.'))
    return wrap
  },

  editor(s) {
    const key = s.text != null ? 'text' : s.html != null ? 'html' : 'markdown'
    const ta = el('textarea', 'editor-input'), hl = el('pre', 'code-view numbered editor-hl')
    Object.assign(ta, { value: s.draft ?? s[key], spellcheck: false, wrap: 'off' })
    const big = ta.value.length > 300000
    const box = el('div', 'editor' + (big ? ' plain' : ''), hl, ta)
    const status = el('span', 'muted small')
    const save = button('Save', async () => {
      try { await api.writeFile(s.file, ta.value) } catch (e) { return toast(String(e.message || e), 'err') }
      s[key] = ta.value; s.draft = null; s.dirty = false
      paint()
      toast(`Saved ${basename(s.file)}`)
    }, 'primary sm', 'floppy-disk')
    let raf = 0
    const paint = () => {
      s.dirty = ta.value !== s[key]
      s.draft = s.dirty ? ta.value : null
      save.disabled = !s.dirty
      status.textContent = s.dirty ? 'Unsaved changes · Ctrl+S to save' : 'Saved'
      if (!big) hl.innerHTML = highlightFile(ta.value, s.file).split('\n').map(l => `<span class="cl">${l || ' '}</span>`).join('')
      sync()
    }
    const sync = () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft }
    ta.oninput = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint) }
    ta.onscroll = sync
    ta.onkeydown = e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (s.dirty) save.click() }
      const start = ta.value.lastIndexOf('\n', ta.selectionStart - 1) + 1
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        const n = e.shiftKey ? ta.value.slice(start, start + 2).match(/^ */)[0].length : 0
        if (!e.shiftKey) document.execCommand('insertText', false, '  ')
        else if (n) { ta.setSelectionRange(start, start + n); document.execCommand('delete') }
      }
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.isComposing) {
        e.preventDefault()
        document.execCommand('insertText', false, '\n' + ta.value.slice(start).match(/^[ \t]*/)[0])
      }
    }
    paint()
    return el('div', 'stack editor-wrap', box, el('div', 'row', status, el('span', 'spacer'), save))
  },

  async tasks(tab) {
    const wrap = el('div', 'stack')
    wrap.append(el('div', 'panel-sub', icon('list-checks'), 'To-do list'))
    wrap.append(tab.todos.length ? tab.todoList(tab.todos) : el('div', 'panel-empty', 'Claude has no to-do list in this conversation.'))
    wrap.append(el('div', 'panel-sub', icon('robot'), 'Background tasks & agents'))
    if (!tab.tasks.size) wrap.append(el('div', 'panel-empty', 'None running.'))
    for (const t of tab.tasks.values()) {
      wrap.append(el('div', 'task-row',
        el('span', 'status-pill ' + t.status, t.status),
        el('div', 'grow', el('div', '', t.description || t.id), t.summary && t.summary !== t.description ? el('div', 'muted small', t.summary) : null,
          t.usage ? el('div', 'muted small', `${fmtTokens(t.usage.total_tokens)} tokens · ${t.usage.tool_uses} tool uses · ${dur(t.usage.duration_ms)}`)
            : t.status === 'running' && t.started ? el('div', 'muted small', 'Running for ', liveTime(t.started, true)) : null),
        t.status === 'running' ? iconButton('stop', 'Stop task', () => api.control(tab.id, 'stopTask', t.id)) : null))
    }
    return wrap
  },

  async context(tab, actions) {
    actions.append(iconButton('arrows-clockwise', 'Refresh', async () => { await tab.refreshContext(); this.render() }))
    const c = tab.live ? await api.control(tab.id, 'getContextUsage', { detail: 'full' }).catch(() => null) : null
    if (!c) return el('div', 'panel-empty', 'Context usage appears after the first message.')
    const wrap = el('div', 'stack')
    const used = c.categories.filter(x => x.kind !== 'free')
    const bar = el('div', 'ctx-bar')
    for (const x of used) {
      const seg = el('span', 'ctx-seg k-' + x.kind)
      seg.style.width = (x.tokens / c.maxTokens * 100) + '%'
      seg.title = `${x.name}: ${fmtTokens(x.tokens)}`
      bar.append(seg)
    }
    wrap.append(el('div', 'ctx-total', el('b', 'serif big', `${Math.round(c.percentage)}%`), el('span', 'muted', ` of ${fmtTokens(c.maxTokens)} tokens used · ${c.model}`)), bar)
    const table = el('div', 'kv')
    for (const x of c.categories) table.append(el('span', '', x.name), el('span', 'num', fmtTokens(x.tokens)))
    wrap.append(table)
    if (c.memoryFiles?.length) {
      wrap.append(el('div', 'panel-sub', icon('file-text'), 'Memory files'))
      for (const f of c.memoryFiles) {
        const r = el('div', 'tree-row', icon('file'), el('span', 'grow', f.path), el('span', 'num muted', fmtTokens(f.tokens)))
        r.onclick = () => App.openFile(f.path)
        wrap.append(r)
      }
    }
    wrap.append(el('div', 'row', button('Compact now', () => tab.send('/compact'), '', 'arrows-in'), button('Clear conversation', () => App.runCommand('clear'), 'ghost', 'trash')))
    return wrap
  },

  async agents(tab, actions) {
    actions.append(iconButton('plus', 'New agent', () => this.newAgent(tab)))
    const list = tab.meta.agents || []
    const wrap = el('div', 'panel-list')
    wrap.append(el('p', 'muted small pad', 'Subagents run in their own context window, so each one adds to your usage. Claude picks them by description, or mention one with @.'))
    if (!list.length) wrap.append(el('div', 'panel-empty', 'No agents loaded yet. Send a message first, or create one.'))
    for (const a of list) wrap.append(el('div', 'agent-row', icon('robot'), el('div', 'grow', el('b', '', a.name), el('div', 'muted small', a.description || '')),
      a.model ? el('span', 'pill', a.model) : null,
      iconButton('at', 'Mention', () => App.insertText(`@${a.name} `))))
    return wrap
  },

  async newAgent(tab) {
    const name = (await prompt('New agent name', 'code-reviewer'))?.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    if (!name) return
    const description = await prompt('When should Claude use it?', 'Reviews code changes for bugs and risky spots')
    if (description == null) return
    const file = join(tab.cwd, `.claude/agents/${name}.md`)
    const r = await api.createFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nYou are a focused subagent. Describe its job, the steps it follows and what it returns.\n`)
    if (r?.error) return toast(r.error, 'err')
    App.openInEditor(file)
    await api.control(tab.id, 'reloadPlugins').catch(() => {})
    toast(`Created ${name}. It loads in new conversations.`)
  },

  async mcp(tab, actions) {
    actions.append(iconButton('plus', 'Add MCP server', () => this.addMcp(tab)), iconButton('arrows-clockwise', 'Refresh', () => this.render()))
    const list = tab.live ? await api.control(tab.id, 'mcpServerStatus').catch(() => null) : null
    const wrap = el('div', 'stack')
    if (!list) { wrap.append(el('div', 'panel-empty', 'Start a conversation to see MCP servers.')); return wrap }
    if (!list.length) wrap.append(el('div', 'panel-empty', 'No MCP servers configured.'))
    for (const s of list) {
      const enabled = s.status !== 'disabled'
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = enabled; toggle.className = 'switch'
      toggle.title = enabled ? 'Disable' : 'Enable'
      toggle.onchange = async () => { await api.control(tab.id, 'toggleMcpServer', s.name, toggle.checked); this.render() }
      const tools = s.tools?.length ? `${s.tools.length} tools` : ''
      wrap.append(el('div', 'mcp-row',
        el('div', 'grow', el('div', 'row tight', el('b', '', s.name), el('span', 'status-pill ' + s.status, s.status)),
          el('div', 'muted small', [s.serverInfo && `${s.serverInfo.name} ${s.serverInfo.version}`, tools, s.config?.type, s.scope].filter(Boolean).join(' · ')),
          s.error ? el('div', 'small err-text', s.error) : null),
        s.status === 'needs-auth' ? button('Sign in', async () => { toast('Opening browser…'); await api.cli(['mcp', 'login', s.name]); this.render() }, 'sm') : null,
        iconButton('arrows-clockwise', 'Reconnect', async () => { await api.control(tab.id, 'reconnectMcpServer', s.name).catch(e => toast(String(e), 'err')); this.render() }),
        iconButton('dots-three', 'More', e => menu(e.currentTarget, [
          { label: 'Remove server', icon: 'trash', danger: true, run: async () => {
            if (!await confirmDialog('Remove MCP server?', `Remove "${s.name}" from your Claude Code configuration.`, 'Remove', true)) return
            const r = await api.cli(['mcp', 'remove', s.name])
            toast(r.code ? r.stderr || r.stdout : `Removed ${s.name}`, r.code ? 'err' : '')
            await tab.start(); setTimeout(() => this.render(), 1500)
          } },
        ])),
        toggle))
    }
    return wrap
  },

  addMcp(tab) {
    const name = el('input', 'field'); name.placeholder = 'Name, e.g. github'
    const type = el('select', 'field', ...['stdio', 'http', 'sse'].map(t => Object.assign(el('option', '', t), { value: t })))
    const target = el('input', 'field'); target.placeholder = 'Command (e.g. npx -y @modelcontextprotocol/server-github) or URL'
    const env = el('textarea', 'field'); env.placeholder = 'Environment or headers, one per line: KEY=value'; env.rows = 3
    const scope = el('select', 'field', ...[['local', 'Just me, this project'], ['project', 'Everyone on this project (.mcp.json)'], ['user', 'Me, all projects']].map(([v, l]) => Object.assign(el('option', '', l), { value: v })))
    const save = async () => {
      const pairs = Object.fromEntries(env.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
      let cfg
      if (type.value === 'stdio') {
        const [command, ...args] = target.value.trim().split(/\s+/)
        cfg = { type: 'stdio', command, args, env: pairs }
      } else cfg = { type: type.value, url: target.value.trim(), headers: pairs }
      const r = await api.cli(['mcp', 'add-json', '-s', scope.value, name.value.trim(), JSON.stringify(cfg)])
      if (r.code) return toast(r.stderr || r.stdout, 'err')
      m.close()
      toast(`Added ${name.value}`)
      await tab.start()
      setTimeout(() => this.render(), 2000)
    }
    const m = modal('Add MCP server', el('div', 'stack',
      el('label', '', 'Name', name), el('label', '', 'Type', type), el('label', '', 'Command or URL', target),
      el('label', '', 'Environment / headers', env), el('label', '', 'Available to', scope),
      el('div', 'row end', button('Cancel', () => m.close(), 'ghost'), button('Add server', save, 'primary'))))
  },

  async plugins(tab, actions) {
    actions.append(iconButton('plus', 'Add marketplace', async () => {
      const src = await prompt('Add plugin marketplace', '', { placeholder: 'owner/repo, git URL, or local path' })
      if (!src) return
      const r = await api.cli(['plugin', 'marketplace', 'add', src])
      toast(r.code ? r.stderr || r.stdout : 'Marketplace added', r.code ? 'err' : '')
      this.render()
    }), iconButton('arrows-clockwise', 'Refresh', () => this.render()))
    const wrap = el('div', 'stack')
    wrap.append(el('div', 'panel-empty', 'Loading plugins…'))
    setTimeout(async () => {
      const r = await api.cli(['plugin', 'list', '--available', '--json'])
      let data
      try { data = JSON.parse(r.stdout) } catch { wrap.replaceChildren(el('div', 'panel-empty', r.stderr || 'Could not list plugins.')); return }
      const after = async (res, msg) => {
        toast(res.code ? res.stderr || res.stdout : msg, res.code ? 'err' : '')
        if (tab?.live) await api.control(tab.id, 'reloadPlugins').catch(() => {})
        this.render()
      }
      const search = el('input', 'field sm'); search.placeholder = 'Search marketplace…'
      const avail = el('div', 'stack')
      const renderAvail = () => avail.replaceChildren(...(data.available || [])
        .filter(p => !search.value || (p.name + ' ' + (p.description || '')).toLowerCase().includes(search.value.toLowerCase()))
        .slice(0, 100).map(p => el('div', 'plugin-row',
          el('div', 'grow', el('b', '', p.name), el('span', 'muted small', ' ' + (p.marketplaceName || p.pluginId?.split('@')[1] || '')), el('div', 'muted small clamp', p.description || '')),
          button('Install', async e => { e.currentTarget.disabled = true; after(await api.cli(['plugin', 'install', p.pluginId || p.name]), `Installed ${p.name}`) }, 'sm'))))
      search.oninput = debounce(renderAvail, 100)
      const installed = (data.installed || []).map(p => {
        const toggle = el('input'); toggle.type = 'checkbox'; toggle.className = 'switch'; toggle.checked = p.enabled
        toggle.onchange = async () => after(await api.cli(['plugin', toggle.checked ? 'enable' : 'disable', p.id]), `${toggle.checked ? 'Enabled' : 'Disabled'} ${p.id}`)
        return el('div', 'plugin-row',
          el('div', 'grow', el('b', '', p.id.split('@')[0]), el('div', 'muted small', [p.id.split('@')[1], p.version, p.scope].filter(Boolean).join(' · '))),
          iconButton('dots-three', 'More', e => menu(e.currentTarget, [
            { label: 'Update', icon: 'arrows-clockwise', run: async () => after(await api.cli(['plugin', 'update', p.id]), `Updated ${p.id}`) },
            { label: 'Uninstall', icon: 'trash', danger: true, run: async () => after(await api.cli(['plugin', 'uninstall', p.id]), `Uninstalled ${p.id}`) },
          ])), toggle)
      })
      renderAvail()
      wrap.replaceChildren(el('div', 'panel-sub', icon('puzzle-piece'), `Installed (${installed.length})`), ...installed,
        el('div', 'panel-sub', icon('storefront'), 'Marketplace'), search, avail)
    })
    return wrap
  },
}

const Terminals = {
  map: new Map(),
  async attach(tab, host) {
    let t = this.map.get(tab.id)
    if (!t) {
      loadStyle('../node_modules/@xterm/xterm/css/xterm.css')
      await loadScript('../node_modules/@xterm/xterm/lib/xterm.js')
      await loadScript('../node_modules/@xterm/addon-fit/lib/addon-fit.js')
      if (this.map.get(tab.id)) return this.attach(tab, host)
      const term = new Terminal({
        fontFamily: '"Geist Mono Variable", ui-monospace, monospace', fontSize: 13, cursorBlink: true, allowProposedApi: true,
        theme: isDark() ? { background: '#161513', foreground: '#e8e6e1', cursor: '#d97757', selectionBackground: '#d9775744' }
          : { background: '#fbfbfa', foreground: '#2f3437', cursor: '#c96442', selectionBackground: '#c9644233' },
      })
      const fit = new FitAddon.FitAddon()
      term.loadAddon(fit)
      const node = el('div', 'term')
      t = { term, fit, node, id: tab.id + '-' + Date.now(), line: '' }
      this.map.set(tab.id, t)
      term.open(node)
      const win = App.info.platform === 'win32'
      term.onData(d => {
        if (!win) return api.termWrite(t.id, d)
        if (d === '\r') { term.write('\r\n'); api.termWrite(t.id, t.line + '\r\n'); t.line = '' }
        else if (d === '\x7f') { if (t.line) { t.line = t.line.slice(0, -1); term.write('\b \b') } }
        else { t.line += d; term.write(d) }
      })
      host.append(node)
      fit.fit()
      api.termStart(t.id, tab.cwd, term.cols, term.rows)
      term.onResize(({ cols, rows }) => api.termResize(t.id, cols, rows))
    } else host.append(t.node)
    requestAnimationFrame(() => { t.fit.fit(); t.term.focus() })
  },
  detach() { for (const t of this.map.values()) t.node.remove() },
  fit() { for (const t of this.map.values()) if (t.node.isConnected) t.fit.fit() },
  kill(tab) {
    const t = this.map.get(tab.id)
    if (!t) return
    api.termKill(t.id); t.term.dispose(); t.node.remove()
    this.map.delete(tab.id)
  },
  async run(tab, command) {
    Panels.show('terminal')
    for (let i = 0; i < 50 && !this.map.get(tab.id); i++) await new Promise(r => setTimeout(r, 100))
    setTimeout(() => { const t = this.map.get(tab.id); if (t) api.termWrite(t.id, command + '\r') }, 400)
  },
}
api.on('term:data', ({ id, data }) => { for (const t of Terminals.map.values()) if (t.id === id) t.term.write(data) })
api.on('term:exit', ({ id }) => { for (const t of Terminals.map.values()) if (t.id === id) t.term.write('\r\n[process exited]\r\n') })
addEventListener('resize', debounce(() => Terminals.fit(), 100))

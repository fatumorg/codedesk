const MODES = [
  { value: 'default', label: 'Ask before edits', short: 'Ask', icon: 'hand' },
  { value: 'acceptEdits', label: 'Edit automatically', short: 'Auto-edit', icon: 'lightning' },
  { value: 'plan', label: 'Plan mode', short: 'Plan', icon: 'list-checks' },
  { value: 'auto', label: 'Auto mode', short: 'Auto', icon: 'sparkle' },
  { value: 'bypassPermissions', label: 'Bypass permissions', short: 'Bypass', icon: 'warning' },
]
const EFFORTS = [
  { value: 'low', label: 'Low', hint: 'Quick answers, fewest tokens' },
  { value: 'medium', label: 'Medium', hint: 'Balanced speed and depth' },
  { value: 'high', label: 'High', hint: 'Thinks longer on tricky work' },
  { value: 'xhigh', label: 'Extra high', hint: 'Deep reasoning for hard problems' },
  { value: 'max', label: 'Max', hint: 'Everything it has, slowest' },
  { value: 'ultracode', label: 'Ultracode', hint: 'Max effort plus multi-agent workflows' },
]
const IDLE_STOP = 15 * 60000

const TOOL_ICONS = {
  Bash: 'terminal-window', BashOutput: 'terminal-window', KillShell: 'stop', Read: 'file-text', Write: 'file-plus',
  Edit: 'pencil-simple', MultiEdit: 'pencil-simple', NotebookEdit: 'notebook', Glob: 'magnifying-glass',
  Grep: 'magnifying-glass', WebFetch: 'globe', WebSearch: 'globe', Task: 'robot', Agent: 'robot',
  TodoWrite: 'list-checks', Skill: 'sparkle', ExitPlanMode: 'list-checks', AskUserQuestion: 'chat-circle',
}
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

let tabSeq = 0

class Tab {
  constructor(cwd) {
    this.id = 't' + ++tabSeq
    this.cwd = cwd || null
    this.sessionId = null
    this.title = cwd ? 'New conversation' : 'New tab'
    this.live = false
    this.busy = false
    this.model = settings.defaultModel
    this.mode = settings.defaultMode
    this.effort = settings.defaultEffort
    this.fast = false
    this.addDirs = []
    this.tools = new Map()
    this.changes = new Map()
    this.tasks = new Map()
    this.todos = []
    this.cost = 0
    this.context = null
    this.statusLine = ''
    this.lastUuid = null
    this.stderr = []
    this.meta = { commands: [], models: Tab.cachedModels(), agents: [], mcp: [], skills: [] }
    this.lastActive = Date.now()
    this.suggestion = ''
    this.draft = ''
    this.attachments = []
    this.liveText = null
    this.permissions = 0
    this.view = el('div', 'view')
    this.messages = el('div', 'messages')
    this.view.append(this.messages)
  }

  get name() { return this.cwd ? basename(this.cwd) : 'New tab' }

  async open(sessionId, { history = true } = {}) {
    await api.stop(this.id)
    if (sessionId !== this.sessionId) this.cancelResume(true)
    this.live = false
    this.sessionId = sessionId || null
    this.messages.replaceChildren()
    this.tools.clear(); this.changes.clear(); this.tasks.clear(); this.todos = []
    this.cost = 0; this.context = null; this.lastUuid = null; this.liveText = null; this.permissions = 0
    this.title = 'New conversation'
    this.setBusy(false)
    if (sessionId && history) {
      const msgs = await api.history(sessionId, this.cwd)
      this.loadingHistory = true
      for (const m of msgs) this.handle({ ...m, history: true })
      this.loadingHistory = false
      const info = (await api.listSessions(this.cwd)).find(s => s.sessionId === sessionId)
      if (info) this.title = info.customTitle || info.summary || info.firstPrompt || this.title
    }
    this.renderEmpty()
    App.tabChanged(this)
    this.scroll(true)
  }

  async start(extra = {}) {
    this.live = true
    this.inited = false
    this.lastActive = Date.now()
    await api.start(this.id, {
      cwd: this.cwd, resume: this.sessionId, model: this.model || undefined, permissionMode: this.mode,
      effort: this.effort === 'ultracode' ? 'max' : this.effort || undefined, additionalDirectories: this.addDirs, ...extra,
    })
    const flags = { ...(this.fast && { fastMode: true }), ...(this.effort === 'ultracode' && { ultracode: true, effortLevel: 'max' }) }
    if (Object.keys(flags).length) api.control(this.id, 'applyFlagSettings', flags).catch(() => toast('Ultracode is not available for this model or account', 'err'))
  }

  async ensureLive() { if (!this.live && this.cwd) await this.start() }

  static cachedModels() { try { return JSON.parse(localStorage.getItem('models') || '[]') } catch { return [] } }

  close() {
    this.cancelResume(true)
    api.stop(this.id)
    Terminals.kill(this)
    this.view.remove()
  }

  setBusy(b) {
    this.busy = b
    if (!b) for (const t of this.tools.values()) t.card.classList.remove('running')
    App.tabChanged(this)
  }

  nearBottom() { const c = App.chatEl; return c.scrollHeight - c.scrollTop - c.clientHeight < 160 }
  scroll(force) {
    if (App.active !== this) return
    if (force || this.nearBottom()) requestAnimationFrame(() => (App.chatEl.scrollTop = App.chatEl.scrollHeight))
  }

  add(node, parentToolId, { anim = true } = {}) {
    this.view.querySelector('.empty')?.remove()
    const wrap = el('div', 'msg' + (anim && !this.loadingHistory ? ' anim' : ''), node)
    const parent = parentToolId && this.tools.get(parentToolId)
    const stick = App.active === this && this.nearBottom()
    ;(parent ? parent.sub : this.messages).append(wrap)
    if (parent) parent.sub.hidden = false
    if (stick) this.scroll(true)
    return wrap
  }

  renderEmpty() {
    if (this.messages.childElementCount || !this.cwd) return
    const ideas = [
      ['Explain this codebase', 'Give me an overview of this codebase: what it does, how it is structured, and where the main entry points are.'],
      ['Review my changes', 'Review my uncommitted changes and point out bugs or risky spots.'],
      ['Find and fix a bug', 'Look for a bug in this project, explain it, and propose a fix.'],
      ['Write tests', 'Find the most important untested code here and write tests for it.'],
    ]
    const e = el('div', 'empty',
      el('h1', 'serif', this.name),
      el('p', 'muted', this.cwd),
      el('div', 'ideas', ...ideas.map(([label, text]) => button(label, () => App.setComposer(text, true), 'idea'))))
    this.view.prepend(e)
  }

  handle(m) {
    if (!m.history) this.lastActive = Date.now()
    this.dispatch(m)
    if (m.uuid && !m.parent_tool_use_id && (m.type === 'assistant' || m.type === 'user')) this.lastUuid = m.uuid
  }

  dispatch(m) {
    const parent = m.parent_tool_use_id
    switch (m.type) {
      case 'system': return this.system(m, parent)
      case 'stream_event': return this.stream(m, parent)
      case 'assistant': return this.assistant(m, parent)
      case 'user': return this.user(m, parent)
      case 'result': return this.result(m)
      case 'prompt_suggestion': this.suggestion = m.suggestion || ''; return App.tabChanged(this)
      case 'rate_limit_event': {
        const r = m.rate_limit_info
        if (r.status === 'rejected') { this.limited = r.resetsAt ? r.resetsAt * 1000 : this.limited || -1; return }
        if (r.status === Tab.rateStatus) return
        Tab.rateStatus = r.status
        if (r.status === 'allowed_warning') this.add(el('div', 'notice warn', icon('gauge'),
          `Usage limit almost reached` + (r.utilization != null ? ` · ${Math.round(r.utilization * (r.utilization <= 1 ? 100 : 1))}% used` : '') + (r.resetsAt ? ` · resets ${clock(r.resetsAt * 1000)}` : ''),
          button('Usage', () => openUsage(this), 'ghost sm')))
        return
      }
    }
  }

  system(m, parent) {
    switch (m.subtype) {
      case 'init':
        this.sessionId = m.session_id
        this.meta.mcp = m.mcp_servers
        this.meta.skills = m.skills || []
        this.meta.model = m.model
        this.meta.version = m.claude_code_version
        this.meta.outputStyle = m.output_style
        if (MODES.some(x => x.value === m.permissionMode)) this.mode = m.permissionMode
        if (!this.meta.commands.length) this.meta.commands = m.slash_commands.map(name => ({ name, description: '' }))
        if (!this.inited) {
          this.inited = true
          const failed = m.mcp_servers.filter(s => s.status === 'failed')
          if (failed.length) this.add(el('div', 'notice warn', icon('plugs'), `MCP server failed: ${failed.map(s => s.name).join(', ')}`, button('Open MCP', () => Panels.show('mcp'), 'ghost sm')))
        }
        App.tabChanged(this)
        this.refreshStatusLine()
        break
      case 'local_command_output': this.add(md(m.content)); break
      case 'compact_boundary': this.add(el('div', 'divider', el('span', '', 'Conversation compacted'))); break
      case 'status': if (m.status === 'compacting') App.status(this, 'Compacting conversation…'); break
      case 'api_retry': App.status(this, `API error, retrying (attempt ${m.attempt ?? '?'})…`); break
      case 'notification': if (m.message || m.text) this.add(el('div', 'notice', icon('bell'), m.message || m.text)); break
      case 'permission_denied': this.add(el('div', 'notice', icon('x'), `Denied ${m.tool_name}`), parent); break
      case 'task_started':
        this.tasks.set(m.task_id, { id: m.task_id, description: m.description, type: m.subagent_type, status: 'running', started: Date.now() })
        Panels.refresh('tasks')
        break
      case 'task_progress': case 'task_updated': {
        const t = this.tasks.get(m.task_id)
        if (t) { Object.assign(t, { status: m.status || t.status, summary: m.summary || m.description || t.summary }); Panels.refresh('tasks') }
        break
      }
      case 'task_notification': {
        const t = this.tasks.get(m.task_id) || { id: m.task_id, description: m.summary }
        Object.assign(t, { status: m.status, summary: m.summary, usage: m.usage })
        this.tasks.set(m.task_id, t)
        Panels.refresh('tasks')
        break
      }
    }
  }

  stream(m, parent) {
    const e = m.event
    if (parent) return
    if (e.type === 'message_start') { this.setBusy(true); $$('.queued', this.messages).forEach(q => q.classList.remove('queued')) }
    if (e.type === 'content_block_start' && e.content_block.type === 'text') this.liveText = { text: '', node: this.add(el('div', 'assistant')) }
    if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && this.liveText) {
      this.liveText.text += e.delta.text
      if (!this.liveText.raf) this.liveText.raf = requestAnimationFrame(() => {
        if (!this.liveText) return
        this.liveText.raf = 0
        this.liveText.node.replaceChildren(md(this.liveText.text))
        this.scroll()
      })
    }
  }

  assistant(m, parent) {
    if (!m.history) this.setBusy(true)
    if (m.error === 'rate_limit' && !m.history) this.limited ||= -1
    else if (m.error) {
      this.add(el('div', 'notice err', icon('warning'), `Error: ${m.error.replace(/_/g, ' ')}`), parent)
      if (m.error === 'authentication_failed') this.loginPrompt()
    }
    for (const b of m.message.content || []) {
      if (b.type === 'text' && b.text.trim()) {
        const body = md(b.text)
        if (this.liveText && !parent) {
          cancelAnimationFrame(this.liveText.raf)
          this.liveText.node.replaceChildren(body)
          this.liveText.node.append(this.assistantActions(b.text))
          this.liveText = null
        } else {
          const node = el('div', 'assistant', body)
          if (!parent) node.append(this.assistantActions(b.text))
          this.add(node, parent)
        }
      } else if (b.type === 'thinking' && b.thinking) {
        const d = el('details', 'thinking', el('summary', '', icon('brain'), el('span', '', 'Thinking')), el('div', 'thinking-body', b.thinking))
        this.add(d, parent)
      } else if (b.type === 'tool_use') this.toolCard(b, parent)
    }
  }

  assistantActions(text) {
    return el('div', 'actions', iconButton('copy', 'Copy', e => copy(text, e.currentTarget)))
  }

  user(m, parent) {
    const c = m.message.content
    const results = Array.isArray(c) ? c.filter(b => b.type === 'tool_result') : []
    for (const r of results) this.toolResult(r, m.tool_use_result ?? m.toolUseResult)
    if (m.history && !parent && !results.length) this.userBubble(c, m.uuid)
  }

  result(m) {
    this.setBusy(false)
    this.cost = m.total_cost_usd || this.cost
    App.status(this, `Done in ${(m.duration_ms / 1000).toFixed(1)}s · ${m.num_turns} turn${m.num_turns === 1 ? '' : 's'}`)
    const limitText = /hit your (usage )?limit|usage limit reached|limit reached/i.test(m.result || '')
    if (this.limited || limitText) {
      this.scheduleResume(this.limited > 0 ? this.limited : 0)
      this.limited = 0
    } else if (m.subtype !== 'success' || m.is_error) {
      const text = m.result || (m.errors || []).join('\n') || m.subtype.replace(/_/g, ' ')
      this.add(el('div', 'notice err', icon('warning'), text))
      if (/log ?in|auth|credential|api key/i.test(text)) this.loginPrompt()
    }
    this.refreshContext()
    this.refreshStatusLine()
    App.refreshUsage(this)
    App.refreshSessions()
    const last = $$('.assistant', this.messages).pop()?.innerText?.split('\n')[0]?.slice(0, 140)
    notify(`${this.name}: Claude finished`, last || 'Done')
    if (settings.sounds && !m.history) chime()
  }

  async refreshContext() {
    const c = await api.control(this.id, 'getContextUsage', { detail: 'summary' }).catch(() => null)
    if (c) { this.context = c; App.tabChanged(this); Panels.refresh('context') }
  }

  async refreshStatusLine() {
    const out = await api.statusLine({
      session_id: this.sessionId, cwd: this.cwd, version: this.meta.version,
      model: { id: this.meta.model, display_name: this.meta.model },
      workspace: { current_dir: this.cwd, project_dir: this.cwd },
      cost: { total_cost_usd: this.cost }, output_style: { name: this.meta.outputStyle },
    }).catch(() => null)
    this.statusLine = out || ''
    App.tabChanged(this)
  }

  async scheduleResume(at) {
    if (!at) {
      const r = (await api.usage(this.id).catch(() => null))?.rate_limits || {}
      const full = [r.five_hour, r.seven_day, r.seven_day_opus, r.seven_day_sonnet, ...(r.model_scoped || [])]
        .filter(w => w?.resets_at && w.utilization >= 100).map(w => Date.parse(w.resets_at))
      at = full.length ? Math.max(...full) : Date.now() + 15 * 60000
    }
    this.cancelResume()
    this.resumeAt = at + 30000
    if (this.sessionId) Tab.saveResume(this.sessionId, { cwd: this.cwd, at: this.resumeAt })
    const text = el('span', 'grow')
    const auto = button('Continue automatically', () => { saveSettings({ autoContinue: true }); this.renderResume() }, 'sm')
    this.resumeCard = el('div', 'notice limit', icon('hourglass-medium'), text,
      auto, button('Continue now', () => this.resume(), 'sm'), button('Cancel', () => this.cancelResume(true), 'ghost sm'))
    this.resumeCard.text = text
    this.resumeCard.auto = auto
    this.add(this.resumeCard)
    this.renderResume()
    notify(`${this.name}: usage limit reached`, settings.autoContinue ? `Claude continues at ${clock(this.resumeAt)}` : `Resets at ${clock(this.resumeAt)}`)
  }

  renderResume() {
    const c = this.resumeCard
    if (!c) return
    c.auto.hidden = settings.autoContinue
    c.text.textContent = settings.autoContinue
      ? `Usage limit reached. Claude will continue this task at ${clock(this.resumeAt)} (in ${until(this.resumeAt)}).`
      : `Usage limit reached. It resets at ${clock(this.resumeAt)} (in ${until(this.resumeAt)}).`
  }

  tick() {
    const idle = this.live && !this.busy && !this.permissions && !this.resumeAt && Date.now() - this.lastActive > IDLE_STOP
    if (idle && ![...this.tasks.values()].some(t => t.status === 'running')) { api.stop(this.id); this.live = false }
    if (!this.resumeAt) return
    if (Date.now() >= this.resumeAt && settings.autoContinue) this.resume()
    else this.renderResume()
  }

  cancelResume(byUser) {
    if (!this.resumeAt) return
    this.resumeAt = 0
    if (this.sessionId) Tab.saveResume(this.sessionId, null)
    this.resumeCard?.replaceChildren(icon('hourglass-medium'), el('span', '', byUser ? 'Automatic continue cancelled' : 'Continued'))
    this.resumeCard?.classList.add('done')
    this.resumeCard = null
  }

  async resume() {
    this.cancelResume()
    notify(`${this.name}: continuing`, 'Usage limit has reset')
    await this.send(Tab.CONTINUE)
  }

  static CONTINUE = 'Your usage limit has reset. Continue the task you were working on from where you left off.'
  static resumes() { try { return JSON.parse(localStorage.getItem('resumes') || '{}') } catch { return {} } }
  static saveResume(id, v) {
    const all = Tab.resumes()
    if (v) all[id] = v; else delete all[id]
    localStorage.setItem('resumes', JSON.stringify(all))
  }

  userBubble(content, uuid, { queued } = {}) {
    const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    const d = el('div', 'user' + (queued ? ' queued' : ''))
    let text = ''
    for (const p of parts) {
      if (p.type === 'text') {
        let t = p.text
        if (/^<(local-command-caveat|system-reminder)/.test(t)) continue
        const bash = t.match(/<bash-input>([\s\S]*?)<\/bash-input>/)
        if (bash) { this.bashCard(bash[1], { stdout: t.match(/<bash-stdout>([\s\S]*?)<\/bash-stdout>/)?.[1] || '', stderr: t.match(/<bash-stderr>([\s\S]*?)<\/bash-stderr>/)?.[1] || '' }); return }
        t = t.replace(/<command-(name|args)>([\s\S]*?)<\/command-\1>/g, '$2 ').replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
          .replace(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/g, '$1').trim()
        text += t
        if (t) d.append(el('div', 'user-text', t))
      } else if (p.type === 'image') {
        const img = el('img'); img.src = `data:${p.source.media_type};base64,${p.source.data}`
        img.onclick = () => App.preview({ image: img.src, title: 'Image' })
        d.append(img)
      } else if (p.type === 'document') d.append(el('div', 'chip', icon('file-pdf'), p.title || 'PDF'))
    }
    if (!d.childElementCount) return
    d.dataset.uuid = uuid || ''
    d.prev = this.lastUuid
    d.text = text
    if (uuid) this.lastUuid = uuid
    const row = el('div', 'user-row', d)
    row.append(el('div', 'actions',
      iconButton('copy', 'Copy', e => copy(text, e.currentTarget)),
      iconButton('pencil-simple', 'Edit and resend from here', () => this.rewind(d, 'edit')),
      iconButton('arrows-clockwise', 'Retry from here', () => this.rewind(d, 'retry')),
      iconButton('clock-counter-clockwise', 'Rewind', e => menu(e.currentTarget, [
        { label: 'Restore conversation to before this', icon: 'chats', run: () => this.rewind(d, 'conversation') },
        { label: 'Restore code to before this', icon: 'code', run: () => this.rewind(d, 'code') },
        { label: 'Restore both', icon: 'arrow-counter-clockwise', run: () => this.rewind(d, 'both') },
        '-',
        { label: 'Fork into new tab from here', icon: 'git-fork', run: () => this.rewind(d, 'fork') },
      ]))))
    this.add(row)
  }

  async send(content) {
    if (!this.cwd) return
    this.cancelResume()
    this.suggestion = ''
    await this.ensureLive()
    this.lastActive = Date.now()
    const uuid = crypto.randomUUID()
    this.userBubble(content, uuid, { queued: this.busy })
    this.scroll(true)
    if (this.title === 'New conversation') {
      const t = typeof content === 'string' ? content : content.find(b => b.type === 'text')?.text
      if (t) this.title = t.slice(0, 60)
    }
    api.send(this.id, { message: { role: 'user', content }, uuid })
    this.setBusy(true)
  }

  async bash(command) {
    await this.ensureLive()
    const card = this.bashCard(command, null)
    const r = await api.runShell(this.cwd, command)
    card.fill(r)
    const text = `<bash-input>${command}</bash-input>\n<bash-stdout>${r.stdout}</bash-stdout><bash-stderr>${r.stderr}</bash-stderr>`
    api.send(this.id, { message: { role: 'user', content: text }, shouldQuery: false, uuid: crypto.randomUUID() })
  }

  bashCard(command, result) {
    const out = el('pre', 'term-out')
    const card = el('div', 'bash-card', el('div', 'bash-cmd', el('span', 'prompt', '!'), command), out)
    card.fill = r => {
      out.textContent = stripAnsi((r.stdout || '') + (r.stderr || '')).trimEnd() || '(no output)'
      if (r.code) card.classList.add('failed')
    }
    if (result) card.fill(result)
    else out.textContent = 'Running…'
    this.add(card)
    return card
  }

  async rewind(bubble, how) {
    if (this.busy) await api.control(this.id, 'interrupt')
    const text = bubble.text || ''
    if (how === 'code' || how === 'both') {
      await this.ensureLive()
      const dry = await api.control(this.id, 'rewindFiles', bubble.dataset.uuid, { dryRun: true }).catch(e => ({ error: String(e) }))
      if (!dry?.canRewind) { toast(dry?.error || 'No file checkpoint for this message', 'err'); if (how === 'code') return }
      else {
        const n = dry.filesChanged?.length || 0
        const ok = await confirmDialog('Restore code?', `This restores ${n} file${n === 1 ? '' : 's'} (+${dry.insertions || 0} −${dry.deletions || 0}) to how they were before this message.`, 'Restore files')
        if (!ok) return
        const r = await api.control(this.id, 'rewindFiles', bubble.dataset.uuid)
        toast(r?.canRewind === false ? r.error : `Restored ${n} file${n === 1 ? '' : 's'}`)
        if (how === 'code') return
      }
    }
    if (how === 'fork') {
      const id = bubble.prev && this.sessionId ? (await api.forkSession(this.sessionId, this.cwd, bubble.prev)).sessionId : null
      const tab = App.newTab(this.cwd, { activate: true })
      await tab.open(id)
      App.setComposer(text)
      return
    }
    const id = bubble.prev && this.sessionId ? (await api.forkSession(this.sessionId, this.cwd, bubble.prev)).sessionId : null
    await this.open(id)
    if (how === 'retry') this.send(text)
    else App.setComposer(text)
  }

  toolCard(block, parent) {
    const name = block.name
    const i = block.input || {}
    const isMcp = name.startsWith('mcp__')
    const label = isMcp ? name.split('__').slice(1).join(' · ') : name
    const summary = this.toolSummary(name, i)
    const head = el('summary', 'tool-head',
      el('span', 'tool-status'), icon(isMcp ? 'plugs' : TOOL_ICONS[name] || 'wrench', 'tool-icon'),
      el('span', 'tool-name', label), el('span', 'tool-summary', summary || ''), el('span', 'tool-meta'))
    const body = el('div', 'tool-body')
    const sub = el('div', 'sub')
    sub.hidden = true
    const card = el('details', 'tool running', head, body, sub)
    card.dataset.tool = name
    this.tools.set(block.id, { card, body, sub, block })

    const file = i.file_path || i.notebook_path
    if (file) head.querySelector('.tool-meta').append(iconButton('eye', 'Preview file', e => { e.preventDefault(); App.openFile(file) }, 'sm'),
      iconButton('code', 'Open in editor', e => { e.preventDefault(); App.openInEditor(file) }, 'sm'))

    if (name === 'Edit' || name === 'MultiEdit') {
      const rows = (i.edits || [i]).flatMap(e => lineDiff(e.old_string || '', e.new_string || ''))
      const dv = diffView(rows)
      body.append(dv)
      this.setStats(card, dv.stats)
      card.open = true
    } else if (name === 'Write') {
      const pre = el('pre', 'code-view')
      pre.innerHTML = highlightFile(i.content || '', file || '')
      body.append(pre)
      head.querySelector('.tool-meta').prepend(el('span', 'stat add', `+${(i.content || '').split('\n').length}`))
      card.open = true
    } else if (name === 'Bash') {
      body.append(el('pre', 'term-cmd', el('span', 'prompt', '$ '), i.command))
    } else if (name === 'TodoWrite') {
      body.append(this.todoList(i.todos || []))
      this.todos = i.todos || []
      App.tabChanged(this)
      Panels.refresh('tasks')
    } else if (name === 'ExitPlanMode') {
      body.append(md(i.plan || ''))
      card.open = true
    } else if (name === 'Task' || name === 'Agent') {
      if (i.subagent_type) head.querySelector('.tool-meta').prepend(el('span', 'pill', i.subagent_type))
      body.append(el('div', 'subagent-note', icon('info'), 'Subagents work in their own context window, so each one adds to your usage.'))
      body.append(el('details', 'prompt-details', el('summary', '', 'Prompt'), md(i.prompt || '')))
      card.open = true
    } else if (!['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'].includes(name)) {
      body.append(el('pre', 'json', JSON.stringify(i, null, 2)))
    }
    if (settings.expandTools) card.open = true
    this.add(card, parent)
  }

  setStats(card, { adds, dels }) {
    const meta = card.querySelector('.tool-meta')
    meta.querySelectorAll('.stat').forEach(s => s.remove())
    meta.prepend(el('span', 'stat add', `+${adds}`), el('span', 'stat del', `−${dels}`))
  }

  toolSummary(name, i) {
    const rel = p => (this.cwd && p?.startsWith(this.cwd) ? p.slice(this.cwd.length + 1) : p)
    switch (name) {
      case 'Bash': return i.description || i.command
      case 'Read': return rel(i.file_path) + (i.offset ? ` (from line ${i.offset})` : '')
      case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return rel(i.file_path || i.notebook_path)
      case 'Glob': return i.pattern
      case 'Grep': return `"${i.pattern}"` + (i.path ? ` in ${rel(i.path)}` : '')
      case 'WebFetch': return i.url
      case 'WebSearch': return i.query
      case 'Task': case 'Agent': return i.description
      case 'TodoWrite': {
        const done = (i.todos || []).filter(t => t.status === 'completed').length
        return `${done}/${i.todos?.length || 0} done`
      }
      case 'Skill': return i.skill || i.command
      case 'ExitPlanMode': return 'Plan ready for review'
      case 'AskUserQuestion': return i.questions?.[0]?.question
      default: return Object.values(i).find(v => typeof v === 'string')?.slice(0, 160) || ''
    }
  }

  todoList(todos) {
    const ul = el('ul', 'todos')
    for (const t of todos) ul.append(el('li', t.status, icon(t.status === 'completed' ? 'check-square' : t.status === 'in_progress' ? 'circle-notch' : 'square'), el('span', '', t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content)))
    return ul
  }

  toolResult(r, extra) {
    const t = this.tools.get(r.tool_use_id)
    if (!t) return
    const { card, body, block } = t
    card.classList.remove('running')
    if (r.is_error) card.classList.add('failed')
    const name = block.name
    const patch = extra?.structuredPatch
    if (patch?.length && ['Edit', 'MultiEdit', 'Write'].includes(name)) {
      const dv = diffView(patchRows(patch))
      body.replaceChildren(dv)
      this.setStats(card, dv.stats)
    }
    if (!r.is_error && ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
      const f = block.input.file_path || block.input.notebook_path
      this.changes.set(f, [...(this.changes.get(f) || []), block.input])
      Panels.refresh('changes')
    }
    const parts = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content || []
    const text = parts.filter(p => p.type === 'text').map(p => p.text).join('\n')
    if (name === 'Task' || name === 'Agent') { if (text.trim()) body.append(el('div', 'agent-result', md(text))); card.open = false }
    else if (['WebSearch', 'WebFetch'].includes(name) && !r.is_error) body.append(md(text.slice(0, 30000)))
    else if (name === 'Read' && !r.is_error) {
      card.querySelector('.tool-meta').prepend(el('span', 'muted', `${text.split('\n').length} lines`))
      const pre = el('pre', 'code-view')
      pre.textContent = text.slice(0, 30000)
      body.append(pre)
    } else if (!['Edit', 'MultiEdit', 'Write', 'TodoWrite', 'ExitPlanMode'].includes(name) || r.is_error) {
      const s = stripAnsi(text)
      if (s.trim()) body.append(el('pre', 'result' + (r.is_error ? ' err' : '') + (name === 'Bash' ? ' term-out' : ''), s.length > 30000 ? s.slice(0, 30000) + '\n… (truncated)' : s))
    }
    for (const p of parts) if (p.type === 'image') {
      const img = el('img', 'result-img'); img.src = `data:${p.source.media_type};base64,${p.source.data}`
      body.append(img)
    }
    if (r.is_error) card.open = true
  }

  permission(p) {
    this.permissions++
    App.tabChanged(this)
    notify(`${this.name}: Claude needs your input`, p.title || `Allow ${p.toolName}?`)
    const card = el('div', 'card')
    const done = result => {
      api.permit(this.id, p.id, result)
      const ok = result.behavior === 'allow'
      const what = p.toolName === 'AskUserQuestion' ? (ok ? 'Answered' : 'Skipped question')
        : p.toolName === 'ExitPlanMode' ? (ok ? 'Plan approved' : 'Kept planning')
        : `${ok ? (result.updatedPermissions ? 'Always allowed' : 'Allowed') : 'Denied'} ${p.toolName}`
      card.className = 'card done ' + (ok ? 'allowed' : 'denied')
      card.replaceChildren(icon(ok ? 'check' : 'x'), el('span', '', what), !ok && result.message !== 'User denied this action' ? el('span', 'muted', `: ${result.message}`) : null)
      this.permissions--
      App.tabChanged(this)
    }
    const row = el('div', 'row wrap')
    const btn = (label, fn, cls = '', key) => {
      const b = button(label, fn, cls)
      if (key) b.append(el('kbd', '', key))
      row.append(b)
      return b
    }
    const keys = {}

    if (p.toolName === 'AskUserQuestion') {
      const answers = {}
      card.append(el('div', 'card-title', icon('chat-circle'), 'Claude has a question'))
      for (const q of p.input.questions || []) {
        const box = el('div', 'question', el('div', 'q-text', q.header ? el('span', 'pill', q.header) : null, q.question))
        const opts = el('div', 'options'), chosen = new Set()
        const sync = () => (answers[q.question] = [...chosen].join(', '))
        for (const o of q.options || []) {
          const b = el('button', 'option', el('b', '', o.label), o.description ? el('span', 'muted', o.description) : null)
          b.onclick = () => {
            if (!q.multiSelect) { chosen.clear(); $$('.option', opts).forEach(x => x.classList.remove('selected')) }
            chosen.has(o.label) ? chosen.delete(o.label) : chosen.add(o.label)
            b.classList.toggle('selected', chosen.has(o.label)); sync()
          }
          opts.append(b)
        }
        const other = el('input', 'field'); other.type = 'text'; other.placeholder = 'Other answer…'
        other.oninput = () => { answers[q.question] = other.value || [...chosen].join(', ') }
        box.append(opts, other)
        card.append(box)
      }
      btn('Submit answers', () => done({ behavior: 'allow', updatedInput: { ...p.input, answers } }), 'primary')
      btn('Skip', () => done({ behavior: 'deny', message: 'User declined to answer' }), 'ghost')
    } else if (p.toolName === 'ExitPlanMode') {
      card.append(el('div', 'card-title', icon('list-checks'), 'Claude has a plan'), el('div', 'plan', md(p.input.plan || '')))
      const fb = el('input', 'field grow'); fb.type = 'text'; fb.placeholder = 'Or tell Claude what to change…'
      const approve = mode => () => { this.mode = mode; App.tabChanged(this); done({ behavior: 'allow', updatedInput: p.input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] }) }
      keys[1] = btn('Approve, edit automatically', approve('acceptEdits'), 'primary', '1')
      keys[2] = btn('Approve, ask before edits', approve('default'), '', '2')
      keys[3] = btn('Keep planning', () => done({ behavior: 'deny', message: fb.value || 'User wants to keep planning' }), 'ghost', '3')
      fb.onkeydown = e => { if (e.key === 'Enter') keys[3].click() }
      row.append(fb)
    } else {
      card.append(el('div', 'card-title', icon(TOOL_ICONS[p.toolName] || 'shield-check'), p.title || `Allow ${p.toolName}?`))
      if (p.decisionReason) card.append(el('div', 'muted small', p.decisionReason))
      const i = p.input || {}
      if (p.toolName === 'Bash') card.append(el('pre', 'term-cmd', el('span', 'prompt', '$ '), i.command), i.description ? el('div', 'muted small', i.description) : null)
      else if (p.toolName === 'Edit' || p.toolName === 'MultiEdit') card.append(el('div', 'file-label', App.relPath(this, i.file_path)), diffView((i.edits || [i]).flatMap(e => lineDiff(e.old_string || '', e.new_string || ''))))
      else if (p.toolName === 'Write') { const pre = el('pre', 'code-view'); pre.innerHTML = highlightFile(i.content || '', i.file_path || ''); card.append(el('div', 'file-label', App.relPath(this, i.file_path || '')), pre) }
      else card.append(el('pre', 'json', JSON.stringify(i, null, 2)))
      const fb = el('input', 'field grow'); fb.type = 'text'; fb.placeholder = 'Or tell Claude what to do instead…'
      const deny = () => done({ behavior: 'deny', message: fb.value || 'User denied this action' })
      fb.onkeydown = e => { if (e.key === 'Enter') deny() }
      keys[1] = btn('Allow', () => done({ behavior: 'allow', updatedInput: i }), 'primary', '1')
      if (p.suggestions?.length) keys[2] = btn('Always allow', () => done({ behavior: 'allow', updatedInput: i, updatedPermissions: p.suggestions }), '', '2')
      keys[3] = btn('Deny', deny, 'ghost', '3')
      row.append(fb)
    }
    card.append(row)
    card.onkeydown = e => { if (keys[e.key] && e.target.tagName !== 'INPUT') { e.preventDefault(); keys[e.key].click() } }
    card.tabIndex = -1
    this.add(card)
    this.scroll(true)
    setTimeout(() => (card.querySelector('button.primary') || card).focus({ preventScroll: true }), 50)
  }

  loginPrompt() {
    const b = button('Sign in to Claude', async () => {
      b.disabled = true
      b.querySelector('span').textContent = 'Finish signing in in your browser…'
      const r = await api.cli(['auth', 'login'])
      b.querySelector('span').textContent = r.code ? 'Sign-in failed. Run `claude auth login` in a terminal.' : 'Signed in'
      if (!r.code) this.start()
    }, 'primary', 'sign-in')
    this.add(b)
  }

  async markdown() {
    const msgs = this.sessionId ? await api.history(this.sessionId, this.cwd) : []
    let out = `# ${this.title}\n\n_${this.cwd}_\n\n`
    for (const m of msgs) {
      const c = m.message?.content
      const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : c || []
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) out += `## ${m.type === 'user' ? 'You' : 'Claude'}\n\n${b.text}\n\n`
        if (b.type === 'tool_use') out += `> **${b.name}** \`${JSON.stringify(b.input).slice(0, 300)}\`\n\n`
      }
    }
    return out
  }

  async exportMarkdown() {
    if (!this.sessionId) return toast('Nothing to export yet')
    if (await api.saveFile(`${this.title.replace(/[^\w\- ]+/g, '').slice(0, 60) || 'conversation'}.md`, await this.markdown())) toast('Exported')
  }
}

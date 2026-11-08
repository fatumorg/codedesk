const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function describeWhen(w = {}) {
  if (w.kind === 'once') return w.at ? `Once, ${new Date(w.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : 'Once'
  if (w.kind === 'daily') {
    const d = w.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6]
    const days = d.length === 7 ? 'Every day' : d.join() === '1,2,3,4,5' ? 'Weekdays' : d.map(i => WEEKDAYS[i]).join(', ')
    return `${days} at ${w.time}`
  }
  if (w.kind === 'reset') return `When ${accountName(w.account || 'system')}'s limit resets${w.then ? ', every time' : ''}`
  return ''
}

function scheduleStatus(s) {
  const parts = []
  if (!s.enabled) parts.push(s.when?.kind === 'once' && s.lastRun?.ok ? 'Done' : 'Off')
  else if (s.nextRun) parts.push(el('span', '', 'Next ', clock(s.nextRun), ', in ', liveTime(s.nextRun)))
  else if (s.when?.kind === 'reset') parts.push('Waiting for the limit')
  if (s.lastRun) parts.push(s.lastRun.ok ? `Last ran ${ago(s.lastRun.at)}` : `Last run failed: ${s.lastRun.error || 'unknown error'}`)
  const out = el('div', 'muted small sched-status')
  parts.forEach((p, i) => out.append(...(i ? [el('br')] : []), p))
  return out
}

async function openSchedules() {
  const list = el('div', 'sched-list')
  const body = el('div', 'stack', list, el('div', 'row end', button('New schedule', () => editSchedule(), 'primary', 'plus')))
  const m = modal('Schedules', body, { wide: true, onClose: () => { App.schedulesView = null } })
  const draw = async () => {
    if (!list.isConnected) return
    const all = await api.schedules().catch(() => null)
    if (!all) return list.replaceChildren(el('div', 'notice err', icon('warning'), el('span', '', 'Could not load schedules.')))
    if (!all.length) return list.replaceChildren(el('div', 'sched-empty',
      el('div', 'setting-label', 'No scheduled prompts yet'),
      el('div', 'muted small', 'Send a prompt at a set time, on chosen weekdays, or as soon as a usage limit resets. Into a new conversation or one you already have.')))
    list.replaceChildren(...all.sort((a, b) => (a.nextRun || Infinity) - (b.nextRun || Infinity)).map(s => {
      const sw = el('input', 'switch'); sw.type = 'checkbox'; sw.checked = !!s.enabled
      sw.title = s.enabled ? 'Turn off' : 'Turn on'
      sw.onchange = () => api.saveSchedule({ ...s, enabled: sw.checked }).catch(e => toast(String(e.message || e), 'err'))
      const target = s.target?.kind === 'resume' ? App.titles.get(s.target.sessionId) || 'Existing conversation' : 'New conversation'
      return el('div', 'sched-row',
        el('div', 'sched-main',
          el('div', 'setting-label', s.name || s.prompt.slice(0, 60)),
          el('div', 'muted small', describeWhen(s.when)),
          el('div', 'muted small', `${target} in ${basename(s.target?.cwd || '')}`),
          scheduleStatus(s)),
        el('div', 'row tight',
          iconButton('play', 'Run now', async () => { await api.runSchedule(s.id).catch(e => toast(String(e.message || e), 'err')); toast(`Sending "${s.name || 'scheduled prompt'}"`) }),
          iconButton('pencil-simple', 'Edit', () => editSchedule(s)),
          iconButton('trash', 'Delete', async () => { if (await confirmDialog('Delete schedule?', `"${s.name || s.prompt.slice(0, 40)}" will not run again.`, 'Delete', true)) api.deleteSchedule(s.id) }),
          sw))
    }))
  }
  App.schedulesView = draw
  draw()
  return m
}

async function editSchedule(prev = {}) {
  const tab = App.active
  const s = {
    name: '', prompt: '', enabled: true,
    target: { kind: 'new', cwd: tab?.cwd || '' },
    opts: { model: tab?.model || settings.defaultModel, effort: tab?.effort || settings.defaultEffort, permissionMode: tab?.mode || settings.defaultMode, account: tab?.account || settings.account },
    when: { kind: 'once', at: Date.now() + 3600e3 },
    ...structuredClone(prev),
  }
  const pad = n => String(n).padStart(2, '0')
  const localInput = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` }
  const field = (tag, value, type) => { const f = el(tag, 'field'); if (type) f.type = type; f.value = value ?? ''; return f }
  const choose = (options, value) => {
    const f = el('select', 'field', ...options.map(([v, l]) => Object.assign(el('option', '', l), { value: v, selected: v === value })))
    return f
  }
  const segmented = (options, value, onpick) => {
    const g = el('div', 'segmented')
    const draw = v => g.replaceChildren(...options.map(([k, l, ic]) => button(l, () => { draw(k); onpick(k) }, k === v ? 'on' : '', ic)))
    draw(value)
    return g
  }
  const label = (text, control, hint) => el('label', '', text, control, hint ? el('span', 'muted small', hint) : null)

  const name = field('input', s.name)
  const prompt = field('textarea', s.prompt); prompt.rows = 4
  const cwd = field('input', s.target.cwd); cwd.placeholder = '/path/to/project'
  const sessionPick = el('select', 'field')
  const loadSessions = async () => {
    const list = cwd.value ? await api.listSessions(cwd.value).catch(() => []) : []
    const opts = list.filter(x => !/^gemini/i.test(x.model || '')).map(x => [x.sessionId, `${x.customTitle || x.summary || x.firstPrompt || 'Untitled'} (${ago(x.lastModified)})`])
    if (s.target.sessionId && !opts.some(([v]) => v === s.target.sessionId)) opts.unshift([s.target.sessionId, App.titles.get(s.target.sessionId) || 'This conversation'])
    sessionPick.replaceChildren(...(opts.length ? opts : [['', 'No conversations in this folder']]).map(([v, l]) => Object.assign(el('option', '', l), { value: v, selected: v === s.target.sessionId })))
  }
  cwd.onchange = loadSessions
  const sessionRow = label('Conversation', sessionPick)
  const setTarget = k => { s.target.kind = k; sessionRow.hidden = k !== 'resume'; if (k === 'resume') loadSessions() }
  const folderRow = el('div', 'row', cwd, REMOTE ? null : button('Choose', async () => { const d = await api.pickFolder(); if (d) { cwd.value = d; loadSessions() } }, '', 'folder-open'))

  const at = field('input', localInput(s.when.at || Date.now() + 3600e3), 'datetime-local')
  const time = field('input', s.when.time || '09:00', 'time')
  const days = new Set(s.when.days || [1, 2, 3, 4, 5])
  const dayRow = el('div', 'sched-days')
  const drawDays = () => dayRow.replaceChildren(...WEEKDAYS.map((d, i) => {
    const b = button(d, () => { days.has(i) ? days.delete(i) : days.add(i); drawDays() }, 'chip' + (days.has(i) ? ' on' : ''))
    b.setAttribute('aria-pressed', days.has(i))
    return b
  }))
  drawDays()
  const accounts = [['system', accountName('system')], ...(App.accounts || []).filter(a => a.id !== 'system').map(a => [a.id, accountName(a.id)])]
  const resetAccount = choose(accounts, s.when.account || s.opts.account || 'system')
  const repeat = el('input', 'switch'); repeat.type = 'checkbox'; repeat.checked = !!s.when.then
  const whenBox = el('div', 'stack')
  const drawWhen = k => {
    s.when.kind = k
    whenBox.replaceChildren(...(k === 'once' ? [label('Date and time', at)]
      : k === 'daily' ? [label('Time', time), el('div', 'stack tight', el('span', 'muted small', 'Days'), dayRow)]
      : [label('Account', resetAccount, 'Sends a minute after this account\'s usage limit resets. If it is not limited yet, it waits for the next limit.'),
        el('div', 'setting', el('div', 'setting-text', el('div', 'setting-label', 'Every time the limit resets')), repeat)]))
  }
  drawWhen(s.when.kind)

  const model = choose(mainModels(tab).filter(x => !/^local:/.test(x.value)).map(x => [x.value, x.label]), s.opts.model)
  const effort = choose(EFFORTS.map(e => [e.value, e.label]), s.opts.effort)
  const mode = choose(MODES.map(x => [x.value, x.label]), s.opts.permissionMode)
  const account = choose(accounts, s.opts.account || 'system')
  const error = el('div', 'notice err'); error.hidden = true

  const save = async () => {
    const out = {
      ...s, name: name.value.trim(), prompt: prompt.value,
      target: s.target.kind === 'resume' ? { kind: 'resume', cwd: cwd.value.trim(), sessionId: sessionPick.value } : { kind: 'new', cwd: cwd.value.trim() },
      opts: { model: model.value, effort: effort.value, permissionMode: mode.value, account: account.value },
      when: s.when.kind === 'once' ? { kind: 'once', at: new Date(at.value).getTime() }
        : s.when.kind === 'daily' ? { kind: 'daily', time: time.value, days: [...days].sort() }
        : { kind: 'reset', account: resetAccount.value, then: repeat.checked },
    }
    const problem = !out.prompt.trim() ? 'Write the prompt to send.'
      : !out.target.cwd ? 'Choose a project folder.'
      : out.target.kind === 'resume' && !out.target.sessionId ? 'Pick the conversation to continue.'
      : out.when.kind === 'once' && !(out.when.at > Date.now()) ? 'Pick a time in the future.'
      : out.when.kind === 'daily' && (!out.when.time || !out.when.days.length) ? 'Pick a time and at least one day.'
      : null
    if (problem) { error.replaceChildren(icon('warning'), el('span', '', problem)); error.hidden = false; return }
    try {
      await api.saveSchedule(out)
      m.close()
      toast(out.name ? `Scheduled "${out.name}"` : 'Scheduled')
    } catch (e) { error.replaceChildren(icon('warning'), el('span', '', String(e.message || e))); error.hidden = false }
  }

  const body = el('div', 'stack sched-form',
    label('Name', name),
    label('Prompt', prompt, 'Slash commands work too, like /compact.'),
    label('Project folder', folderRow),
    el('div', 'stack tight', el('span', 'muted small', 'Send into'), segmented([['new', 'New conversation', 'chat-circle'], ['resume', 'Existing conversation', 'arrow-bend-down-right']], s.target.kind, setTarget)),
    sessionRow,
    el('div', 'stack tight', el('span', 'muted small', 'When'), segmented([['once', 'Once', 'calendar-blank'], ['daily', 'Repeat', 'repeat'], ['reset', 'After limit reset', 'hourglass-medium']], s.when.kind, drawWhen)),
    whenBox,
    el('div', 'sched-grid', label('Model', model), label('Effort', effort), label('Permission mode', mode), label('Account', account)),
    error,
    el('div', 'row end', button('Cancel', () => m.close(), 'ghost'), button(prev.id ? 'Save' : 'Schedule', save, 'primary')))
  setTarget(s.target.kind)
  const m = modal(prev.id ? 'Edit schedule' : 'New schedule', body, { wide: true })
  return m
}

function scheduleFor(tab, extra = {}) {
  editSchedule({
    name: `Continue ${tab.title || basename(tab.cwd)}`,
    prompt: tab.continuePrompt,
    target: { kind: 'resume', cwd: tab.cwd, sessionId: tab.sessionId },
    opts: { model: tab.model, effort: tab.effort, permissionMode: tab.mode, account: tab.account },
    when: { kind: 'reset', account: tab.account, then: false },
    ...extra,
  })
}

api.on('schedules:changed', () => App.schedulesView?.())
api.on('schedules:ran', d => {
  App.schedulesView?.()
  if (d.ok) { toast(`Scheduled prompt sent: ${d.name || 'untitled'}`); notify('Scheduled prompt sent', d.name || '') }
  else { toast(`Scheduled prompt failed: ${d.error}`, 'err'); notify('Scheduled prompt failed', d.error || '') }
  App.refreshSessions?.()
})

const $ = (s, root = document) => root.querySelector(s)
const $$ = (s, root = document) => [...root.querySelectorAll(s)]
function el(tag, cls, ...kids) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  for (const k of kids) if (k != null && k !== false) e.append(k)
  return e
}
const icon = (name, cls = '') => el('i', `ph-bold ph-${name} ${cls}`)
function button(label, onclick, cls = '', iconName) {
  const b = el('button', cls, iconName ? icon(iconName) : null, label ? el('span', '', label) : null)
  if (onclick) b.onclick = onclick
  return b
}
const iconButton = (name, title, onclick, cls = '') => {
  const b = button(null, onclick, 'icon ' + cls, name)
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}
const REMOTE = 'remote' in document.documentElement.dataset
const onPc = label => (REMOTE ? label + ' on PC' : label)
const basename = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p
const sep = p => (p.includes('\\') && !p.includes('/') ? '\\' : '/')
const join = (a, b) => (a.endsWith(sep(a)) ? a + b : a + sep(a) + b)
const ago = t => {
  const s = (Date.now() - t) / 1000
  return s < 60 ? 'just now' : s < 3600 ? `${s / 60 | 0}m ago` : s < 86400 ? `${s / 3600 | 0}h ago` : `${s / 86400 | 0}d ago`
}
const dur = ms => {
  let s = Math.max(0, Math.round(ms / 1000))
  const parts = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']].map(([n, u]) => { const v = s / n | 0; s %= n; return [v, u] })
  const i = parts.findIndex(([v]) => v)
  return i < 0 ? '0s' : parts.slice(i).map(([v, u]) => v + u).join(' ')
}
const until = t => dur(t - Date.now())
const liveTime = (t, since) => {
  const e = el('span', 'timer', since ? dur(Date.now() - t) : until(t))
  e.dataset[since ? 'since' : 'until'] = t
  return e
}
const tickTimers = () => $$('.timer').forEach(e => (e.textContent = e.dataset.since ? dur(Date.now() - e.dataset.since) : until(+e.dataset.until)))
const clock = t => new Date(t).toLocaleString([], { weekday: t - Date.now() > 864e5 ? 'short' : undefined, hour: '2-digit', minute: '2-digit' })
const fmtTokens = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n))
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

const DEFAULTS = {
  theme: 'system', palette: 'warm', accent: 'terracotta', accentCustom: '#c96442', uiFont: 'geist', proseFont: 'serif', monoFont: 'geist',
  density: 'comfortable', radius: 'soft', fontSize: 14, chatWidth: 780, motion: true, customCss: '',
  showThinking: true, expandTools: false, sounds: false, enterSends: true, notifications: true, autoContinue: true, continuePrompt: '', continuePrompts: {}, continueFirst: {}, account: 'system', projectAccounts: {}, sessionAccounts: {}, sessionPrefs: {}, autoSwitchAccount: false, saverModel: '', subagentModel: '', allowSubagents: true, compactAt: '', maxTurns: '', saverOn: false, saverQuickWords: 'explain, what is, what does, list, where is, rename, typo, format, summarize, translate', saverQuickModel: 'haiku', saverHeavyWords: 'design, architect, debug, refactor, migrate, implement, plan, security, review, investigate, fix', saverHeavyModel: 'opus', saverOtherModel: 'sonnet', editor: 'code',
  defaultMode: 'auto', defaultModel: 'opus', defaultEffort: 'medium', defaultUltracode: false,
  panelWidth: 460, sidebar: true, panel: false, panelTab: 'files', pinned: [], workspaces: {}, projects: [], v: 2,
}
const ACCENTS = {
  terracotta: ['Terracotta', '#c96442', '#d97757'], ocean: ['Ocean', '#2f6fb0', '#6aa6e8'], forest: ['Forest', '#3d7a4f', '#74b98a'],
  rose: ['Rose', '#b8456b', '#e07a9c'], amber: ['Amber', '#a8730f', '#e0a83a'], plum: ['Plum', '#7d4b97', '#b58ad0'], graphite: ['Graphite', '#3f3e3b', '#c9c6be'],
}
const PALETTES = { warm: 'Warm', neutral: 'Neutral', cool: 'Cool', black: 'Midnight' }
const FONTS = {
  geist: '"Geist Variable", system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, sans-serif',
  newsreader: '"Newsreader Variable", "Iowan Old Style", Georgia, serif',
  geistMono: '"Geist Mono Variable", ui-monospace, monospace',
  systemMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
}
const DEVICE_KEYS = new Set('theme palette accent accentCustom uiFont proseFont monoFont density radius fontSize chatWidth motion customCss panelWidth sidebar panel panelTab sounds notifications enterSends'.split(' '))
const pickShared = obj => Object.fromEntries(Object.entries(obj).filter(([k]) => !DEVICE_KEYS.has(k) && k !== 'v'))
const settings = (() => {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem('settings') || '{}') } catch {}
  let projects = []
  try { projects = JSON.parse(localStorage.getItem('projects') || '[]') } catch {}
  if (saved.v !== 2) {
    if (saved.serifProse === false) saved.proseFont = 'sans'
    for (const k of ['defaultMode', 'defaultModel', 'defaultEffort', 'serifProse']) delete saved[k]
  }
  if (saved.defaultEffort === 'ultracode') Object.assign(saved, { defaultEffort: 'xhigh', defaultUltracode: true })
  return { ...DEFAULTS, projects, ...saved, ...api.shared, v: 2 }
})()
if (!api.shared) api.saveShared(pickShared(settings)).catch(() => {})
function saveSettings(patch) {
  Object.assign(settings, patch)
  try { localStorage.setItem('settings', JSON.stringify(settings)) } catch {}
  const shared = pickShared(patch)
  if (Object.keys(shared).length) api.saveShared(shared).catch(() => {})
  applySettings()
}
function applySettings() {
  const r = document.documentElement
  if (settings.theme === 'system') r.removeAttribute('data-theme')
  else r.dataset.theme = settings.theme
  const dark = isDark()
  Object.assign(r.dataset, { mode: dark ? 'dark' : 'light', palette: settings.palette, density: settings.density, radius: settings.radius })
  const accent = settings.accent === 'custom' ? settings.accentCustom : (ACCENTS[settings.accent] || ACCENTS.terracotta)[dark ? 2 : 1]
  const sans = settings.uiFont === 'system' ? FONTS.system : FONTS.geist
  const mono = settings.monoFont === 'system' ? FONTS.systemMono : FONTS.geistMono
  const vars = {
    '--font-size': settings.fontSize + 'px', '--chat-width': settings.chatWidth + 'px', '--panel-width': settings.panelWidth + 'px',
    '--accent': accent, '--accent-soft': `color-mix(in srgb, ${accent} ${dark ? 18 : 13}%, transparent)`,
    '--sans': sans, '--mono': mono, '--serif': { serif: FONTS.newsreader, sans, mono }[settings.proseFont] || FONTS.newsreader,
  }
  for (const [k, v] of Object.entries(vars)) r.style.setProperty(k, v)
  r.classList.toggle('sans-prose', settings.proseFont !== 'serif')
  r.classList.toggle('no-motion', !settings.motion)
  r.classList.toggle('hide-thinking', !settings.showThinking)
  let css = document.getElementById('custom-css')
  if (!css) { css = el('style'); css.id = 'custom-css'; document.head.append(css) }
  css.textContent = settings.customCss || ''
  document.body.classList.toggle('no-sidebar', !settings.sidebar)
  document.body.classList.toggle('with-panel', settings.panel)
  if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict' })
}
const loaded = new Map()
function loadScript(src) {
  if (!loaded.has(src)) loaded.set(src, new Promise((res, rej) => {
    const s = el('script'); s.src = src; s.onload = res; s.onerror = rej
    document.head.append(s)
  }))
  return loaded.get(src)
}
function loadStyle(href) {
  if (!loaded.has(href)) { const l = el('link'); l.rel = 'stylesheet'; l.href = href; document.head.append(l); loaded.set(href, true) }
}
const isDark = () => settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

marked.use(markedKatex({ throwOnError: false, nonStandard: true }))
marked.use({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang || '').split(/\s/)[0].toLowerCase()
      if (l === 'mermaid') return `<div class="mermaid-src" data-src="${encodeURIComponent(text)}"></div>`
      const html = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l }).value : hljs.highlightAuto(text).value
      return `<pre data-lang="${l}"><code class="hljs">${html}</code></pre>`
    },
  },
})

function md(text) {
  const d = el('div', 'md')
  d.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['data-lang', 'data-src'] })
  for (const pre of $$('pre', d)) {
    const lang = pre.dataset.lang
    const code = () => pre.querySelector('code').innerText
    const bar = el('div', 'code-bar', el('span', 'lang', lang || 'text'))
    if (['html', 'svg', 'xml'].includes(lang)) bar.append(button('Preview', () => App.preview({ html: code(), title: `${lang} snippet` }), 'ghost sm', 'eye'))
    if (['bash', 'sh', 'shell', 'zsh', 'console'].includes(lang)) bar.append(button('Run', () => App.runInTerminal(code()), 'ghost sm', 'play'))
    bar.append(button('Copy', e => copy(code(), e.currentTarget), 'ghost sm', 'copy'))
    pre.before(bar)
    const wrap = el('div', 'code-block')
    bar.before(wrap)
    wrap.append(bar, pre)
  }
  const charts = $$('.mermaid-src', d)
  if (charts.length) loadScript('../vendor/mermaid.min.js').then(() => { applySettings(); charts.forEach(renderMermaid) })
  return d
}

let mermaidSeq = 0
async function renderMermaid(node) {
  const src = decodeURIComponent(node.dataset.src)
  try {
    const { svg } = await mermaid.render('mmd' + ++mermaidSeq, src)
    node.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } })
    node.className = 'mermaid-diagram'
    node.append(el('div', 'code-bar floating', button('Open', () => App.preview({ html: svg, title: 'Diagram' }), 'ghost sm', 'arrow-square-out')))
  } catch {
    node.replaceWith(el('pre', '', el('code', '', src)))
  }
}

function highlightFile(text, file) {
  const ext = (file.split('.').pop() || '').toLowerCase()
  const lang = { mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', tsx: 'typescript', nix: 'nix', md: 'markdown', yml: 'yaml', rs: 'rust', py: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash' }[ext] || ext
  return hljs.getLanguage(lang) ? hljs.highlight(text, { language: lang }).value : DOMPurify.sanitize(text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])))
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text)
  if (!btn) return
  const span = btn.querySelector('span')
  const old = span?.textContent
  if (span) span.textContent = 'Copied'
  btn.classList.add('ok')
  setTimeout(() => { if (span) span.textContent = old; btn.classList.remove('ok') }, 1200)
}

function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n'), n = A.length, m = B.length
  if (n * m > 4e6) return [...A.map(s => ({ t: '-', s })), ...B.map(s => ({ t: '+', s }))]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', s: A[i++] })
    else out.push({ t: '+', s: B[j++] })
  }
  while (i < n) out.push({ t: '-', s: A[i++] })
  while (j < m) out.push({ t: '+', s: B[j++] })
  return out
}

function diffView(rows) {
  const t = el('div', 'diff')
  let adds = 0, dels = 0
  for (const r of rows) {
    if (r.t === '@') { t.append(el('div', 'hunk', r.s)); continue }
    if (r.t === '+') adds++
    if (r.t === '-') dels++
    t.append(el('div', 'line ' + ({ '+': 'add', '-': 'del', ' ': 'ctx' }[r.t]),
      el('span', 'ln', r.a ?? ''), el('span', 'ln', r.b ?? ''), el('span', 'sign', r.t), el('span', 'code', r.s)))
  }
  t.stats = { adds, dels }
  return t
}

function parseUnified(text) {
  const rows = []
  let a = 0, b = 0
  for (const line of text.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/)
    if (h) { a = +h[1]; b = +h[2]; rows.push({ t: '@', s: line }); continue }
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue
    if (line.startsWith('+')) rows.push({ t: '+', s: line.slice(1), b: b++ })
    else if (line.startsWith('-')) rows.push({ t: '-', s: line.slice(1), a: a++ })
    else if (line.startsWith(' ')) rows.push({ t: ' ', s: line.slice(1), a: a++, b: b++ })
  }
  return rows
}

function patchRows(hunks) {
  const rows = []
  for (const h of hunks) {
    let a = h.oldStart, b = h.newStart
    rows.push({ t: '@', s: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` })
    for (const l of h.lines) {
      const t = l[0], s = l.slice(1)
      rows.push(t === '+' ? { t, s, b: b++ } : t === '-' ? { t, s, a: a++ } : { t: ' ', s, a: a++, b: b++ })
    }
  }
  return rows
}

function popover(anchor, node, cls = '') {
  closeMenus()
  const m = el('div', 'menu ' + cls, node)
  document.body.append(m)
  const r = anchor.getBoundingClientRect?.() || { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y }
  const w = m.offsetWidth, h = m.offsetHeight
  const overflowsRight = r.left + w > innerWidth - 8
  const fitsRightAligned = r.right - w >= 8
  const left = overflowsRight && fitsRightAligned ? r.right - w : r.left
  m.style.left = Math.max(8, Math.min(left, innerWidth - w - 8)) + 'px'
  m.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px'
  setTimeout(() => document.addEventListener('mousedown', outside), 0)
  function outside(e) { if (!m.contains(e.target)) closeMenus() }
  m.cleanup = () => document.removeEventListener('mousedown', outside)
  return m
}
function menuItems(items) {
  const out = []
  for (const it of items) {
    if (it === '-') { out.push(el('div', 'sep')); continue }
    if (it.header) { out.push(el('div', 'menu-header', it.header)); continue }
    const b = button(it.label, () => {
      if (it.more) {
        const m = b.closest('.menu')
        b.replaceWith(el('div', 'menu-more', ...menuItems(it.more)))
        m.style.top = Math.max(8, Math.min(parseFloat(m.style.top), innerHeight - m.offsetHeight - 8)) + 'px'
        return
      }
      closeMenus(); it.run()
    }, (it.danger ? 'danger' : '') + (it.more ? ' more' : ''), it.icon)
    if (it.detail) b.querySelector('span').append(el('small', '', it.detail))
    if (it.hint) b.append(el('kbd', '', it.hint))
    if (it.more) b.append(icon('caret-down'))
    if (it.checked) b.classList.add('checked')
    out.push(b)
  }
  return out
}
function menu(anchor, items) {
  const m = popover(anchor, el('div', 'menu-list', ...menuItems(items)))
  m.querySelector('button')?.focus()
  return m
}
function closeMenus() { $$('.menu').forEach(m => { m.cleanup?.(); m.remove() }) }

function modal(title, body, { wide, onClose } = {}) {
  const back = el('div', 'modal-back')
  const box = el('div', 'modal' + (wide ? ' wide' : ''))
  const close = () => { back.remove(); onClose?.() }
  box.append(el('div', 'modal-head', el('h2', '', title), iconButton('x', 'Close', close)), body)
  back.append(box)
  back.onmousedown = e => { if (e.target === back) close() }
  back.onkeydown = e => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  document.body.append(back)
  setTimeout(() => (box.querySelector('input,textarea,select,button:not(.icon)') || box).focus(), 0)
  return { close, box }
}

function prompt(title, value = '', { placeholder = '', multiline } = {}) {
  return new Promise(resolve => {
    const input = el(multiline ? 'textarea' : 'input', 'field')
    input.value = value
    input.placeholder = placeholder
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v); m.close() } }
    const body = el('div', 'stack', input, el('div', 'row end', button('Cancel', () => finish(null), 'ghost'), button('Save', () => finish(input.value), 'primary')))
    input.onkeydown = e => { if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(input.value) } }
    const m = modal(title, body, { onClose: () => finish(null) })
    setTimeout(() => input.select?.(), 0)
  })
}

function confirmDialog(title, text, okLabel = 'Confirm', danger) {
  return new Promise(resolve => {
    let done = false
    const finish = v => { if (!done) { done = true; resolve(v); m.close() } }
    const body = el('div', 'stack', el('p', 'muted', text),
      el('div', 'row end', button('Cancel', () => finish(false), 'ghost'), button(okLabel, () => finish(true), danger ? 'danger-solid' : 'primary')))
    const m = modal(title, body, { onClose: () => finish(false) })
  })
}

function toast(text, kind = '') {
  const t = el('div', 'toast ' + kind, text)
  $('#toasts').append(t)
  setTimeout(() => t.classList.add('out'), 3500)
  setTimeout(() => t.remove(), 4000)
}

let audio
function chime() {
  try {
    audio ||= new AudioContext()
    const t = audio.currentTime
    for (const [f, d] of [[880, 0], [1320, 0.09]]) {
      const o = audio.createOscillator(), g = audio.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t + d)
      g.gain.exponentialRampToValueAtTime(0.08, t + d + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.35)
      o.connect(g).connect(audio.destination)
      o.start(t + d); o.stop(t + d + 0.4)
    }
  } catch {}
}
function notify(title, body) {
  if (!settings.notifications || document.hasFocus()) return
  try { new Notification(title, { body, silent: false }) } catch {}
}

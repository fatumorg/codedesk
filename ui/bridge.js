(() => {
  if (window.api || !window.__TAURI__) return
  const T = window.__TAURI__
  const boot = window.__codedesk || {}
  const me = T.webviewWindow.getCurrentWebviewWindow()
  const listeners = new Map()
  const emit = (ch, d) => listeners.get(ch)?.forEach(fn => fn(d))
  me.listen('cd', e => emit(e.payload.ch, e.payload.d))
  const call = ch => (...args) => T.core.invoke('call', { ch, args })

  const paths = new WeakMap()
  const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' }
  const fileFor = async p => {
    const name = p.split(/[\\/]/).pop()
    const type = TYPES[name.split('.').pop().toLowerCase()] || ''
    const data = type ? await T.core.invoke('call', { ch: 'readBytes', args: [p] }).catch(() => null) : null
    const f = new File(data ? [Uint8Array.from(atob(data), c => c.charCodeAt(0))] : [], name, { type })
    paths.set(f, p)
    return f
  }
  const fire = (type, files) => {
    const dt = new DataTransfer()
    for (const f of files || []) dt.items.add(f)
    const target = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body
    target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
  }
  me.onDragDropEvent(async e => {
    const { type } = e.payload
    if (type === 'enter') fire('dragenter', [])
    else if (type === 'over') fire('dragover', [])
    else if (type === 'leave') fire('dragleave', [])
    else if (type === 'drop') fire('drop', await Promise.all((e.payload.paths || []).map(fileFor)))
  })

  let finds = { text: '', hits: 0, at: 0 }
  const countHits = text => {
    const hay = document.body.innerText.toLowerCase(), needle = text.toLowerCase()
    let n = 0
    for (let i = hay.indexOf(needle); i >= 0 && n < 10000; i = hay.indexOf(needle, i + needle.length)) n++
    return n
  }
  const find = async (text, opts = {}) => {
    const box = document.getElementById('find-input')
    if (!text) { getSelection()?.removeAllRanges(); finds = { text: '', hits: 0, at: 0 }; return }
    if (text !== finds.text) finds = { text, hits: countHits(text), at: 0 }
    const back = opts.findNext && opts.forward === false
    if (!opts.findNext) { getSelection()?.removeAllRanges(); finds.at = 0 }
    const hadFocus = document.activeElement === box
    const ok = finds.hits && window.find(text, false, back, true, false, false, false)
    if (ok) finds.at = back ? (finds.at <= 1 ? finds.hits : finds.at - 1) : (finds.at >= finds.hits ? 1 : finds.at + 1)
    if (hadFocus) box.focus()
    emit('found', { matches: finds.hits, activeMatchOrdinal: ok ? finds.at : 0, finalUpdate: true })
  }

  const zoom = d => {
    const z = d === 0 ? 1 : Math.min(3, Math.max(0.3, (+localStorage.getItem('zoom') || 1) + d))
    localStorage.setItem('zoom', z)
    call('zoom')(z)
  }
  if (+localStorage.getItem('zoom') && +localStorage.getItem('zoom') !== 1) call('zoom')(+localStorage.getItem('zoom'))
  const KEYS = {
    't': () => emit('menu', 'newTab'), 'N': () => call('newWindow')(), 'o': () => emit('menu', 'openFolder'),
    'w': () => emit('menu', 'closeTab'), 'E': () => emit('menu', 'export'), ',': () => emit('menu', 'settings'),
    'k': () => emit('menu', 'palette'), 'f': () => emit('menu', 'find'), 'r': () => emit('menu', 'history'),
    'b': () => emit('menu', 'sidebar'), 'j': () => emit('menu', 'panel'), '`': () => emit('menu', 'terminal'),
    'R': () => location.reload(), 'I': () => call('devtools')(), '=': () => zoom(0.1), '+': () => zoom(0.1),
    '-': () => zoom(-0.1), '0': () => zoom(0), 'q': () => call('quit')(),
  }
  addEventListener('keydown', e => {
    if (e.key === 'F11') { e.preventDefault(); call('fullscreen')(); return }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const k = e.shiftKey && e.key.length === 1 ? e.key.toUpperCase() : e.key
    const fn = KEYS[k] || (e.shiftKey && KEYS[e.key])
    if (!fn) return
    e.preventDefault()
    e.stopPropagation()
    fn()
  }, true)

  document.addEventListener('click', e => {
    const a = e.target.closest?.('a[href]')
    if (!a || e.defaultPrevented) return
    if (/^https?:\/\//.test(a.href)) { e.preventDefault(); call('openExternal')(a.href) }
  })
  const open = window.open
  window.open = (url, ...rest) => /^https?:\/\//.test(url || '') ? (call('openExternal')(url), null) : open.call(window, url, ...rest)

  const own = {
    shared: boot.shared ?? null,
    pathFor: f => paths.get(f) || '',
    find,
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(fn) },
  }
  window.api = new Proxy(own, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? (t[k] = call(k)) : undefined) })
})()

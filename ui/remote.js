const api = (() => {
  const boot = window.__codedesk || {}
  const prev = sessionStorage.getItem('cdPage')
  const page = crypto.randomUUID()
  sessionStorage.setItem('cdPage', page)
  document.documentElement.dataset.remote = ''

  const headers = { 'content-type': 'application/json', 'x-codedesk': '1', 'x-codedesk-page': page }
  const call = ch => async (...args) => {
    const r = await fetch('/api/' + ch, { method: 'POST', headers, body: JSON.stringify(args) })
    if (r.status === 401) { location.href = '/pair'; return new Promise(() => {}) }
    const j = await r.json().catch(() => ({ error: 'HTTP ' + r.status }))
    if ('error' in j) throw new Error(j.error)
    return j.ok
  }

  const listeners = new Map()
  const events = new EventSource(`/events?page=${page}${prev ? '&prev=' + prev : ''}`)
  events.onmessage = e => {
    const { ch, d } = JSON.parse(e.data)
    if (ch === 'remote:resync') return location.reload()
    listeners.get(ch)?.forEach(fn => fn(d))
  }
  events.onerror = () => { if (events.readyState === 2) setTimeout(() => location.reload(), 2000) }

  const PC_ONLY = 'Add accounts on the PC: Claude sign-in opens a browser there.'
  const authCall = call('cli')
  const own = {
    shared: boot.shared ?? null,
    cli: async args => {
      if (/^(auth|mcp)$/.test(args[0]) && /^log(in|out)$/.test(args[1])) {
        window.dispatchEvent(new CustomEvent('pc-only'))
        return { code: 1, stdout: '', stderr: PC_ONLY }
      }
      return authCall(args)
    },
    pathFor: () => '',
    find: async () => {},
    addAccount: async () => ({ error: PC_ONLY }),
    openExternal: url => { if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener') },
    pickFolder: () => App.browseFolder(),
    saveFile: async (name, content) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }))
      a.download = name
      a.click()
      URL.revokeObjectURL(a.href)
      return true
    },
    on: (ch, fn) => { if (!listeners.has(ch)) listeners.set(ch, []); listeners.get(ch).push(fn) },
  }
  return new Proxy(own, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? (t[k] = call(k)) : undefined) })
})()
window.api = api

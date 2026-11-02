import { homedir } from 'node:os'
import path from 'node:path'

export const LOCAL_PORT = 8931
export const isLocal = m => /^local:/.test(m || '')
export const localId = m => String(m).slice(6)

export function modelSource(src) {
  const s = String(src || '').trim()
  if (!s) throw new Error('Choose a model to host in Settings → Local model')
  if (/^[~/.]/.test(s) || /^[a-z]:\\/i.test(s)) {
    const file = s.startsWith('~') ? path.join(homedir(), s.slice(1)) : path.resolve(s)
    return { args: ['-m', file], alias: path.basename(file).replace(/\.gguf$/i, '') }
  }
  const file = s.match(/^([\w.-]+\/[\w.-]+)\/([^:]+\.gguf)$/i)
  if (file) return { args: ['-hf', file[1], '-hff', file[2]], alias: path.basename(file[2]).replace(/\.gguf$/i, '') }
  if (!/^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/.test(s)) throw new Error(`Not a model file or Hugging Face repo: ${s}`)
  const [repo, quant] = s.split(':')
  return { args: ['-hf', s], alias: repo.split('/')[1].replace(/-GGUF$/i, '') + (quant ? '-' + quant : '') }
}

export function serverArgs(cfg, { port = LOCAL_PORT, key }) {
  const { args, alias } = modelSource(cfg.source)
  const ctx = Number.isInteger(+cfg.ctx) && +cfg.ctx > 0 ? ['-c', String(+cfg.ctx)] : ['-fitc', '32768']
  return [
    ...args, '--alias', alias, '--host', '127.0.0.1', '--port', String(port), '--api-key', key,
    ...ctx, '-np', '1', '--no-mmproj-offload', '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0', '--jinja', '--cache-reuse', '256',
    ...(/mtp/i.test(alias) ? ['--spec-type', 'draft-mtp'] : []),
    ...String(cfg.args || '').split(/\s+/).filter(Boolean),
  ]
}

export function localEnv({ url, key }, model, ctx) {
  return {
    ANTHROPIC_BASE_URL: url.replace(/\/+$/, ''),
    ANTHROPIC_AUTH_TOKEN: key || 'local',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '0',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_TOOL_SEARCH: 'true',
    API_TIMEOUT_MS: '1800000',
    ...(+ctx > 0 && { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(+ctx) }),
  }
}

const loaded = b => b.type === 'tool_reference' ? { type: 'text', text: `Tool loaded: ${b.tool_name}` } : b
const unref = b => b.type === 'tool_result' && Array.isArray(b.content) ? { ...b, content: b.content.map(loaded) } : b

export function forLlama(messages) {
  const out = [], pending = []
  const blocks = c => typeof c === 'string' ? [{ type: 'text', text: c }] : c || []
  for (let m of messages || []) {
    if (Array.isArray(m.content)) m = { ...m, content: m.content.map(unref) }
    if (m.role === 'system') {
      const text = blocks(m.content).map(b => b.text || '').join('\n')
      const block = { type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }
      if (out.at(-1)?.role === 'user') out.at(-1).content = [...blocks(out.at(-1).content), block]
      else pending.push(block)
      continue
    }
    out.push(m.role === 'user' && pending.length ? { ...m, content: [...blocks(m.content), ...pending.splice(0)] } : m)
  }
  if (pending.length) out.push({ role: 'user', content: pending })
  return out
}

export const parseModels = (data, where) => (data?.data || data?.models || [])
  .map(m => m.id || m.name || m.model).filter(Boolean)
  .map(id => ({ value: 'local:' + id, displayName: id, description: `${id} · ${where}`, supportsEffort: false }))

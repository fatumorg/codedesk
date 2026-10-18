const MODES = {
  auto: ['--mode', 'auto'],
  acceptEdits: ['--mode', 'accept-edits'],
  default: ['--mode', 'accept-edits'],
  plan: ['--mode', 'plan'],
  bypassPermissions: ['--dangerously-skip-permissions'],
}

export const agyArgs = ({ prompt, model, permissionMode, conversationId }) => [
  `--prompt=${prompt}`, '--output-format', 'stream-json',
  ...(model ? ['--model', model] : []),
  ...(MODES[permissionMode] || MODES.default),
  ...(conversationId ? ['--conversation', conversationId] : []),
]

export const parseAgyModels = stdout => {
  const seen = new Set()
  const models = []
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(gemini-[\w.-]+)\t(.+)$/)
    if (!m || seen.has(m[1])) continue
    seen.add(m[1])
    models.push({ value: m[1], displayName: m[2], description: `${m[2]} · Antigravity`, supportsFastMode: false, supportsEffort: false })
  }
  return models
}

export const parseLine = line => { try { return JSON.parse(line) } catch { return null } }

export const newTurnState = (conversationId, tokens) => ({ text: '', streaming: false, conversationId, tokens, error: null })

const streamEvent = event => ({ type: 'stream_event', event })
const assistant = content => ({ type: 'assistant', uuid: crypto.randomUUID(), message: { content } })

export function finishTurn(st) {
  const text = st.text.trim()
  st.text = ''
  st.streaming = false
  return text ? [assistant([{ type: 'text', text }])] : []
}

function translateStep(u, st) {
  const id = `${u.conversation_id || st.conversationId}:${u.step_index}`
  if (u.step_type === 'agent_response') {
    const out = []
    if (u.text_delta && (st.streaming || u.text_delta.trim())) {
      if (!st.streaming) out.push(streamEvent({ type: 'message_start' }), streamEvent({ type: 'content_block_start', content_block: { type: 'text' } }))
      st.streaming = true
      st.text += u.text_delta
      out.push(streamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: u.text_delta } }))
    }
    if (u.state === 'DONE') {
      if (u.usage) st.tokens = u.usage.input_tokens + u.usage.output_tokens
      out.push(...finishTurn(st))
    }
    return out
  }
  if (u.step_type !== 'tool') return []
  if (u.state === 'ACTIVE') return [...finishTurn(st), assistant([{ type: 'tool_use', id, name: u.tool_name, input: u.tool_info?.parameters || {} }])]
  if (u.state === 'DONE') return [{ type: 'user', uuid: crypto.randomUUID(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: String(u.tool_info?.output ?? ''), is_error: false }] } }]
  return []
}

export function translateAgyEvent(ev, st) {
  switch (ev?.event) {
    case 'init':
      st.conversationId = ev.conversation_id || st.conversationId
      return []
    case 'step_update':
      return translateStep(ev.step_update, st)
    case 'result': {
      const r = ev.result
      st.conversationId = r.conversation_id || st.conversationId
      if (r.status !== 'SUCCESS') st.error ||= r.error || r.status
      return [...finishTurn(st), ...(r.denied_actions || []).map(d => ({ type: 'system', subtype: 'permission_denied', tool_name: d.display_name || d.action }))]
    }
    default:
      return []
  }
}

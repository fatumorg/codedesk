import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { forLlama, isLocal, localEnv, localId, modelSource, parseModels, serverArgs } from '../local.mjs'

test('model sources map to llama.cpp download or file flags', () => {
  assert.deepEqual(modelSource('ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF/Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf'),
    { args: ['-hf', 'ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF', '-hff', 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf'], alias: 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp' })
  assert.deepEqual(modelSource('unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL'), { args: ['-hf', 'unsloth/Qwen3.6-35B-A3B-GGUF:UD-Q4_K_XL'], alias: 'Qwen3.6-35B-A3B-UD-Q4_K_XL' })
  assert.deepEqual(modelSource('~/models/a.gguf'), { args: ['-m', homedir() + '/models/a.gguf'], alias: 'a' })
  assert.throws(() => modelSource(''))
  assert.throws(() => modelSource('--log-file /tmp/x'))
})

test('server args keep the key, bind to localhost and add MTP only for MTP models', () => {
  const a = serverArgs({ source: 'org/r-GGUF/m-mtp.gguf', ctx: 32768, args: ' --spec-type  ngram-mod ' }, { key: 'k' })
  assert.equal(a[a.indexOf('--api-key') + 1], 'k')
  assert.equal(a[a.indexOf('--host') + 1], '127.0.0.1')
  assert.equal(a[a.indexOf('-c') + 1], '32768')
  assert.equal(a[a.indexOf('-np') + 1], '1')
  assert.ok(a.includes('draft-mtp'))
  assert.deepEqual(a.slice(-2), ['--spec-type', 'ngram-mod'])
  const b = serverArgs({ source: 'org/r:Q4', ctx: 'x' }, { key: 'k' })
  assert.ok(!b.includes('-c'))
  assert.equal(b[b.indexOf('-fitc') + 1], '32768')
  assert.ok(!b.includes('draft-mtp'))
})

test('local env routes every Claude Code model slot to the local model', () => {
  const e = localEnv({ url: 'http://h:1/', key: '' }, 'm', 65536)
  assert.equal(e.ANTHROPIC_BASE_URL, 'http://h:1')
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, 'local')
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(e[k], 'm')
  assert.equal(e.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '65536')
  assert.equal(e.ENABLE_TOOL_SEARCH, 'true')
  assert.equal(localEnv({ url: 'http://h' }, 'm', 0).CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined)
})

test('model lists from llama.cpp, Ollama and LM Studio become local: values', () => {
  assert.deepEqual(parseModels({ data: [{ id: 'a' }, { id: 'b' }] }, 'Local').map(m => m.value), ['local:a', 'local:b'])
  assert.deepEqual(parseModels({ models: [{ name: 'qwen' }] }, 'Local').map(m => m.value), ['local:qwen'])
  assert.deepEqual(parseModels(null, 'Local'), [])
  assert.ok(isLocal('local:a') && !isLocal('opus') && localId('local:a/b:c') === 'a/b:c')
})

test('mid-conversation system messages fold into user turns so strict chat templates accept them', () => {
  const r = s => `<system-reminder>\n${s}\n</system-reminder>`
  assert.deepEqual(forLlama([{ role: 'user', content: 'hi' }, { role: 'system', content: 'hook' }]),
    [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: r('hook') }] }])
  assert.deepEqual(forLlama([
    { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'system', content: [{ type: 'text', text: 'x' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  ]).map(m => [m.role, (Array.isArray(m.content) ? m.content : [m.content]).map(b => b.type || 'str').join('+')]),
  [['user', 'str'], ['assistant', 'str'], ['user', 'tool_result+text']])
  assert.deepEqual(forLlama([{ role: 'assistant', content: 'b' }, { role: 'system', content: 'x' }]).at(-1), { role: 'user', content: [{ type: 'text', text: r('x') }] })
  assert.deepEqual(forLlama(undefined), [])
})

test('tool search results become text so llama.cpp templates accept them', () => {
  const [m] = forLlama([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'tool_reference', tool_name: 'mcp__x__y' }] }] }])
  assert.deepEqual(m.content[0].content, [{ type: 'text', text: 'Tool loaded: mcp__x__y' }])
})

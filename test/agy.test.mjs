import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agyArgs, finishTurn, newTurnState, parseAgyModels, parseLine, translateAgyEvent } from '../agy.mjs'

const fixture = readFileSync(new URL('./fixtures/agy-stream.ndjson', import.meta.url), 'utf8').split('\n')
const runFixture = () => {
  const st = newTurnState(null, 0)
  const out = fixture.flatMap(l => translateAgyEvent(parseLine(l), st))
  return { st, out: [...out, ...finishTurn(st)] }
}
const blocks = (out, type) => out.filter(m => m.type === type).flatMap(m => m.message.content)

test('fixture yields conversation id, context tokens and no error', () => {
  const { st } = runFixture()
  assert.equal(st.conversationId, 'conv-1')
  assert.equal(st.tokens, 14069)
  assert.equal(st.error, null)
})

test('text streams as deltas and lands in one assistant message', () => {
  const { out } = runFixture()
  const deltas = out.filter(m => m.event?.type === 'content_block_delta').map(m => m.event.delta.text).join('')
  assert.equal(deltas, 'Version set to 0.2.0.\n')
  assert.equal(out.filter(m => m.event?.type === 'message_start').length, 1)
  assert.deepEqual(blocks(out, 'assistant').filter(b => b.type === 'text').map(b => b.text), ['Version set to 0.2.0.'])
})

test('every tool step becomes a tool_use then a matching tool_result', () => {
  const { out } = runFixture()
  const uses = blocks(out, 'assistant').filter(b => b.type === 'tool_use')
  const results = blocks(out, 'user')
  assert.deepEqual(uses.map(u => [u.id, u.name]), [['conv-1:2', 'view_file'], ['conv-1:4', 'replace_file_content'], ['conv-1:5', 'run_command']])
  assert.deepEqual(uses[2].input, { CommandLine: 'ls -la' })
  assert.deepEqual(results.map(r => [r.tool_use_id, r.content, r.is_error]), [['conv-1:2', '2 lines, 20 bytes', false], ['conv-1:4', '', false], ['conv-1:5', '', false]])
  assert.ok(out.filter(m => m.type === 'assistant' || m.type === 'user').every(m => m.uuid))
})

test('denied actions surface as permission_denied notices', () => {
  const { out } = runFixture()
  assert.deepEqual(out.filter(m => m.type === 'system'), [{ type: 'system', subtype: 'permission_denied', tool_name: 'RunCommand' }])
})

test('unknown events, garbage lines and echoes produce nothing', () => {
  const st = newTurnState(null, 0)
  assert.deepEqual(translateAgyEvent({ event: 'heartbeat' }, st), [])
  assert.deepEqual(translateAgyEvent(parseLine('not json'), st), [])
  assert.deepEqual(translateAgyEvent(null, st), [])
  assert.deepEqual(translateAgyEvent({ event: 'step_update', step_update: { step_type: 'user_input', state: 'DONE', step_index: 0 } }, st), [])
  assert.deepEqual(translateAgyEvent({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', step_index: 1, text_delta: '\n' } }, st), [])
})

test('finishTurn flushes partial text once', () => {
  const st = newTurnState('c', 0)
  translateAgyEvent({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', step_index: 1, text_delta: 'partial' } }, st)
  assert.deepEqual(finishTurn(st).map(m => m.message.content[0].text), ['partial'])
  assert.deepEqual(finishTurn(st), [])
})

test('error result sets st.error, success does not', () => {
  const st = newTurnState(null, 0)
  translateAgyEvent({ event: 'result', result: { status: 'SUCCESS', response: '' } }, st)
  assert.equal(st.error, null)
  translateAgyEvent({ event: 'result', result: { status: 'ERROR', error: 'invalid model selection' } }, st)
  assert.equal(st.error, 'invalid model selection')
})

test('agyArgs maps permission modes and resume', () => {
  const base = { prompt: 'hi', model: 'gemini-3.8-flash-high' }
  assert.deepEqual(agyArgs({ ...base, permissionMode: 'auto' }), ['--prompt=hi', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-high', '--mode', 'auto'])
  assert.deepEqual(agyArgs({ ...base, permissionMode: 'default' }).slice(-2), ['--mode', 'accept-edits'])
  assert.deepEqual(agyArgs({ ...base, permissionMode: 'acceptEdits' }).slice(-2), ['--mode', 'accept-edits'])
  assert.deepEqual(agyArgs({ ...base, permissionMode: 'plan' }).slice(-2), ['--mode', 'plan'])
  assert.deepEqual(agyArgs({ ...base, permissionMode: 'bypassPermissions' }).slice(-1), ['--dangerously-skip-permissions'])
  assert.deepEqual(agyArgs({ ...base, permissionMode: 'weird' }).slice(-2), ['--mode', 'accept-edits'])
  assert.deepEqual(agyArgs({ ...base, conversationId: 'c1' }).slice(-2), ['--conversation', 'c1'])
  assert.equal(agyArgs({ prompt: '--help -rf' })[0], '--prompt=--help -rf')
  assert.ok(!agyArgs({ prompt: 'x' }).includes('--model'))
})

test('parseAgyModels keeps unique gemini models with display names', () => {
  const out = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high\tdup\n'
  const models = parseAgyModels(out)
  assert.deepEqual(models.map(m => m.value), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'])
  assert.equal(models[0].displayName, 'Gemini 3.8 Flash (High)')
  assert.equal(models[0].description, 'Gemini 3.8 Flash (High) · Antigravity')
  assert.equal(models[0].supportsEffort, false)
  assert.deepEqual(parseAgyModels('Error: Please sign in to view available models.'), [])
})

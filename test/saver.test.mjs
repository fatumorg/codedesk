import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const ctx = vm.createContext({})
vm.runInContext(readFileSync(new URL('../ui/saver.js', import.meta.url), 'utf8') + ';this.routeModel = routeModel; this.limitedUntil = limitedUntil; this.pickAccount = pickAccount', ctx)

const settings = {
  defaultModel: 'opus', saverOtherModel: 'sonnet',
  saverQuickWords: 'explain, what is, rename, typo', saverQuickModel: 'haiku',
  saverHeavyWords: 'design, debug, refactor', saverHeavyModel: 'opus',
}
const route = (text, o = {}) => ctx.routeModel(text, { settings, ...o })

test('quick prompt goes to the quick model', () => assert.deepEqual({ ...route('explain this function') }, { model: 'haiku', reason: 'quick task' }))
test('heavy words win over quick words', () => assert.equal(route('explain the design of the cache').model, 'opus'))
test('unmatched prompt uses the other model', () => assert.equal(route('add a dark mode toggle').model, 'sonnet'))
test('whole words only: "designer" is not "design"', () => assert.equal(route('ask the designer').model, 'sonnet'))
test('slash command keeps the default model', () => assert.equal(route('/superpowers:brainstorming add a login page').reason, 'skill or command'))
test('plugin:skill token keeps the default model', () => assert.equal(route('run superpowers:writing-plans on this').model, 'opus'))
test('the word skill keeps the default model', () => assert.equal(route('use tasteskill for the page').model, 'opus'))
test('known skill name keeps the default model', () => assert.equal(route('use ponytail for this', { skills: ['ponytail:ponytail'] }).model, 'opus'))
test('attachments keep the default model', () => assert.equal(route('explain this', { attachments: true }).model, 'opus'))
test('plan mode keeps the default model', () => assert.equal(route('explain this', { mode: 'plan' }).model, 'opus'))
test('long prompts keep the default model', () => assert.equal(route('explain ' + 'x'.repeat(1600)).reason, 'long prompt'))
test('long quick-looking prompts fall to the other model', () => assert.equal(route('explain ' + 'x'.repeat(400)).model, 'sonnet'))
test('haiku is raised to sonnet when skills are installed', () => assert.equal(route('rename this variable', { skills: ['foo-bar'] }).model, 'sonnet'))

const T = Date.parse('2026-10-26T12:00:00Z'), H = 3600e3
const use = (pct, resetH, extra = {}) => ({ rate_limits: { five_hour: { utilization: pct, resets_at: new Date(T + resetH * H).toISOString() }, ...extra } })

test('limitedUntil: unknown, room, latest full window', () => {
  assert.equal(ctx.limitedUntil(null), null)
  assert.equal(ctx.limitedUntil(use(40, 2)), 0)
  assert.equal(ctx.limitedUntil(use(100, 2, { seven_day: { utilization: 100, resets_at: new Date(T + 30 * H).toISOString() } })), T + 30 * H)
  assert.equal(ctx.limitedUntil({ rate_limits: { model_scoped: [{ utilization: 100, resets_at: new Date(T + H).toISOString() }] } }), T + H)
})
test('pickAccount moves to the account with room and the lowest session use', () =>
  assert.deepEqual({ ...ctx.pickAccount('a', [{ id: 'a', u: use(100, 5) }, { id: 'b', u: use(70, 1) }, { id: 'c', u: use(20, 1) }], T) }, { id: 'c', at: 0 }))
test('pickAccount picks the account that resets first when all are full', () =>
  assert.deepEqual({ ...ctx.pickAccount('a', [{ id: 'a', u: use(100, 5) }, { id: 'b', u: use(100, 3) }], T) }, { id: 'b', at: T + 3 * H }))
test('pickAccount stays when the current account resets first or ties', () => {
  assert.equal(ctx.pickAccount('a', [{ id: 'a', u: use(100, 2) }, { id: 'b', u: use(100, 3) }], T), null)
  assert.equal(ctx.pickAccount('a', [{ id: 'a', u: use(100, 3) }, { id: 'b', u: use(100, 3) }], T), null)
})
test('pickAccount ignores accounts with unknown usage', () =>
  assert.equal(ctx.pickAccount('a', [{ id: 'a', u: use(100, 2) }, { id: 'b', u: null }], T), null))

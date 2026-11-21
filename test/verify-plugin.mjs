// Integration-style test of the real forever-midnight apply() handler.
import { apply, name } from '../index.js'

let createdHandler = null
let disposedHandler = null
const rootCtx = {
  on(event, handler) {
    if (event === 'agent/created') createdHandler = handler
    if (event === 'agent/disposed') disposedHandler = handler
    return () => {}
  },
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') this._cleanup = cleanup
    return () => {}
  },
}

apply(rootCtx, { targetHour: 3 })

if (!createdHandler) throw new Error('agent/created handler was not registered')

// Simulate an agent with its own scoped ctx capturing the pre-step listener.
let preStepHandler = null
const agent = {
  ctx: {
    on(event, handler, options) {
      if (event === 'agent/pre-step') {
        preStepHandler = { handler, options }
      }
      return () => {}
    },
  },
}

createdHandler({ agent, source: 'startup' })

if (!preStepHandler) throw new Error('agent/pre-step handler was not registered on agent.ctx')
if (preStepHandler.options?.prepend !== true) throw new Error('pre-step listener is not outermost (prepend)')

// The decision as it looks AFTER the built-in time-context plugin appended its msg.
const timeText = 'Time sampled while preparing turn 7, step 1: 2026-11-18T23:20:35+08:00[Asia/Shanghai]\n'
  + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n'
  + 'Elapsed since the preceding model-visible message: 12s.'
const userMsg = {
  role: 'user',
  id: 'u1',
  content: [{ type: 'text', text: timeText }],
  source: { kind: 'user', rpcId: 'r1' },
}
const tcMsg = {
  role: 'user',
  id: 'tc1',
  content: [{ type: 'text', text: timeText }],
  source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: timeText }] },
}
const decision = { kind: 'enter', messages: [userMsg, tcMsg], startsRequestSeries: true }

// Downstream `next()` returns the decision with time-context appended.
const next = async () => decision
const result = await preStepHandler.handler({ agent, turn: 7, step: 1, signal: { aborted: false } }, next)

const outTc = result.messages[1]
const outUser = result.messages[0]
const outText = outTc.content[0].text
const outSection = outTc.source.sections[0].text

function assert(cond, msg) { if (!cond) throw new Error(msg) }

assert(result.kind === 'enter', 'decision kind changed')
assert(result.startsRequestSeries === true, 'startsRequestSeries lost')
assert(outUser === userMsg, 'ordinary user message was touched')
assert(outText === outSection, 'content and source.sections diverged')
assert(/^Time sampled while preparing turn 7, step 1: \d{4}-\d{2}-\d{2}T03:/.test(outText), 'hour is not 03: ' + outText)
assert(outText.includes('[Etc/GMT'), 'zone is not a fixed-offset IANA zone: ' + outText)
assert(outText.includes('Browser time zone for this request: Asia/Shanghai.'), 'browser zone line was altered')
assert(outText.includes('Elapsed since the preceding model-visible message: 12s.'), 'elapsed line was altered')
assert(outTc.source.kind === 'time-context' && outTc.source.form === 'snapshot', 'source metadata changed')

// Guard: a non-time-context decision passes through untouched (identity).
const plain = { kind: 'enter', messages: [userMsg] }
const plainResult = await preStepHandler.handler({ agent, turn: 7, step: 2, signal: { aborted: false } }, async () => plain)
assert(plainResult === plain, 'unchanged decision should be returned by identity')

// Guard: rejected decisions pass through.
const rej = { kind: 'reject' }
const rejResult = await preStepHandler.handler({ agent, turn: 7, step: 1, signal: { aborted: false } }, async () => rej)
assert(rejResult === rej, 'reject decision should pass through')

console.log('ALL CHECKS PASSED')
console.log('rewritten first line:', outText.split('\n')[0])

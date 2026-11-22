/**
 * 两个核心问题的验证：
 *
 *   1. **会话模型与 subagent 模型不同**时，配额算到谁头上？
 *   2. 模型**指定 subagent 模型**（`dsh-tool-subagent` 的 `modelSelection`）时，
 *      是否按被指定的模型计？
 *
 * 外加：新旧两种 `limits` 写法、四级匹配优先级。
 *
 * 运行：`node --test test/model-resolution.test.mjs`（零依赖，不需要 DSH 在场）
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveModel, capFor, normalizeLimits } from '../lib/index.js'

/** 造一个最小的 exec：agent.model.current() 返回父会话模型。 */
function execOf({ args = {}, parent = null } = {}) {
  return {
    name: 'subagent',
    arguments: args,
    agent:
      parent === null
        ? undefined
        : {
            id: 'parent-agent',
            session: { id: 'session-1' },
            model: { current: () => parent },
          },
  }
}

const PARENT = { provider: 'as-one', model: 'auto' }

/* ------------------------------------------------ 1. 会话模型 vs 子代理模型 */

test('未指定 model 时：按父会话当前模型计（as-one/auto）', () => {
  const r = resolveModel(execOf({ parent: PARENT }))
  assert.equal(r.key, 'as-one/auto')
  assert.equal(r.source, 'agent.model')
})

test('指定了不同的 model 时：按被指定的模型计，**不是**父会话模型', () => {
  const r = resolveModel(
    execOf({ args: { provider: 'as-one', model: 'glm-5.3-flash' }, parent: PARENT }),
  )
  assert.equal(r.key, 'as-one/glm-5.3-flash')
  assert.equal(r.model, 'glm-5.3-flash')
  assert.equal(r.source, 'arguments')
  assert.notEqual(r.key, 'as-one/auto', '不能落回父会话模型')
})

test('只给 model 不给 provider：键退化成裸模型名，仍按该模型计', () => {
  const r = resolveModel(execOf({ args: { model: 'hy4flash-free' }, parent: PARENT }))
  assert.equal(r.key, 'hy4flash-free')
  assert.equal(r.provider, undefined)
  assert.equal(r.model, 'hy4flash-free')
})

test('参数里的 model 优先于父会话模型（即使父会话模型能拿到）', () => {
  const withArgs = resolveModel(execOf({ args: { provider: 'as-one', model: 'minimax-flash' }, parent: PARENT }))
  const withoutArgs = resolveModel(execOf({ parent: PARENT }))
  assert.notEqual(withArgs.key, withoutArgs.key)
  assert.equal(withArgs.key, 'as-one/minimax-flash')
})

test('父会话拿不到模型（model.current() 返回 undefined）→ 兜底 *', () => {
  const r = resolveModel(execOf({ parent: undefined }))
  assert.equal(r.key, '*')
  assert.equal(r.source, 'fallback')
})

test('model.current() 抛错时不崩，退回兜底键', () => {
  const exec = {
    arguments: {},
    agent: { model: { current: () => { throw new Error('boom') } } },
  }
  const r = resolveModel(exec)
  assert.equal(r.key, '*')
})

/* --------------------------------------------------------- 2. limits 写法 */

test('旧写法（对象，provider/model 键）与裸模型名、* 都能解析', () => {
  const rules = normalizeLimits({
    'as-one/auto': 2,
    'as-one/glm-5.3-flash': 1,
    'hy4flash-free': 3,
    '*': 8,
  })
  assert.deepEqual(rules, [
    { provider: 'as-one', model: 'auto', max: 2 },
    { provider: 'as-one', model: 'glm-5.3-flash', max: 1 },
    { provider: '*', model: 'hy4flash-free', max: 3 },
    { provider: '*', model: '*', max: 8 },
  ])
})

test('新写法（数组，设置页产生的形状）原样接受', () => {
  const rules = normalizeLimits([
    { provider: 'as-one', model: 'auto', max: 2 },
    { provider: '*', model: '*', max: 4 },
  ])
  assert.deepEqual(rules, [
    { provider: 'as-one', model: 'auto', max: 2 },
    { provider: '*', model: '*', max: 4 },
  ])
})

test('非法 max 抛错', () => {
  assert.throws(() => normalizeLimits([{ provider: 'a', model: 'b', max: 0 }]), /正整数/)
  assert.throws(() => normalizeLimits({ 'a/b': -1 }), /正整数/)
})

/* ------------------------------------------------------- 3. 配额匹配顺序 */

const cfg = {
  defaultLimit: 9,
  limits: normalizeLimits([
    { provider: 'as-one', model: 'auto', max: 2 },
    { provider: 'as-one', model: '*', max: 5 },
    { provider: '*', model: 'glm-5.3-flash', max: 7 },
    { provider: '*', model: '*', max: 8 },
  ]),
}

test('1) provider+model 精确最优先', () => {
  assert.equal(capFor(cfg, { key: 'as-one/auto', provider: 'as-one', model: 'auto' }), 2)
})

test('2) provider/* 次之', () => {
  assert.equal(capFor(cfg, { key: 'as-one/other', provider: 'as-one', model: 'other' }), 5)
})

test('3) */model 再次', () => {
  assert.equal(capFor(cfg, { key: 'acme/glm-5.3-flash', provider: 'acme', model: 'glm-5.3-flash' }), 7)
})

test('4) */* 兜底', () => {
  assert.equal(capFor(cfg, { key: 'acme/unknown', provider: 'acme', model: 'unknown' }), 8)
})

test('没有命中任何规则时用 defaultLimit', () => {
  const bare = { defaultLimit: 6, limits: normalizeLimits([{ provider: 'x', model: 'y', max: 1 }]) }
  assert.equal(capFor(bare, { key: 'p/q', provider: 'p', model: 'q' }), 6)
})

test('provider 为 undefined 时按 * 匹配（裸模型名场景）', () => {
  const bare = { defaultLimit: 4, limits: normalizeLimits([{ provider: '*', model: 'hy4flash-free', max: 3 }]) }
  assert.equal(capFor(bare, { key: 'hy4flash-free', provider: undefined, model: 'hy4flash-free' }), 3)
})

/* --------------------------------- 4. 端到端：同一会话里两种调用拿不同配额 */

test('端到端：父会话 auto(上限2) 与指定 glm(上限1) 各自独立计数', () => {
  const local = {
    defaultLimit: 4,
    limits: normalizeLimits({ 'as-one/auto': 2, 'as-one/glm-5.3-flash': 1 }),
  }
  const cases = [
    { args: {}, parent: PARENT },
    { args: { provider: 'as-one', model: 'glm-5.3-flash' }, parent: PARENT },
  ]
  const resolved = cases.map((c) => resolveModel(execOf(c)))
  const caps = resolved.map((r) => capFor(local, r))

  assert.deepEqual(
    resolved.map((r) => r.key),
    ['as-one/auto', 'as-one/glm-5.3-flash'],
  )
  assert.deepEqual(caps, [2, 1], '两个模型的配额必须不同且各自生效')
})

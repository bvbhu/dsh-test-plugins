/**
 * dsh-subagent-model-limit —— 按模型限制 DeepSeek Harness 的 subagent 并发数。
 *
 * 与 `dsh-subagent-concurrency-limit`（进程级单一上限）的区别：它的上限是
 * **一个数字**，本插件的上限是**每个模型一个**。同一个 Harness 里 `auto` 可能便宜、
 * `glm-5.3` 很贵，两者该有不同配额。
 *
 * 模型归属的解析顺序（第一个命中的生效）：
 *   1. subagent 工具参数里的 `provider` + `model`（工具开启 `modelSelection` 时）；
 *   2. 父会话当前模型 `exec.agent.model.current()`（默认走这条）；
 *   3. 兜底键 `*`。
 *
 * 配额匹配顺序见 {@link capFor}：`provider/model` → `provider/*` → `* / model` → `* / *`。
 *
 * 两种计数对象：
 *   - **subagent**：走 `tools/execute` 拦截，超限即拒绝；
 *   - **主 agent**（`countMainAgent`）：走 `agent/status` 只计数、**永不拦截**，
 *     让主会话占用模型时也吃掉一份配额。
 *
 * @module dsh-subagent-model-limit
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'subagent-model-limit'
export const inject = ['tools']

const FALLBACK_KEY = '*'

/** 默认配置。 */
const DEFAULTS = {
  defaultLimit: 4,
  limits: [],
  countMainAgent: false,
  subagentToolNames: ['subagent', 'subagent_fork'],
  queueTimeoutMs: 0,
}

/* ------------------------------------------------------------ 运行时配置 */

/**
 * 设置页保存的运行时覆盖（`~/.dsh/subagent-model-limit/config.json`）。
 *
 * 为什么要有它：`cordis.patch.yml` 是**用户的**配置文件，插件不该去改写它
 *（DSH 的 `configEditor` 能做，但它会重启插件、且不适合高频表单编辑）。
 * 因此设置页写自己的小文件，host 侧读它覆盖 Config 里的同名字段。
 */
export function runtimeConfigPath(home = homedir()) {
  return join(home, '.dsh', 'subagent-model-limit', 'config.json')
}

/** 读取运行时覆盖；文件不存在或损坏时返回 `{}`（不抛）。 */
export function readRuntimeConfig(home = homedir()) {
  try {
    const raw = readFileSync(runtimeConfigPath(home), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** 写入运行时覆盖；失败时抛（调用方负责回给 UI）。 */
export function writeRuntimeConfig(patch, home = homedir()) {
  const path = runtimeConfigPath(home)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(patch, null, 2)}\n`, 'utf8')
  return path
}

/* ---------------------------------------------------------------- 配置 */

function isPosInt(value) {
  return Number.isSafeInteger(value) && value >= 1
}

/**
 * 规范化配额表。两种输入都接受：
 *   - 新格式（设置页写的）：`[{ provider, model, max }]`，provider/model 可为 `*`；
 *   - 旧格式（手写 yml 方便）：`{ "as-one/auto": 2, "as-one/*": 3, "*": 4 }`。
 * @returns {{ provider: string, model: string, max: number }[]}
 */
export function normalizeLimits(raw) {
  const out = []
  if (raw === undefined || raw === null) return out

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue
      const provider = typeof entry.provider === 'string' && entry.provider !== '' ? entry.provider : FALLBACK_KEY
      const model = typeof entry.model === 'string' && entry.model !== '' ? entry.model : FALLBACK_KEY
      const max = typeof entry.max === 'string' ? Number(entry.max) : entry.max
      if (!isPosInt(max)) {
        throw new TypeError(`dsh-subagent-model-limit: limits entry ${provider}/${model} 的 max 必须是正整数`)
      }
      out.push({ provider, model, max })
    }
    return out
  }

  if (typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      const n = typeof value === 'string' ? Number(value) : value
      if (!isPosInt(n)) {
        throw new TypeError(`dsh-subagent-model-limit: limits["${key}"] 必须是正整数`)
      }
      const slash = key.indexOf('/')
      if (key === FALLBACK_KEY) {
        out.push({ provider: FALLBACK_KEY, model: FALLBACK_KEY, max: n })
      } else if (slash < 0) {
        // 裸模型名：任意 provider 下匹配
        out.push({ provider: FALLBACK_KEY, model: key, max: n })
      } else {
        out.push({ provider: key.slice(0, slash) || FALLBACK_KEY, model: key.slice(slash + 1) || FALLBACK_KEY, max: n })
      }
    }
    return out
  }

  throw new TypeError('dsh-subagent-model-limit: limits 必须是数组或对象')
}

function resolveConfig(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const overlay = readRuntimeConfig()

  const defaultLimit = overlay.defaultLimit ?? cfg.defaultLimit ?? DEFAULTS.defaultLimit
  if (!isPosInt(defaultLimit)) {
    throw new TypeError('dsh-subagent-model-limit: defaultLimit 必须是正整数')
  }

  const countMainAgent = typeof overlay.countMainAgent === 'boolean'
    ? overlay.countMainAgent
    : cfg.countMainAgent === true

  const queueTimeoutMs = cfg.queueTimeoutMs ?? DEFAULTS.queueTimeoutMs
  if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 0) {
    throw new TypeError('dsh-subagent-model-limit: queueTimeoutMs 必须是非负整数')
  }

  const names = cfg.subagentToolNames ?? DEFAULTS.subagentToolNames
  if (!Array.isArray(names) || names.length === 0 || names.some((n) => typeof n !== 'string' || n === '')) {
    throw new TypeError('dsh-subagent-model-limit: subagentToolNames 至少要有一个非空字符串')
  }

  const limits = normalizeLimits(overlay.limits ?? cfg.limits)

  return { defaultLimit, countMainAgent, queueTimeoutMs, toolNames: new Set(names), limits }
}

/* ------------------------------------------------------------ 模型解析 */

/**
 * 解析这次调用会落在哪个模型上。
 *
 * 解析顺序（第一个命中的生效）：
 *   1. 工具参数 `provider`/`model` —— 只有 `dsh-tool-subagent` 开启 `modelSelection` 才会带；
 *   2. 父会话当前模型 `exec.agent.model.current()` —— 默认走这条；
 *   3. 兜底键 `*`。
 *
 * @internal 导出仅供测试。
 * @returns {{ key: string, provider: string | undefined, model: string | undefined, source: string }}
 */
export function resolveModel(exec) {
  const args = exec?.arguments
  const argProvider = args && typeof args.provider === 'string' && args.provider !== '' ? args.provider : undefined
  const argModel = args && typeof args.model === 'string' && args.model !== '' ? args.model : undefined

  if (argModel !== undefined) {
    return {
      key: argProvider !== undefined ? `${argProvider}/${argModel}` : argModel,
      provider: argProvider,
      model: argModel,
      source: 'arguments',
    }
  }

  let selection
  try {
    selection = exec?.agent?.model?.current?.()
  } catch {
    selection = undefined
  }
  if (
    selection !== undefined &&
    selection !== null &&
    typeof selection.model === 'string' &&
    selection.model !== ''
  ) {
    const provider =
      typeof selection.provider === 'string' && selection.provider !== '' ? selection.provider : undefined
    return {
      key: provider !== undefined ? `${provider}/${selection.model}` : selection.model,
      provider,
      model: selection.model,
      source: 'agent.model',
    }
  }

  return { key: FALLBACK_KEY, provider: undefined, model: undefined, source: 'fallback' }
}

/** 从 agent 对象解析它当前使用的模型（主 agent 计数用）。 */
function resolveAgentModel(agent) {
  let selection
  try {
    selection = agent?.model?.current?.()
  } catch {
    selection = undefined
  }
  if (selection !== undefined && selection !== null && typeof selection.model === 'string' && selection.model !== '') {
    const provider =
      typeof selection.provider === 'string' && selection.provider !== '' ? selection.provider : undefined
    return {
      key: provider !== undefined ? `${provider}/${selection.model}` : selection.model,
      provider,
      model: selection.model,
      source: 'agent.model',
    }
  }
  return { key: FALLBACK_KEY, provider: undefined, model: undefined, source: 'fallback' }
}

/**
 * 配额匹配，从细到粗：
 *   1. `provider` + `model` 都精确；
 *   2. `provider` 精确 + `model === '*'`；
 *   3. `provider === '*'` + `model` 精确；
 *   4. 两者都是 `*`；
 *   5. `defaultLimit`。
 *
 * @internal 导出仅供测试。
 */
export function capFor(cfg, resolved) {
  const provider = resolved.provider ?? FALLBACK_KEY
  const model = resolved.model ?? FALLBACK_KEY
  const rules = cfg.limits

  const find = (p, m) => {
    for (const rule of rules) {
      if (rule.provider === p && rule.model === m) return rule.max
    }
    return undefined
  }

  // 1) 精确
  if (model !== FALLBACK_KEY) {
    const exact = find(provider, model)
    if (exact !== undefined) return exact
  }
  // 2) provider/*（以及 provider 精确时的兜底）
  const providerWildcard = find(provider, FALLBACK_KEY)
  if (providerWildcard !== undefined) return providerWildcard
  // 3) */model
  if (model !== FALLBACK_KEY) {
    const modelWildcard = find(FALLBACK_KEY, model)
    if (modelWildcard !== undefined) return modelWildcard
  }
  // 4) */*
  const anyRule = find(FALLBACK_KEY, FALLBACK_KEY)
  if (anyRule !== undefined) return anyRule

  return cfg.defaultLimit
}

/** 展示名：`provider/model` 或裸模型名。 */
function displayName(resolved) {
  if (resolved.model === undefined) return '当前模型'
  return resolved.provider !== undefined ? `${resolved.provider}/${resolved.model}` : resolved.model
}

/* ---------------------------------------------------------------- 闸门 */

/** 单个模型的并发闸门。 */
class Gate {
  constructor(limit) {
    this.limit = limit
    this.active = new Set()
    this.closed = false
  }

  get used() {
    return this.active.size
  }

  get remaining() {
    return Math.max(0, this.limit - this.active.size)
  }

  tryEnter(lease) {
    if (this.closed) throw new Error('dsh-subagent-model-limit: plugin disposed')
    if (this.active.size >= this.limit) return false
    this.active.add(lease)
    return true
  }

  /**
   * 无条件占用（主 agent 用）。
   * 允许超出 limit —— 主 agent 的请求**永远不拦**，它只是吃掉可用名额。
   */
  enterUnchecked(lease) {
    this.active.add(lease)
  }

  leave(lease) {
    this.active.delete(lease)
  }

  close() {
    this.closed = true
    this.active.clear()
  }
}

/* ---------------------------------------------------------------- 报错 */

function limitMessage(cfg, resolved, gate) {
  const queueNote =
    cfg.queueTimeoutMs === 0 ? '（本插件不排队：超限即拒绝，不会挂起调用）' : `（排队上限 ${cfg.queueTimeoutMs}ms）`
  return (
    `subagent 未创建：模型 ${displayName(resolved)} 的子代理并发已达上限（${gate.used}/${gate.limit}）。` +
    `当前可用槽位 0 个。请等待已有子代理结束后重试，或直接在当前会话完成这部分工作。${queueNote}`
  )
}

function limitError(cfg, resolved, gate) {
  const err = new Error(limitMessage(cfg, resolved, gate))
  err.name = 'SubagentModelLimitError'
  err.code = 'SUBAGENT_MODEL_CONCURRENCY_LIMIT'
  err.provider = resolved.provider
  err.model = resolved.model
  err.limit = gate.limit
  err.used = gate.used
  err.remaining = 0
  return err
}

/* ---------------------------------------------------------------- 安装 */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = resolveConfig(config)

  /** 模型键 → 闸门。 */
  const gates = new Map()
  /** 把「这次调用占的许可证」从 tools/execute 的异步上下文交给 subagent/start。 */
  const startContext = new AsyncLocalStorage()
  /** runId → 许可证。 */
  const boundByRun = new Map()
  /** 父 agent id → 尚未被 start 认领的许可证集合。 */
  const pendingByAgent = new Map()
  /** 主 agent id → 它占用的租赁（countMainAgent 开启时才有）。 */
  const mainLeases = new Map()

  const gateOf = (resolved) => {
    let gate = gates.get(resolved.key)
    if (gate === undefined) {
      gate = new Gate(capFor(cfg, resolved))
      gates.set(resolved.key, gate)
    }
    return gate
  }

  const trackPending = (agentId, lease) => {
    let set = pendingByAgent.get(agentId)
    if (set === undefined) {
      set = new Set()
      pendingByAgent.set(agentId, set)
    }
    set.add(lease)
  }

  const dropPending = (agentId, lease) => {
    const set = pendingByAgent.get(agentId)
    if (set === undefined) return
    set.delete(lease)
    if (set.size === 0) pendingByAgent.delete(agentId)
  }

  ctx.effect(
    () => () => {
      for (const gate of gates.values()) gate.close()
      gates.clear()
      boundByRun.clear()
      pendingByAgent.clear()
      mainLeases.clear()
    },
    'dsh-subagent-model-limit',
  )

  /* --------------------------------------------- 1) subagent 准入拦截 */

  ctx.on('tools/execute', async (exec, next) => {
    if (!cfg.toolNames.has(exec.name)) return next()
    if (exec.agent === undefined) return next()

    const resolved = resolveModel(exec)
    const gate = gateOf(resolved)
    const agentId = String(exec.agent.id ?? exec.agent.session?.id ?? '')

    const lease = { modelKey: resolved.key, gate, state: 'open', kind: 'subagent' }

    if (!gate.tryEnter(lease)) throw limitError(cfg, resolved, gate)
    if (agentId !== '') trackPending(agentId, lease)

    let failed = false
    try {
      return await startContext.run(lease, next)
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (failed && lease.state === 'open') {
        lease.state = 'done'
        gate.leave(lease)
        if (agentId !== '') dropPending(agentId, lease)
      }
    }
  })

  ctx.on('subagent/start', (info) => {
    const lease = startContext.getStore()
    if (lease === undefined || lease.state !== 'open') return
    lease.state = 'bound'
    boundByRun.set(String(info.runId), lease)
  })

  ctx.on('subagent/end', (info) => {
    const runId = String(info.runId)
    const lease = boundByRun.get(runId)
    if (lease === undefined) return
    boundByRun.delete(runId)
    if (lease.state === 'bound') {
      lease.state = 'done'
      lease.gate.leave(lease)
    }
  })

  ctx.on('agent/disposed', (info) => {
    const agentId = String(info.agent.id ?? '')
    if (agentId === '') return
    const pending = pendingByAgent.get(agentId)
    if (pending !== undefined) {
      pendingByAgent.delete(agentId)
      for (const lease of pending) {
        if (lease.state !== 'open') continue
        lease.state = 'done'
        lease.gate.leave(lease)
      }
    }
    const mainLease = mainLeases.get(agentId)
    if (mainLease !== undefined) {
      mainLeases.delete(agentId)
      mainLease.gate.leave(mainLease)
    }
  })

  /* ------------------------------- 2) 主 agent 计数（只占用，不拦截） */

  /**
   * 主 agent 每进入一次运行态就占用一份配额。
   *
   * 为什么挂在 `agent/status` 而不是 `llm/stream`：`llm/stream` 的 options 里
   * **没有 agent 身份**，无法区分主会话与子代理；`agent/status` 带 `info.agent`，
   * 能用 `delegationDepthOf` 判出主 agent。
   *
   * 「不拦截」是硬约束：这里只调 `enterUnchecked`，从不比较上限。
   */
  ctx.on('agent/status', (info) => {
    if (!cfg.countMainAgent) return
    const agent = info?.agent
    if (agent === undefined) return

    let depth = 0
    try {
      depth = typeof agent.depth === 'number' ? agent.depth : delegationDepth(agent)
    } catch {
      depth = 0
    }
    if (depth !== 0) return // 子代理的请求已由 tools/execute 计过，不重复

    const agentId = String(agent.id ?? agent.session?.id ?? '')
    if (agentId === '') return

    if (info.status === 'idle') {
      const lease = mainLeases.get(agentId)
      if (lease !== undefined) {
        mainLeases.delete(agentId)
        lease.gate.leave(lease)
      }
      return
    }

    if (mainLeases.has(agentId)) return
    const resolved = resolveAgentModel(agent)
    const gate = gateOf(resolved)
    const lease = { modelKey: resolved.key, gate, state: 'bound', kind: 'main' }
    gate.enterUnchecked(lease) // 永不拦截
    mainLeases.set(agentId, lease)
  })

  /* ------------------------------------------- 3) 设置页用的配置接口 */

  /** 当前生效的配额快照（含实时占用），给设置页展示。 */
  const snapshot = () => ({
    defaultLimit: cfg.defaultLimit,
    countMainAgent: cfg.countMainAgent,
    limits: cfg.limits,
    effective: [...gates.entries()].map(([key, gate]) => ({
      key,
      limit: gate.limit,
      used: gate.used,
      remaining: gate.remaining,
    })),
  })

  ctx.inject(['webServer'], (scope) => {
    const route = {
      kind: 'prefix',
      path: '/subagent-model-limit/api',
      async handler(req, res) {
        const url = String(req.url ?? '')
        const pathname = url.split('?')[0] ?? ''
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }

        try {
          if (pathname.endsWith('/config') && (req.method ?? 'GET').toUpperCase() === 'GET') {
            return send(200, { ok: true, value: { ...readRuntimeConfig(), effective: snapshot() } })
          }
          if (pathname.endsWith('/config') && (req.method ?? 'GET').toUpperCase() === 'POST') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const raw = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
            const parsed = raw === '' ? {} : JSON.parse(raw)

            const patch = {}
            if (Array.isArray(parsed.limits)) patch.limits = normalizeLimits(parsed.limits)
            else if (parsed.limits !== undefined && typeof parsed.limits === 'object') {
              patch.limits = normalizeLimits(parsed.limits)
            }
            if (typeof parsed.defaultLimit !== 'undefined') {
              const n = Number(parsed.defaultLimit)
              if (!isPosInt(n)) return send(400, { ok: false, error: { code: 'bad-default-limit', message: 'defaultLimit 必须是正整数' } })
              patch.defaultLimit = n
            }
            if (typeof parsed.countMainAgent !== 'undefined') {
              if (typeof parsed.countMainAgent !== 'boolean') {
                return send(400, { ok: false, error: { code: 'bad-count-main', message: 'countMainAgent 必须是布尔值' } })
              }
              patch.countMainAgent = parsed.countMainAgent
            }

            const path = writeRuntimeConfig(patch)
            return send(200, { ok: true, value: { path, saved: patch, note: '重启该插件或刷新页面后生效' } })
          }
          return send(404, { ok: false, error: { code: 'not-found', message: `no route ${req.method} ${url}` } })
        } catch (error) {
          return send(400, {
            ok: false,
            error: { code: 'config-error', message: error instanceof Error ? error.message : String(error) },
          })
        }
      },
    }
    scope.effect(() => scope.webServer.register(route), 'subagent-model-limit: config api')
  })
}

/* --------------------------------------------------------------- 工具 */

/**
 * 尽力判断 agent 的委派深度：0 = 主 agent。
 *
 * 不硬依赖 `@deepseek-ai/dsh-subagent` 的 `delegationDepthOf`（它不一定被本插件
 * 的解析路径看到）：优先读 agent 上的现成字段，读不到就按「没有父会话 = 主 agent」。
 */
function delegationDepth(agent) {
  const direct = agent?.delegationDepth ?? agent?.depth
  if (typeof direct === 'number') return direct
  const header = agent?.session?.header
  if (header !== undefined && header !== null) {
    return header.origin === 'subagent' ? 1 : 0
  }
  return 0
}

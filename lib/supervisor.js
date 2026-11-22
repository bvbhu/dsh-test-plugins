/**
 * 进程托管：启动 → 逐行抓 URL → 等它真的能应答 → 记住 URL；停止 / 重启。
 *
 * 状态机（与 dsh-desktop-webview 的 SessionPhase 同形，去掉了与本插件无关的
 * NeedsToken —— 那里弹窗收 URL 是因为外壳没有设置页，而本插件的 fixedUrl 就是
 * 设置页字段，临时 URL 没有存在意义）：
 *
 *   idle ──start──▶ probing ──可应答──▶ adopted（别人的进程，只接管不杀）
 *     │                │
 *     │                └──不可达──▶ launching ──抓到 URL──▶ readying ──▶ ready
 *     │                                    │                              │
 *     │                                    └─超时/退出/异常──▶ failed      │
 *     └───────────────────────────────── 进程自己退出 ◀────────────────────┘
 *
 * “接管”模式是必须的，不是防御性代码：dsh-desktop-webview 的契约就是“探活失败才
 * 拉起”。如果服务已经在跑（用户手动起的、或开机自启），盲目再 spawn 一个会直接撞
 * 端口；而把别人的进程当成自己的杀掉更糟。故 adopted 状态下 stop() 是空操作。
 */

import { spawn } from 'node:child_process'
import { UrlExtractor, ensureScheme, isHttpUrl } from './url-extractor.js'
import { childEnv } from './child-env.js'
import { killTree } from './process-tree.js'

/** 启动后等 URL 的硬上界（毫秒）。 */
const LAUNCH_TIMEOUT_MS = 30_000
/** 抓到 URL 后等端口真正 LISTEN 的轮询间隔（对齐外壳实测：dsh web 打印 URL 后 1.5~2s 才 LISTEN）。 */
const READY_POLL_MS = 350
/** 就绪等待总预算（软上界：只在每轮开头检查）。 */
const READY_BUDGET_MS = 12_000
/** 单次探测超时。 */
const PROBE_TIMEOUT_MS = 3_000
/** 日志尾部保留字节。 */
const LOG_TAIL_BYTES = 8_000

/** 进程阶段。 */
export const Phase = {
  IDLE: 'idle',
  PROBING: 'probing',
  LAUNCHING: 'launching',
  READYING: 'readying',
  READY: 'ready',
  ADOPTED: 'adopted',
  EXITED: 'exited',
  FAILED: 'failed',
}

/**
 * 一次轻量存活探测：拿到**任何** HTTP 应答都算在线。
 *
 * 为什么 401/403 也算在线：probeUrl 常是不带 token 的裸地址，返回 401 是“要 token”
 * 而不是“没在跑”。只有连接失败/超时才是不可达（外壳 ProbeClassifier 的同款口径）。
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
async function probe(url, signal) {
  try {
    const res = await fetch(url, { signal, redirect: 'manual' })
    // 只要服务端应答了就说明在监听；正文不读。
    res.body?.cancel?.().catch(() => {})
    return true
  } catch {
    return false
  }
}

/** 睡一会儿（可被取消）。 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * 等到 url 真的能应答；预算内不可达则返回 false。
 * @param {string} url
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>}
 */
async function waitReady(url, signal) {
  const deadline = Date.now() + READY_BUDGET_MS
  for (;;) {
    if (signal.aborted) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    const cancel = () => controller.abort()
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const ok = await probe(url, controller.signal)
      if (ok) return true
    } catch {
      // 探测自身异常（DNS、TLS）按“仍未就绪”处理，继续轮询。
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
    if (Date.now() >= deadline) return false
    await sleep(READY_POLL_MS, signal)
  }
}

/**
 * 一个本地进程的托管者。
 *
 * 刻意**不经** ctx.subprocess.spawn：DSH 的 Windows Job runner 硬编码
 * `windowsHide: true`（dsh-subprocess-local 的 launchWindowsJob），会把 GUI 窗口
 * 一并隐藏 —— RPC 回 ok 但窗口根本不出现。而 ctx.subprocess 的契约又要求
 * cwd 为字符串、且是 collect 语义，对“长驻服务”并不比 node:child_process 更合适。
 * 这里用 node:child_process + detached + unref，停进程时用 taskkill /T /F 收整棵树
 * （与 dsh-vscode-mode/src/processTree.ts 同款）。
 */
export class Supervisor {
  /**
   * @param {object} options
   * @param {string[]} options.argv 启动命令（数组，不经 shell 插值）
   * @param {string} options.cwd 工作目录
   * @param {Record<string, string>} options.env 额外环境变量
   * @param {string} options.urlExtractRegex 抓 URL 的正则
   * @param {string} options.successMarkerRegex 成功标志正则；空串禁用
   * @param {string} options.fixedUrl 抓不到 URL 时用的固定地址（也是探活地址）
   * @param {boolean} options.probeFirst 启动前先探活（默认 true）
   * @param {(line: string) => void} [options.onLog]
   * @param {(argv: string[], opts: object) => import('node:child_process').ChildProcess} [options.spawn]
   *   启动缝：默认 node:child_process.spawn。测试可注入一个假子进程，
   *   让整条链路（抓行 → 等应答 → 停止）不依赖真实 fork 也能验证。
   */
  constructor(options) {
    this.options = options
    /** 启动缝，见构造参数。 */
    this.spawn = options.spawn ?? spawn
    /** @type {string} */
    this.phase = Phase.IDLE
    /** @type {string | null} */
    this.url = null
    /** @type {number | null} */
    this.pid = null
    /** @type {string | null} */
    this.error = null
    /** @type {number | null} */
    this.exitCode = null
    /** @type {number} */
    this.since = Date.now()
    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    /** @type {AbortController | null} */
    this.run = null
    /** @type {Promise<void> | null} */
    this.inFlight = null
    this.logTail = ''
  }

  /** 追加一行日志，只留尾部。 */
  pushLog(line) {
    if (typeof line !== 'string' || line === '') return
    this.logTail = (this.logTail + line + '\n').slice(-LOG_TAIL_BYTES)
    try {
      this.options.onLog?.(line)
    } catch {
      // 诊断回调不能影响托管本身。
    }
  }

  /**
   * 当前状态快照。
   * @returns {{phase: string, url: string | null, pid: number | null, exitCode: number | null, error: string | null, since: number, owned: boolean}}
   */
  status() {
    return {
      phase: this.phase,
      url: this.url,
      pid: this.pid,
      exitCode: this.exitCode,
      error: this.error,
      since: this.since,
      // owned=false 表示“接管了别人的进程”：UI 必须据此隐藏停止按钮。
      owned: this.child !== null,
    }
  }

  /**
   * 启动（或接管）。并发调用合并到同一次在途运行，不并发 spawn。
   * @returns {Promise<object>} status()
   */
  start() {
    if (this.inFlight !== null) return this.inFlight.then(() => this.status())
    this.inFlight = this.runStart().finally(() => {
      this.inFlight = null
    })
    return this.inFlight.then(() => this.status())
  }

  /** @returns {Promise<void>} */
  async runStart() {
    if (this.phase === Phase.READY || this.phase === Phase.ADOPTED || this.phase === Phase.READYING) return
    // 重启前先收掉自己拉起的进程，避免端口冲突。
    await this.stop()

    const controller = new AbortController()
    this.run = controller
    const signal = controller.signal
    this.error = null
    this.exitCode = null
    this.since = Date.now()

    const fixed = ensureScheme(this.options.fixedUrl)

    if (this.options.probeFirst !== false && fixed !== null) {
      this.phase = Phase.PROBING
      if (await waitReady(fixed, signal)) {
        this.phase = Phase.ADOPTED
        this.url = fixed
        return
      }
      if (signal.aborted) return
    }

    const argv = this.options.argv
    if (!Array.isArray(argv) || argv.length === 0) {
      this.phase = Phase.FAILED
      this.error = '未配置启动命令（argv 为空）'
      return
    }

    this.phase = Phase.LAUNCHING
    const [program, ...args] = argv
    const extractor = new UrlExtractor(this.options.urlExtractRegex, this.options.successMarkerRegex)

    // URL 与“成功标志”谁先到谁定胜负；两者都用一个 Promise 竞速。
    /** @type {(value: string) => void} */
    let settleExtract
    /** @type {(value: boolean) => void} */
    let settleMarker
    /** @type {(value: number | null) => void} */
    let settleExit
    // 三个竞速通道：抓到 URL / 命中成功标志 / 进程退出。声明必须先于构造，
    // 否则 Promise executor 同步执行时会撞上 TDZ。
    const gotUrl = new Promise((resolve) => { settleExtract = resolve })
    const gotMarker = new Promise((resolve) => { settleMarker = resolve })
    const exited = new Promise((resolve) => { settleExit = resolve })
    const timeout = sleep(LAUNCH_TIMEOUT_MS, signal).then(() => 'timeout')

    let child
    try {
      child = this.spawn(program, args, {
        cwd: this.options.cwd || process.cwd(),
        env: childEnv(this.options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      this.phase = Phase.FAILED
      this.error = '进程启动失败：' + String(err)
      return
    }

    this.child = child
    this.pid = child.pid ?? null
    child.unref()

    const onLine = (raw) => {
      const line = String(raw)
      for (const piece of line.split(/\r?\n/)) {
        if (piece.trim() === '') continue
        this.pushLog(piece)
        const url = extractor.tryExtract(piece)
        if (url !== null) {
          const normalized = ensureScheme(url)
          if (normalized !== null && isHttpUrl(normalized)) settleExtract(normalized)
          continue
        }
        if (extractor.isSuccessMarker(piece)) settleMarker(true)
      }
    }
    // 只按需 setEncoding：真实子进程有这个方法，注入的假子进程可能没有。
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => onLine(chunk))
    child.stderr?.on('data', (chunk) => onLine(chunk))
    child.once('exit', (code) => {
      this.exitCode = typeof code === 'number' ? code : null
      settleExit(this.exitCode)
    })
    child.once('error', (err) => {
      this.pushLog('[启动失败] ' + String(err))
      settleExit(null)
    })

    const winner = await Promise.race([gotUrl, gotMarker, exited, timeout])

    if (signal.aborted) {
      killTree(child)
      this.child = null
      return
    }

    if (winner === 'timeout') {
      this.phase = Phase.FAILED
      this.error = `启动超时（${LAUNCH_TIMEOUT_MS}ms）内未抓到 URL，也未命中成功标志`
      killTree(child)
      this.child = null
      return
    }

    if (typeof winner === 'number' || winner === null) {
      // 进程在吐出 URL 之前就退出了。
      this.phase = Phase.FAILED
      this.error = `进程退出（退出码 ${String(this.exitCode)}），未抓到 URL`
      this.child = null
      return
    }

    const target = typeof winner === 'string' ? winner : (fixed ?? null)
    if (target === null) {
      this.phase = Phase.FAILED
      this.error = '命中成功标志，但未配置 fixedUrl，无法确定要渲染的地址'
      killTree(child)
      this.child = null
      return
    }

    this.url = target
    this.phase = Phase.READYING
    const ready = await waitReady(target, signal)
    if (signal.aborted) {
      killTree(child)
      this.child = null
      return
    }
    if (!ready) {
      this.phase = Phase.FAILED
      this.error = `已抓到 URL ${target}，但它在 ${READY_BUDGET_MS}ms 内没有应答`
      killTree(child)
      this.child = null
      return
    }
    this.phase = Phase.READY
  }

  /**
   * 停止。**只杀自己拉起的进程**；adopted 状态下是空操作。
   * @returns {Promise<void>}
   */
  async stop() {
    this.run?.abort()
    this.run = null
    const child = this.child
    if (child === null) {
      if (this.phase === Phase.ADOPTED) this.phase = Phase.IDLE
      this.url = null
      return
    }
    this.child = null
    killTree(child)
    this.pid = null
    this.url = null
    this.phase = Phase.IDLE
    this.since = Date.now()
  }

  /**
   * 重启：串行执行 stop → start，不并发。
   * @returns {Promise<object>} status()
   */
  async restart() {
    await this.stop()
    return this.start()
  }

  /** 插件卸载：杀掉自己拉起的进程。 */
  dispose() {
    return this.stop()
  }
}

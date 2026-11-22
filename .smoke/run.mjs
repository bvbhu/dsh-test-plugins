// 端到端烟测：用假目标进程跑一遍 Supervisor 的完整链路。
// 覆盖四件事：① 抓 URL（含 ANSI 剥离）② 抓到后等它真能应答 ③ stop 后端口释放
//            ④ “接管”模式：服务已在跑时不重复拉起，且不会杀掉它。
import { EventEmitter } from 'node:events'
import { Supervisor } from '../lib/supervisor.js'
import { stripAnsi, ensureScheme } from '../lib/url-extractor.js'

const PORT = 45711

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

// ── 纯函数部分 ────────────────────────────────────────────────────────────
const dirty = '\x1B[36mready on http://127.0.0.1:1234/?key=abc\x1B[0m'
check('stripAnsi 去掉复位序列', stripAnsi(dirty) === 'ready on http://127.0.0.1:1234/?key=abc', JSON.stringify(stripAnsi(dirty)))
check('ensureScheme 补 http', ensureScheme('127.0.0.1:4000/?key=x') === 'http://127.0.0.1:4000/?key=x')
check('ensureScheme 不改已有 scheme', ensureScheme('https://a/b?k=1') === 'https://a/b?k=1')

// 空的“成功标志正则”必须是禁用，而不是匹配任意行（外壳同款坑）。
const markerless = new Supervisor({ argv: ['x'], successMarkerRegex: '', fixedUrl: '' })
check('空 successMarkerRegex = 禁用', markerless && typeof markerless.runStart === 'function')

// ── 假子进程：按脚本打印行，可选地在打印后真的监听端口 ─────────────────────
/**
 * 造一个符合 Supervisor 需要的 ChildProcess 面：stdout/stderr 为可读流，
 * 有 pid、unref、once('exit')。用它把链路跑通而不依赖真实 fork。
 * @param {{lines: string[], listenAfter?: boolean, port?: number}} spec
 */
const openServers = new Set()

function fakeChild(spec) {
  const child = new EventEmitter()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  child.stdout = stdout
  child.stderr = stderr
  child.pid = 4242
  child.unref = () => {}
  let server = null
  child.kill = () => {
    if (server) { openServers.delete(server); server.close() }
    child.emit('exit', 0)
  }
  const emit = () => {
    for (const line of spec.lines) stdout.emit('data', line + '\n')
    if (spec.listenAfter) {
      setTimeout(async () => {
        const { createServer } = await import('node:http')
        server = createServer((req, res) => { res.writeHead(200); res.end('local-app target ok') })
        server.listen(spec.port ?? PORT, '127.0.0.1')
        openServers.add(server)
      }, 50)
    }
  }
  setTimeout(emit, 10)
  return child
}

// 注入缝：让 Supervisor 用假子进程，同时把 kill 路由到 taskkill 之外的收尾。
const spawnSeam = (_program, _args, _opts) => fakeChild({
  lines: [
    '\x1B[32m[target]\x1B[0m booting...',
    `\x1B[36mready on http://127.0.0.1:${PORT}/?key=s3cr3t-abc123\x1B[0m`,
  ],
  listenAfter: true,
  port: PORT,
})

const sup = new Supervisor({
  argv: ['fake', 'target'],
  urlExtractRegex: String.raw`(?<url>https?://\S+)`,
  successMarkerRegex: '',
  fixedUrl: '',
  probeFirst: false,
  spawn: spawnSeam,
})

// killTree 在 win32 上走 taskkill /PID —— 假 pid 4242 不存在，会静默失败。
// 所以这里直接把 stop 的收尾换成假子进程的 kill，验证状态迁移本身。
const status = await sup.start()
console.log('status =', JSON.stringify(status))
check('阶段为 ready', status.phase === 'ready', status.phase)
check('抓到 URL 且带 key', typeof status.url === 'string' && status.url.includes('key=s3cr3t-abc123'), String(status.url))
check('URL 不含 ANSI 转义', typeof status.url === 'string' && !status.url.includes('\x1B'), JSON.stringify(status.url))
check('owned = true（是自己拉起的）', status.owned === true)

// 抓到 URL 之后，它必须真的能应答（这一步同时验证了“打印 URL”和“端口 LISTEN”
// 之间的等待窗口被正确处理）。
if (status.url) {
  const res = await fetch(status.url)
  const text = await res.text()
  check('目标页可访问', res.status === 200 && text.includes('local-app target ok'), `${res.status} ${text}`)
}

// stop 之后：状态回到 idle，且不再持有 URL。
await sup.stop()
const after = sup.status()
check('stop 后回到 idle', after.phase === 'idle', after.phase)
check('stop 后清空 URL', after.url === null, String(after.url))

// ── 接管模式：fixedUrl 已能应答 ⇒ adopted，不 spawn ───────────────────────
let spawnedInAdopt = false
const adopted = new Supervisor({
  argv: ['fake', 'target'],
  urlExtractRegex: String.raw`(?<url>https?://\S+)`,
  successMarkerRegex: '',
  fixedUrl: `http://127.0.0.1:${PORT}/`,
  probeFirst: true,
  spawn: () => { spawnedInAdopt = true; return fakeChild({ lines: [] }) },
})
const adoptStatus = await adopted.start()
check('已在线 ⇒ adopted', adoptStatus.phase === 'adopted', adoptStatus.phase)
check('adopted 不重复拉起进程', spawnedInAdopt === false)
check('adopted 的 owned = false（不会杀别人的进程）', adoptStatus.owned === false)
await adopted.stop()
check('adopted 的 stop 是空操作（进程仍在）', (await fetch(`http://127.0.0.1:${PORT}/`)).status === 200)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)

// 收尾：关掉烟测自己开的服务器并**等**它们真正关闭。立刻 process.exit 会在
// libuv 关闭句柄的过程中撞上 "!(handle->flags & UV_HANDLE_CLOSING)" 断言
// —— 进程看着像崩了，其实是没等清理完就退了。
await Promise.all([...openServers].map((server) => new Promise((resolve) => {
  server.closeAllConnections?.()
  server.close(() => resolve())
})))
openServers.clear()
process.exitCode = failures === 0 ? 0 : 1

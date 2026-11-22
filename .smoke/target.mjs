// 烟测用的假“本地服务”：先打印一行带 ANSI 上色和 key 的 URL，再真的监听。
// 打印与 LISTEN 之间刻意留 800ms 间隔，用来验证「抓到 URL 后还要等它真能应答」。
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 45711)
const key = 's3cr3t-' + Math.random().toString(36).slice(2, 8)

console.log('\x1B[32m[target]\x1B[0m booting...')
setTimeout(() => {
  // 结尾的复位序列会被 \S+ 吞进捕获组 —— stripAnsi 必须先跑。
  console.log(`\x1B[36mready on http://127.0.0.1:${port}/?key=${key}\x1B[0m`)
  setTimeout(() => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('local-app target ok')
    })
    server.listen(port, '127.0.0.1')
    console.log(`[target] listening ${port}`)
  }, 800)
}, 200)

#!/usr/bin/env node
/**
 * 假上游 —— 只做一件事：从输入文本里匹配时间，等那么久，然后结束。
 *
 * 存在的意义：验证「按模型限制 subagent 并发」需要一个**可控的慢上游**。
 * 真上游等不到、还可能被限流；这个假上游每次请求都可复现地占用固定秒数，
 * 于是并发数一眼可知。
 *
 * 协议：OpenAI 兼容（`POST /v1/chat/completions`，支持 stream / non-stream）。
 *
 * 行为：
 *   1. 从最后一条 user 消息里找时间（`等 5 秒` / `5秒` / `5s` / `sleep 5` / `5 秒`）；
 *   2. 尚无 tool 结果时 → 返回一个 `wait` 工具调用（参数 seconds=N）；
 *   3. 已有 tool 结果时 → 返回结束语，`finish_reason: "stop"`。
 * 没匹配到时间就默认等 DEFAULT_SECONDS 秒。
 *
 * 用法：
 *   node test/fake-upstream.mjs                 # 监听 127.0.0.1:4999
 *   node test/fake-upstream.mjs --port 5001
 *   node test/fake-upstream.mjs --default 10    # 没写时间的请求默认等 10 秒
 *   node test/fake-upstream.mjs --quiet
 *
 * 五种触发方式，任选其一接入 DSH：
 *   - 作为 as-one 的上游 provider（推荐，走真实网关链路）；
 *   - 或在支持自定义 OpenAI 兼容 provider 的宿主里直接指向本服务。
 */

import { createServer } from 'node:http'

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

const PORT = Number(argOf('--port') ?? 4999)
const DEFAULT_SECONDS = Number(argOf('--default') ?? 3)
const QUIET = argv.includes('--quiet')
const MODEL = argOf('--model') ?? 'fake-slow'

const log = (...args) => {
  if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...args)
}

/** 从文本里抠出秒数。 */
function secondsOf(text) {
  const source = String(text ?? '')
  const patterns = [
    /等\s*(\d+(?:\.\d+)?)\s*秒/,
    /(\d+(?:\.\d+)?)\s*秒/,
    /sleep\s*(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*s\b/i,
  ]
  for (const re of patterns) {
    const m = re.exec(source)
    if (m !== null) return Number(m[1])
  }
  return DEFAULT_SECONDS
}

/** 取最后一条 user 消息的纯文本。 */
function lastUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role !== 'user') continue
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
    }
    return ''
  }
  return ''
}

/** 本轮是否已经调用过 wait 工具（存在 role=tool 的消息即算）。 */
function hasToolResult(messages) {
  return Array.isArray(messages) && messages.some((msg) => msg?.role === 'tool')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/* ------------------------------------------------------------- 响应构造 */

function toolCallChunk(id, model, seconds) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${id}`,
              type: 'function',
              function: { name: 'wait', arguments: JSON.stringify({ seconds }) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }
}

function textChunk(id, model, text, finishReason = null) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }],
  }
}

function sse(res, chunks) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/* ---------------------------------------------------------------- 服务 */

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
    return sendJson(res, 200, {
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'fake-upstream' }],
    })
  }

  if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
    let body
    try {
      body = await readBody(req)
    } catch {
      return sendJson(res, 400, { error: { message: 'invalid JSON body' } })
    }

    const messages = body.messages
    const text = lastUserText(messages)
    const seconds = secondsOf(text)
    const wantsTool = !hasToolResult(messages)
    const id = Math.random().toString(36).slice(2, 10)
    const model = body.model ?? MODEL

    log(`request model=${model} seconds=${seconds} tool=${wantsTool}`)

    // 「等待」发生在这里：客户端能直观看到这条请求占用了多久。
    await sleep(seconds * 1000)

    if (body.stream === true) {
      if (wantsTool) {
        return sse(res, [
          textChunk(id, model, ''),
          toolCallChunk(id, model, seconds),
          textChunk(id, model, '', 'tool_calls'),
        ])
      }
      return sse(res, [
        textChunk(id, model, `已等待 ${seconds} 秒，结束。`),
        textChunk(id, model, '', 'stop'),
      ])
    }

    if (wantsTool) {
      return sendJson(res, 200, {
        id: `chatcmpl-${id}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${id}`,
                  type: 'function',
                  function: { name: 'wait', arguments: JSON.stringify({ seconds }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }

    return sendJson(res, 200, {
      id: `chatcmpl-${id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: `已等待 ${seconds} 秒，结束。` },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }

  sendJson(res, 404, { error: { message: `no route for ${req.method} ${req.url}` } })
})

server.listen(PORT, '127.0.0.1', () => {
  log(`fake upstream listening on http://127.0.0.1:${PORT}  model=${MODEL}  default=${DEFAULT_SECONDS}s`)
  log('协议：POST /v1/chat/completions（stream 与非 stream 都支持）')
  log('用法：在消息里写「等 5 秒」，它就会先调 wait 工具、等 5 秒、再结束。')
})

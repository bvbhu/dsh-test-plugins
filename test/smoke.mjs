import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'pixmax-workflow-'))
process.env.DSH_GPT_ROOT = root

const fail = []
const pass = []
function check(name, condition, detail) {
  if (condition) pass.push(name)
  else fail.push(name + (detail ? ` :: ${detail}` : ''))
}

// ---------- image-models ----------
const models = await import('../src/image-models.mjs')
const defaults = models.loadImageSettings(root)
check('defaults: browser default', defaults.defaultModel === 'browser/gpt-image-2', defaults.defaultModel)
check('defaults: one builtin', models.effectiveModels(defaults).length === 1, String(models.effectiveModels(defaults).length))
check('defaults: builtin is browser only', models.effectiveModels(defaults)[0].id === 'browser/gpt-image-2')
check('resolve alias browser', models.resolveImageModel(defaults, 'browser').model.kind === 'browser')
try { models.resolveImageModel(defaults, 'sensenova'); check('sensenova alias needs a user endpoint', false) } catch { check('sensenova alias needs a user endpoint', true) }

// SenseNova is a user-configured OpenAI-compatible endpoint, not a builtin.
const sensenova = models.normalizeModel({
  id: 'sensenova/sensenova-u1.5-lite',
  kind: 'openai',
  model: 'sensenova-u1.5-lite',
  baseUrl: 'https://token.sensenova.cn/v1',
  apiStyle: 'json',
})
check('normalize: sensenova endpoint ok', sensenova.ok === true, JSON.stringify(sensenova))
const withEndpoint = models.saveImageSettings(root, { defaultModel: 'browser/gpt-image-2', disabledBuiltins: [], models: [sensenova.model] })
check('resolve alias sensenova (user endpoint)', models.resolveImageModel(withEndpoint, 'sensenova').model.id === 'sensenova/sensenova-u1.5-lite')
check('resolve by full id (user endpoint)', models.resolveImageModel(withEndpoint, 'sensenova/sensenova-u1.5-lite').model.model === 'sensenova-u1.5-lite')
try { models.resolveImageModel(withEndpoint, 'nope/nope'); check('unknown model rejects', false) } catch { check('unknown model rejects', true) }

const badId = models.normalizeModel({ id: 'no-slash', kind: 'openai', model: 'x', baseUrl: 'https://a' })
check('normalize: bad id rejected', badId.ok === false)
const noBase = models.normalizeModel({ id: 'openai/gpt-image-1', kind: 'openai', model: 'gpt-image-1' })
check('normalize: missing baseUrl rejected', noBase.ok === false)
const good = models.normalizeModel({ id: 'openai/gpt-image-1', kind: 'openai', model: 'gpt-image-1', baseUrl: 'https://api.example.com/v1/', apiStyle: 'multipart' })
check('normalize: good model ok', good.ok === true && good.model.baseUrl === 'https://api.example.com/v1', JSON.stringify(good))

const saved = models.saveImageSettings(root, {
  defaultModel: 'openai/gpt-image-1',
  disabledBuiltins: ['browser/gpt-image-2'],
  models: [good.model],
})
check('save roundtrip default', saved.defaultModel === 'openai/gpt-image-1')
const reread = models.loadImageSettings(root)
check('save roundtrip file', reread.models.length === 1 && reread.defaultModel === 'openai/gpt-image-1', JSON.stringify(reread))
check('disabled builtin hidden', !models.effectiveModels(reread).some((m) => m.id === 'browser/gpt-image-2'))
try {
  models.saveImageSettings(root, { models: [good.model, { ...good.model, label: 'dup' }] })
  check('duplicate id rejected', false)
} catch { check('duplicate id rejected', true) }

// ---------- image-api ----------
const api = await import('../src/image-api.mjs')
check('mapSize 2K', api.mapSize('2K') === '2048x2048')
check('mapSize auto', api.mapSize('') === 'auto')
check('mapSize pass-through', api.mapSize('1024x1024') === '1024x1024')
try { api.mapSize('abc', { strict: true }); check('strict size rejects', false) } catch { check('strict size rejects', true) }

// ---------- pixmax guard ----------
const pix = await import('../src/pixmax-tools.mjs')
const blocked = [
  ['image', 'generate', 'x', '--run'],
  ['node', 'update', 'x', '--run'],
  ['tasks', 'submit-batch', '--data', '{}'],
  ['tasks', 'quick-submit'],
  ['group', 'run', 'g'],
  ['video', 'generate-final', 'src'],
  ['raw', 'post', '/generate/batch'],
  ['repl'],
  ['doctor', '--token', 'abc'],
]
for (const argv of blocked) {
  try {
    pix.guardArgv(argv)
    check('blocked: ' + argv.join(' '), false)
  } catch { check('blocked: ' + argv.join(' '), true) }
}
const allowed = [
  ['doctor', '--online'],
  ['node', 'list', '--generated'],
  ['node', 'create', 'x', '--type', 'GENERATE_VIDEO', '--dry-run'],
  ['video', 'generate-final', 'src', '--dry-run'],
  ['raw', 'get', '/user/info'],
  ['assets', 'upload', 'C:/tmp/a.png', '--dry-run'],
  ['workflow', 'run', 'w', '--dry-run'],
]
for (const argv of allowed) {
  try {
    pix.guardArgv(argv)
    check('allowed: ' + argv.join(' '), true)
  } catch (error) {
    check('allowed: ' + argv.join(' '), false, String(error.message))
  }
}
check('pixmax strips leading pixmax', pix.guardArgv(['pixmax', 'doctor'])[0] === 'doctor')

// Opt-in credit policy: submit paths unlock, safety limits stay.
const creditOnOpts = { allowCreditTasks: true }
const unlocked = [
  ['node', 'update', 'x', '--run'],
  ['tasks', 'submit-batch'],
  ['group', 'run', 'g'],
  ['video', 'generate-final', 'src'],
]
for (const argv of unlocked) {
  try {
    pix.guardArgv(argv, creditOnOpts)
    check('unlocked: ' + argv.join(' '), true)
  } catch (error) {
    check('unlocked: ' + argv.join(' '), false, String(error.message))
  }
}
for (const argv of [['repl'], ['raw', 'post', 'x'], ['node', 'get', 'x', '--token', 'abc']]) {
  try {
    pix.guardArgv(argv, creditOnOpts)
    check('still blocked: ' + argv.join(' '), false)
  } catch { check('still blocked: ' + argv.join(' '), true) }
}
check('default still blocks --run', (() => { try { pix.guardArgv(['node', 'update', 'x', '--run']); return false } catch { return true } })())

// ---------- fake ctx ----------
const store = new Map()
const credentials = {
  async resolve(name) { return store.has(name) ? { value: store.get(name) } : null },
  async set(name, value) { store.set(name, value) },
  async unset(name) { store.delete(name) },
}
const routes = []
const registeredTools = []
function makeCtx() {
  return {
    tools: { register: (definition) => registeredTools.push(definition) },
    get(name) {
      if (name === 'credentials') return credentials
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      return undefined
    },
    inject(names, callback) { callback(this) },
    effect(fn) { return fn() },
    logger: { info() {}, warn() {} },
  }
}

// ---------- settings host ----------
const host = await import('../src/settings-host.mjs')
host.apply(makeCtx(), { root })
check('host: 8 routes', routes.length === 8, String(routes.length))
const route = (path, method) => routes.find((r) => r.path === path && (method ? true : true) && r.path === path)

function fakeReq(method, body, headers = { host: '127.0.0.1:52089' }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
}
function fakeRes() {
  const out = { status: 0, body: null }
  return {
    writeHead(status) { out.status = status },
    end(payload) { out.body = payload ? JSON.parse(payload) : null },
    out,
  }
}
async function hit(path, method, body, headers) {
  const target = routes.find((r) => r.path === path)
  const res = fakeRes()
  await target.handler(fakeReq(method, body, headers), res)
  return res.out
}

const stateRes = await hit('/api/dsh-pixmax-workflow/state', 'GET')
check('GET state ok', stateRes.status === 200 && stateRes.body.ok === true, JSON.stringify(stateRes).slice(0, 200))
check('GET state has one builtin', Array.isArray(stateRes.body.builtins) && stateRes.body.builtins.length === 1)
check('GET state has user model', stateRes.body.models.some((m) => m.id === 'openai/gpt-image-1'))
check('GET state key status', stateRes.body.models[0].key && stateRes.body.models[0].key.configured === false, JSON.stringify(stateRes.body.models[0]?.key))

const saveRes = await hit('/api/dsh-pixmax-workflow/save', 'POST', {
  defaultModel: 'openai/gpt-image-1',
  disabledBuiltins: [],
  models: [{ id: 'openai/gpt-image-1', label: 'GPT Image', kind: 'openai', model: 'gpt-image-1', baseUrl: 'https://api.example.com/v1', apiStyle: 'multipart' }],
})
check('POST state ok', saveRes.status === 200 && saveRes.body.ok === true, JSON.stringify(saveRes).slice(0, 300))
check('POST state persisted default', saveRes.body.defaultModel === 'openai/gpt-image-1')

const dupBuiltin = await hit('/api/dsh-pixmax-workflow/save', 'POST', { models: [{ id: 'browser/gpt-image-2', kind: 'openai', model: 'x', baseUrl: 'https://a.b/v1' }] })
check('POST state rejects builtin duplicate', dupBuiltin.status === 400, JSON.stringify(dupBuiltin).slice(0, 200))

const keySet = await hit('/api/dsh-pixmax-workflow/key', 'POST', { action: 'set', modelId: 'openai/gpt-image-1', value: 'sk-test-123' })
check('POST key set ok', keySet.status === 200 && keySet.body.models[0].key.configured === true, JSON.stringify(keySet.body.models?.[0]?.key))
check('POST key stored under credential name', store.get('PIXMAX_WORKFLOW_IMAGE_OPENAI_API_KEY') === 'sk-test-123', JSON.stringify([...store.keys()]))
const keyStatusRes = await hit('/api/dsh-pixmax-workflow/key', 'POST', { action: 'status', modelId: 'openai/gpt-image-1' })
check('POST key status source', keyStatusRes.body.models[0].key.source === 'credentials')
const keyClear = await hit('/api/dsh-pixmax-workflow/key', 'POST', { action: 'clear', modelId: 'openai/gpt-image-1' })
check('POST key clear ok', keyClear.status === 200 && keyClear.body.models[0].key.configured === false)
const keyBrowser = await hit('/api/dsh-pixmax-workflow/key', 'POST', { action: 'set', modelId: 'browser/gpt-image-2', value: 'x' })
check('browser key rejected', keyBrowser.status === 400, JSON.stringify(keyBrowser).slice(0, 160))
const crossSite = await hit('/api/dsh-pixmax-workflow/state', 'GET', undefined, { host: '127.0.0.1:52089', 'sec-fetch-site': 'cross-site' })
check('cross-site rejected', crossSite.status === 403)
const wrongMethod = await hit('/api/dsh-pixmax-workflow/state', 'PUT')
check('wrong method rejected', wrongMethod.status === 405)
const health = await hit('/api/dsh-pixmax-workflow/health', 'GET')
check('health ok', health.status === 200 && health.body.ok === true)

const cliGet = await hit('/api/dsh-pixmax-workflow/cli', 'GET')
check('GET cli default', cliGet.status === 200 && cliGet.body.ok === true && cliGet.body.source === 'default', JSON.stringify(cliGet).slice(0, 200))
const cliSet = await hit('/api/dsh-pixmax-workflow/cli/set', 'POST', { home: join(root, 'custom-cli'), environment: 'global' })
check('POST cli set', cliSet.status === 200 && cliSet.body.home === join(root, 'custom-cli') && cliSet.body.environment === 'global', JSON.stringify(cliSet).slice(0, 200))
const cliBad = await hit('/api/dsh-pixmax-workflow/cli/set', 'POST', { environment: 'mars' })
check('POST cli rejects bad env', cliBad.status === 400, JSON.stringify(cliBad).slice(0, 160))
await hit('/api/dsh-pixmax-workflow/cli/set', 'POST', { home: '', environment: '' })
check('POST cli reset', (await hit('/api/dsh-pixmax-workflow/cli', 'GET')).body.configured === false)

// ---------- credit-spending policy ----------
const creditGet = await hit('/api/dsh-pixmax-workflow/credit', 'GET')
check('GET credit default off', creditGet.status === 200 && creditGet.body.allowCreditTasks === false, JSON.stringify(creditGet))
const creditOn = await hit('/api/dsh-pixmax-workflow/credit/set', 'POST', { allowCreditTasks: true })
check('POST credit enable', creditOn.status === 200 && creditOn.body.allowCreditTasks === true)
check('GET credit reflects enable', (await hit('/api/dsh-pixmax-workflow/credit', 'GET')).body.allowCreditTasks === true)
const creditBad = await hit('/api/dsh-pixmax-workflow/credit/set', 'POST', { allowCreditTasks: 'yes' })
check('POST credit rejects non-boolean', creditBad.status === 400, JSON.stringify(creditBad))
await hit('/api/dsh-pixmax-workflow/cli/set', 'POST', { home: '', environment: '' })
check('cli set preserves credit policy', (await hit('/api/dsh-pixmax-workflow/credit', 'GET')).body.allowCreditTasks === true)
const creditOff = await hit('/api/dsh-pixmax-workflow/credit/set', 'POST', { allowCreditTasks: false })
check('POST credit disable', creditOff.body.allowCreditTasks === false)
check('GET credit reflects disable', (await hit('/api/dsh-pixmax-workflow/credit', 'GET')).body.allowCreditTasks === false)

// ---------- tools ----------
const imageTools = await import('../src/image-tools.mjs')
imageTools.apply(makeCtx(), { root })
const videoTools = await import('../src/video-tools.mjs')
videoTools.apply(makeCtx(), { root })
const pixTools = await import('../src/pixmax-tools.mjs')
pixTools.apply(makeCtx(), { root })
const names = registeredTools.map((tool) => tool.name)
check('tools: seven registered', names.length === 7, names.join(','))
check('tools: names', ['image_generation', 'model_list', 'pixmax', 'video_probe', 'video_frames', 'video_scenes', 'video_sheet'].every((n) => names.includes(n)), names.join(','))
check('tools: api_key removed', !names.includes('api_key'))
const image = registeredTools.find((tool) => tool.name === 'image_generation')
check('image_generation: model param', Boolean(image.parameters.properties.model) && !image.parameters.properties.channel)
check('image_generation: prompt required', JSON.stringify(image.parameters.required) === JSON.stringify(['prompt']), JSON.stringify(image.parameters.required))
const listTool = registeredTools.find((tool) => tool.name === 'model_list')
const listed = await listTool.execute({}, {})
check('model_list: default', listed.default === 'openai/gpt-image-1', listed.default)
check('model_list: models', listed.models.length === 2 && listed.models.every((m) => m.key), JSON.stringify(listed.models.map((m) => m.id)))
const browserModel = listed.models.find((m) => m.id === 'browser/gpt-image-2')
check('model_list: browser needs no key', browserModel && browserModel.key.source === 'browser')
check('model_list: render', listTool.output.render({}, listed)[0].text.includes('openai/gpt-image-1'))

// ---------- client ----------
const { readFileSync } = await import('node:fs')
const clientSource = readFileSync(new URL('../client/pixmax-workflow-settings.js', import.meta.url), 'utf8')
check('client: loader id', clientSource.includes("id: 'dsh-pixmax-workflow'"))
check('client: row key', clientSource.includes("key: 'dsh-pixmax-workflow#image-tools'"))
check('client: bundle key', clientSource.includes("key: 'dsh-pixmax-workflow'"))
check('client: bridge prefix', clientSource.includes("'/api/dsh-pixmax-workflow'"))
check('client: pixmax-tools row key', clientSource.includes("key: 'dsh-pixmax-workflow#pixmax-tools'"))
check('client: cli config card', clientSource.includes('CliConfigCard') && clientSource.includes("'/cli/set'"))
check('client: credit switch', clientSource.includes('允许执行消耗 Pixmax 积分的任务') && clientSource.includes("'/credit/set'"))

// ---------- skill_install ----------
check('pixmax: skill install export', typeof pix.copySkillInto === 'function')
const skillTarget = join(root, 'skills-test', 'pixmax-cli')
const cliRoot = join(root, 'fake-cli')
mkdirSync(join(cliRoot, 'pixmax', 'skills', 'references'), { recursive: true })
writeFileSync(join(cliRoot, 'pixmax', 'skills', 'SKILL.md'), '---\nname: pixmax-cli\n---\nbody\n', 'utf8')
writeFileSync(join(cliRoot, 'pixmax', 'skills', 'references', 'gen.md'), 'refs\n', 'utf8')
writeFileSync(join(cliRoot, 'pixmax', 'README.md'), 'readme\n', 'utf8')
writeFileSync(join(cliRoot, 'PIXMAX.md'), 'pixmax\n', 'utf8')
const copied = pix.copySkillInto(cliRoot, skillTarget)
check('skill: copied count', copied.copied.length === 4, JSON.stringify(copied.copied))
check('skill: SKILL.md at root', existsSync(join(skillTarget, 'SKILL.md')))
check('skill: references copied', existsSync(join(skillTarget, 'references', 'gen.md')))
check('skill: docs copied', existsSync(join(skillTarget, 'PIXMAX.md')) && existsSync(join(skillTarget, 'README.md')))
const pixmaxDef = registeredTools.find((tool) => tool.name === 'pixmax')

// The real CLI may or may not be installed on this machine. Both outcomes are
// valid; what matters is that a missing CLI returns install guidance.
const installResult = await pixmaxDef.execute({ action: 'skill_install', out: skillTarget }, {})
check(
  'skill_install: success or install guidance',
  installResult.ok === true || (installResult.hint || '').includes('Pixmax CLI 未就绪'),
  JSON.stringify(installResult).slice(0, 200),
)

// ---------- model-facing hints ----------
const noAction = await pixmaxDef.execute({}, {})
check('pixmax: action required', noAction.ok === false, noAction.text)
check('pixmax: no-action hints skill', (noAction.hint || '').includes('pixmax-cli 技能'), noAction.hint)

// ---------- node_update params merge (CLI replaces params wholesale) ----------
const paramSet = pix.paramEntries({
  nodeType: 'GENERATE_VIDEO',
  prompt: 'x',
  model: 'PIXDANCE_2',
  duration: 15,
  includeAudio: true,
  nested: { a: 1 },
  empty: null,
})
check(
  'paramEntries: skips nodeType/prompt',
  !paramSet.some((entry) => entry.startsWith('nodeType=') || entry.startsWith('prompt=')),
  paramSet.join(','),
)
check(
  'paramEntries: scalars become k=v',
  paramSet.includes('duration=15') && paramSet.includes('includeAudio=true') && paramSet.includes('model=PIXDANCE_2'),
  paramSet.join(','),
)
check(
  'paramEntries: drops objects and null',
  !paramSet.some((entry) => entry.startsWith('nested=') || entry.startsWith('empty=')),
  paramSet.join(','),
)
check(
  'paramEntries: honours skipKeys',
  !pix.paramEntries({ model: 'a', duration: 1 }, new Set(['model'])).some((entry) => entry.startsWith('model=')),
)
const missingSelector = await pixmaxDef.execute({ action: 'node_get' }, {})
check('pixmax: missing selector hints skill', missingSelector.ok === false && (missingSelector.hint || '').includes('pixmax-cli 技能'), missingSelector.text)
const unknownAction = await pixmaxDef.execute({ action: 'not_an_action' }, {})
check('pixmax: unknown action hints skill', unknownAction.ok === false && (unknownAction.hint || '').includes('pixmax-cli 技能'), unknownAction.text)
const blockedAction = await pixmaxDef.execute({ command: ['tasks', 'submit-batch'] }, {})
check('pixmax: blocked command hints skill', blockedAction.ok === false && (blockedAction.hint || '').includes('pixmax-cli 技能'), blockedAction.text)
try {
  pix.guardArgv(['tasks', 'submit-batch'])
  check('pixmax: guard throws UsageError', false)
} catch (error) {
  check('pixmax: guard throws UsageError', error?.usage === true, String(error))
}

// A configured-but-absent CLI home must produce install + login guidance.
const missingCtx = makeCtx()
pixTools.apply(missingCtx, { root, pixmaxHome: join(root, 'definitely-no-cli') })
const missingDef = registeredTools[registeredTools.length - 1]
const missingRes = await missingDef.execute({ action: 'doctor' }, {})
check(
  'pixmax: missing CLI returns install guidance',
  missingRes.ok === false && (missingRes.hint || '').includes('Pixmax CLI 未就绪') && (missingRes.hint || '').includes('install.ps1') && (missingRes.hint || '').includes('auth login'),
  JSON.stringify(missingRes).slice(0, 200),
)
check('pixmax: render includes guidance', missingDef.output.render({}, missingRes)[0].text.includes('操作引导'))

// Cordis passes `null` for rows whose YAML `config:` is empty. Registration
// must never dereference it — that was the real-machine crash.
const nullCtx = makeCtx()
let nullError = null
try {
  imageTools.apply(nullCtx, null)
  videoTools.apply(nullCtx, null)
  host.apply(nullCtx, null)
  pixTools.apply(nullCtx, null)
} catch (error) {
  nullError = error
}
check('apply: null config does not throw', nullError === null, String(nullError))

// The CLI home saved from the settings card must reach resolvePixmax.
await hit('/api/dsh-pixmax-workflow/cli/set', 'POST', { home: join(root, 'card-cli-home') })
const cardCtx = makeCtx()
pixTools.apply(cardCtx, { root })
const cardDef = registeredTools[registeredTools.length - 1]
const cardRes = await cardDef.execute({ action: 'doctor' }, {})
check('pixmax: card CLI path is used', cardRes.ok === false && (cardRes.text || '').includes('card-cli-home'), cardRes.text)
await hit('/api/dsh-pixmax-workflow/cli/set', 'POST', { home: '', environment: '' })

// ---------- bundle composition: tools only in the bundled preset ----------
const rootPatchText = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const presetPatchText = readFileSync(new URL('../presets/ai-video-workflow.patch.yml', import.meta.url), 'utf8')
const rootIds = [...rootPatchText.matchAll(/^\s*- id:\s*(\S+)/gm)].map((match) => match[1])
check('root patch: bundle row only', rootIds.length === 1 && rootIds[0] === 'pixmax-workflow', rootIds.join(','))
check(
  'root patch: no tool rows',
  !/dsh-pixmax-workflow\/(image|video|pixmax)/.test(rootPatchText),
)
check(
  'preset patch: three tool rows',
  ['image', 'video', 'pixmax'].every((part) => presetPatchText.includes(`dsh-pixmax-workflow/${part}`)),
)

// ---------- browser channel: pick the composer file input, not the first one ----------
const chatgptSource = readFileSync(new URL('../src/chatgpt.mjs', import.meta.url), 'utf8')
check(
  'chatgpt: no bare input[type=file] selector',
  !/querySelector\(\s*['"]input\[type=file\]['"]\s*\)/.test(chatgptSource),
)
check('chatgpt: picks input by accept+multiple', chatgptSource.includes('data-dsh-upload') && chatgptSource.includes('multi'))
check('chatgpt: counts thumbnails against a baseline', chatgptSource.includes('baseline + files.length'))
check('chatgpt: aborts when attachments vanish', chatgptSource.includes('attachment_lost'))
check('chatgpt: scopes upload to visible composer', chatgptSource.includes("composer.closest('form')"))
check('chatgpt: waits for send button to enable', chatgptSource.includes('发送按钮持续不可用'))

console.log(JSON.stringify({ pass: pass.length, fail: fail.length, failures: fail }, null, 2))
if (fail.length) process.exitCode = 1



// 浏览器半自检：用最小的 ModuleLoader 假实现执行 lib/client.js，
// 验证它能注册、导出 apply/inject，并且 apply 会在三个入口槽位注册组件。
// 不做 DOM/视觉验证 —— 只验证「注册契约」这一层。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) failures++
}

// ── 假 React + 假 require ────────────────────────────────────────────────
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? undefined : init, () => {}],
  useRef: (init) => ({ current: init }),
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const modules = { react: React }

const captured = {}
globalThis.window = {
  __ModuleLoader__: {
    load: (spec) => {
      captured.id = spec.id
      captured.exports = spec.factory((name) => {
        if (!(name in modules)) throw new Error(`unexpected require: ${name}`)
        return modules[name]
      })
    },
  },
}

// 直接执行文件（它引用的是 window.__ModuleLoader__ 这个浏览器全局）。
;(0, eval)(src)

check('模块 id 等于包名', captured.id === 'dsh-local-app', String(captured.id))
check('导出 apply', typeof captured.exports?.apply === 'function')
check('导出 inject', Array.isArray(captured.exports?.inject), JSON.stringify(captured.exports?.inject))
check('inject 含 slots / locale',
  captured.exports?.inject?.includes('slots') && captured.exports?.inject?.includes('locale'))
check('导出 PANEL_ID', typeof captured.exports?.PANEL_ID === 'string', captured.exports?.PANEL_ID)
check('导出 BUNDLE_NAME', captured.exports?.BUNDLE_NAME === 'dsh-local-app', captured.exports?.BUNDLE_NAME)

// ── 跑一遍 apply，记录槽位注册 ────────────────────────────────────────────
const registered = []
const slots = {
  inject: (name, cb) => {
    const before = registered.length
    cb()
    for (const entry of registered.slice(before)) entry.slot = name
  },
  register: (spec, component) => {
    registered.push({ spec: { ...spec }, component })
    return () => {}
  },
}
const locale = {
  register: () => () => {},
  bind: (ns) => (key) => `${ns}.${key}`,
}
const ctx = {
  effect: (fn) => { fn() },
  locale,
  slots,
}

captured.exports.apply(ctx)

const bySlot = (name) => registered.filter((entry) => entry.slot === name)
check('注册了 plugins.bundle.config（插件配置页入口）', bySlot('plugins.bundle.config').length === 1)
check('  key 等于包名', bySlot('plugins.bundle.config')[0]?.spec.key === 'dsh-local-app')
check('注册了 main（主面板）', bySlot('main').length === 1)
check('注册了 sidebar.panellist（侧栏入口）', bySlot('sidebar.panellist').length === 1)
check('  侧栏行 id 与 main 的 key 一致',
  bySlot('sidebar.panellist')[0]?.spec.id === bySlot('main')[0]?.spec.key,
  `${bySlot('sidebar.panellist')[0]?.spec.id} vs ${bySlot('main')[0]?.spec.key}`)
check('  侧栏行带 label()', typeof bySlot('sidebar.panellist')[0]?.spec.label === 'function')
check('注册了 settings.general.item（设置页入口）', bySlot('settings.general.item').length === 1)
check('每个注册都带 locale', registered.every((entry) => typeof entry.spec.locale === 'string'))
check('每个注册都带组件', registered.every((entry) => entry.component !== undefined))

console.log(`\n槽位注册明细：\n${registered.map((e) => `  ${e.slot}  ${JSON.stringify(e.spec)}`).join('\n')}`)
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exitCode = failures === 0 ? 0 : 1

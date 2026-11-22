/**
 * 插件管理页的配置区 —— 按模型配置 subagent 并发上限。
 *
 * 挂在 `plugins.bundle.config`（插件 → 本插件 → 配置），`key` 必须是本 bundle
 * 的包名：`dsh-client-ui-plugin-manager` 的 config-ledger 用
 * `ctx.slots.entries('plugins.bundle.config')` 的 `options.key` 决定哪些 bundle
 * 在插件管理页里出现「配置」区。
 *
 * 为什么不用 `settings.general.item`：那是全应用「设置 → 通用」的一排通用项，
 * 而这是**插件自己的**配置，归属插件管理页更准确（官方 voice-input / cua 同款）。
 *
 * 数据面走 host 侧注册的 `/subagent-model-limit/api/config`
 *（as-one 的 `/as-one/api/*` 同款做法：DSH 的 settings RPC 只接受官方
 * namespace，第三方配置只能走自己的 HTTP 路由）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-subagent-model-limit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/subagent-model-limit/api/config'
    /** 本 bundle 的包名 —— `plugins.bundle.config` 的 key 必须与之一致。 */
    const BUNDLE = 'dsh-subagent-model-limit'

    /** 主题 token，跟随深浅色，不写死颜色。 */
    const S = {
      root: { fontSize: 14, color: 'var(--dsw-alias-text-primary)' },
      head: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
      title: { fontSize: 14, fontWeight: 600 },
      hint: { fontSize: 12, color: 'var(--dsw-alias-text-tertiary)', marginTop: 4 },
      button: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-secondary)',
        background: 'var(--dsw-alias-bg-elevated)',
        color: 'var(--dsw-alias-text-primary)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 13,
        cursor: 'pointer',
      },
      buttonPrimary: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        borderRadius: 6,
        padding: '4px 12px',
        fontSize: 13,
        cursor: 'pointer',
      },
      buttonDanger: {
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-secondary)',
        background: 'transparent',
        color: 'var(--dsw-alias-text-tertiary)',
        borderRadius: 6,
        padding: '2px 8px',
        fontSize: 12,
        cursor: 'pointer',
      },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: {
        textAlign: 'left',
        padding: '6px 8px',
        color: 'var(--dsw-alias-text-tertiary)',
        fontWeight: 500,
        borderBottom: '1px solid var(--dsw-alias-border-secondary)',
      },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 8px',
        fontSize: 13,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-secondary)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-text-primary)',
      },
      error: { color: 'var(--dsw-alias-text-danger, #d33)', fontSize: 12, marginTop: 8 },
      ok: { color: 'var(--dsw-alias-brand-primary)', fontSize: 12, marginTop: 8 },
      rowLine: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 },
    }

    function readConfig() {
      return fetch(API, { headers: { accept: 'application/json' } }).then((r) => r.json())
    }
    function saveConfig(body) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json())
    }

    /** 一行配额：provider / model / max / 删除。 */
    function LimitRow({ rule, index, onChange, onRemove }) {
      return h(
        'tr',
        null,
        h('td', { style: S.td },
          h('input', {
            style: S.input,
            value: rule.provider,
            placeholder: '* 表示全部',
            onChange: (e) => onChange(index, 'provider', e.target.value),
          })),
        h('td', { style: S.td },
          h('input', {
            style: S.input,
            value: rule.model,
            placeholder: '* 表示全部',
            onChange: (e) => onChange(index, 'model', e.target.value),
          })),
        h('td', { style: { ...S.td, width: 110 } },
          h('input', {
            style: S.input,
            type: 'number',
            min: 1,
            value: String(rule.max),
            onChange: (e) => onChange(index, 'max', e.target.value),
          })),
        h('td', { style: { ...S.td, width: 60, textAlign: 'right' } },
          h('button', { style: S.buttonDanger, onClick: () => onRemove(index) }, '删除')),
      )
    }

    /** 配置面板本体 —— 插件管理页里直接展开，不再套折叠。 */
    function SettingsPanel() {
      const [loading, setLoading] = React.useState(false)
      const [rules, setRules] = React.useState([{ provider: '*', model: '*', max: 4 }])
      const [defaultLimit, setDefaultLimit] = React.useState(4)
      const [countMainAgent, setCountMainAgent] = React.useState(false)
      const [effective, setEffective] = React.useState([])
      const [message, setMessage] = React.useState(null)

      const load = React.useCallback(() => {
        setLoading(true)
        readConfig()
          .then((res) => {
            if (!res || res.ok !== true) {
              setMessage({ kind: 'error', text: (res && res.error && res.error.message) || '读取配置失败' })
              return
            }
            const value = res.value || {}
            const list = Array.isArray(value.limits)
              ? value.limits
              : Object.entries(value.limits || {}).map(([key, max]) => {
                  const slash = String(key).indexOf('/')
                  return slash < 0
                    ? { provider: '*', model: String(key), max }
                    : { provider: String(key).slice(0, slash), model: String(key).slice(slash + 1), max }
                })
            setRules(list.length > 0 ? list : [{ provider: '*', model: '*', max: 4 }])
            setDefaultLimit(typeof value.defaultLimit === 'number' ? value.defaultLimit : 4)
            setCountMainAgent(value.countMainAgent === true)
            const live = value.effective && Array.isArray(value.effective.effective) ? value.effective.effective : []
            setEffective(live)
            setMessage(null)
          })
          .catch((e) => setMessage({ kind: 'error', text: String(e) }))
          .finally(() => setLoading(false))
      }, [])

      React.useEffect(() => { load() }, [load])

      const onChange = (index, field, value) => {
        setRules((prev) =>
          prev.map((rule, i) => {
            if (i !== index) return rule
            if (field === 'max') return { ...rule, max: Number(value) || 1 }
            return { ...rule, [field]: value }
          }),
        )
      }
      const onRemove = (index) => setRules((prev) => prev.filter((_, i) => i !== index))
      const onAdd = () => setRules((prev) => [...prev, { provider: '*', model: '*', max: 1 }])

      const onSave = () => {
        setLoading(true)
        saveConfig({ limits: rules, defaultLimit, countMainAgent })
          .then((res) => {
            if (!res || res.ok !== true) {
              setMessage({ kind: 'error', text: (res && res.error && res.error.message) || '保存失败' })
              return
            }
            setMessage({ kind: 'ok', text: '已保存。插件重新加载后生效。' })
            load()
          })
          .catch((e) => setMessage({ kind: 'error', text: String(e) }))
          .finally(() => setLoading(false))
      }

      const live = effective.length > 0
        ? effective.map((e) => `${e.key} ${e.used}/${e.limit}`).join('，')
        : '暂无模型在途'

      return h(
        'div',
        { style: S.root },
        h(
          'div',
          { style: S.head },
          h('div', null,
            h('div', { style: S.title }, '子代理并发上限'),
            h('div', { style: S.hint }, `按 provider / model 分别配置；当前占用：${live}`)),
          h('div', { style: { display: 'flex', gap: 8 } },
            h('button', { style: S.button, onClick: load, disabled: loading }, '重新读取'),
            h('button', { style: S.buttonPrimary, onClick: onSave, disabled: loading }, '保存')),
        ),
        h(
          'table',
          { style: S.table },
          h('thead', null,
            h('tr', null,
              h('th', { style: S.th }, 'Provider'),
              h('th', { style: S.th }, 'Model'),
              h('th', { style: S.th }, '最大子代理数'),
              h('th', { style: S.th }, ''))),
          h('tbody', null,
            rules.map((rule, index) => h(LimitRow, { key: index, rule, index, onChange, onRemove }))),
        ),
        h('div', { style: S.rowLine },
          h('button', { style: S.button, onClick: onAdd }, '+ 新增一行'),
          h('span', { style: S.hint }, '填 * 表示全部；匹配优先级：provider+model → provider/* → */model → */*')),
        h('div', { style: S.rowLine },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
            h('input', {
              type: 'checkbox',
              checked: countMainAgent,
              onChange: (e) => setCountMainAgent(e.target.checked),
            }),
            '主会话占用模型时也计数（只占名额，不拦截主会话）')),
        h('div', { style: S.rowLine },
          h('span', { style: S.hint }, '未命中任何规则的模型使用'),
          h('input', {
            style: { ...S.input, width: 70 },
            type: 'number',
            min: 1,
            value: String(defaultLimit),
            onChange: (e) => setDefaultLimit(Number(e.target.value) || 1),
          }),
          h('span', { style: S.hint }, '个')),
        message ? h('div', { style: message.kind === 'error' ? S.error : S.ok }, message.text) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(
          'plugins.bundle.config',
          () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: BUNDLE },
              SettingsPanel,
            ),
        )
      },
    }
  },
})

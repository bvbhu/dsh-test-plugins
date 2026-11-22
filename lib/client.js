window.__ModuleLoader__.load({
  id: 'dsh-local-app',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    // ── 常量 ──────────────────────────────────────────────────────────────
    /** 本 bundle 的 npm 包名 —— 插件配置页按这个 key 匹配我们这一行。 */
    var BUNDLE_NAME = 'dsh-local-app'
    /** 侧栏行与主面板共用的 id。 */
    var PANEL_ID = 'local-app'
    /** 侧栏行序位：排在官方全局面板之后。 */
    var PANEL_ORDER = 40
    /** 本插件的 locale 命名空间。 */
    var NS = 'localApp'
    /** 未就绪时的轮询间隔（对齐 billion-context 的节奏）。 */
    var POLL_FAST_MS = 3000
    /** 已就绪后的慢轮询间隔。 */
    var POLL_SLOW_MS = 10000

    var zh = {
      nav: '本地应用',
      title: '本地应用',
      hint: '启动本地指定进程，抓取它输出里的地址，并在这里渲染该页面。',
      start: '启动',
      stop: '停止',
      restart: '重启',
      open: '在新标签页打开',
      starting: '正在启动…',
      ready: '运行中',
      adopted: '外部运行中',
      adoptedHint: '服务由外部启动，本插件只接管渲染，不会关闭它。',
      idle: '未启动',
      failed: '启动失败',
      launching: '正在启动进程…',
      readying: '等待服务应答…',
      probing: '正在探测…',
      exited: '已退出',
      noUrl: '尚未获得页面地址',
      unreachable: '页面地址不可达。若你从局域网设备访问，127.0.0.1 指的是该设备自身。',
      iframe: '内嵌渲染',
    }
    var en = {
      nav: 'Local app',
      title: 'Local app',
      hint: 'Start a local process, capture the URL it prints, and render that page here.',
      start: 'Start',
      stop: 'Stop',
      restart: 'Restart',
      open: 'Open in new tab',
      starting: 'Starting…',
      ready: 'Running',
      adopted: 'Externally running',
      adoptedHint: 'The service was started elsewhere; this plugin only renders it and will not stop it.',
      idle: 'Not started',
      failed: 'Start failed',
      launching: 'Launching process…',
      readying: 'Waiting for the service to answer…',
      probing: 'Probing…',
      exited: 'Exited',
      noUrl: 'No page URL yet',
      unreachable: 'The page URL is unreachable. From a LAN device, 127.0.0.1 means that device itself.',
      iframe: 'Embedded',
    }

    var PHASE_KEYS = {
      idle: 'idle',
      probing: 'probing',
      launching: 'launching',
      readying: 'readying',
      ready: 'ready',
      adopted: 'adopted',
      exited: 'exited',
      failed: 'failed',
    }

    // ── API ───────────────────────────────────────────────────────────────
    /**
     * 所有请求都用**文档相对**路径：DSH 服务的 index 带 `<base href="./">`，
     * 根绝对路径（/lapp/api/...）在带前缀的代理后面会 404。
     */
    async function post(method, body) {
      var res = await fetch('lapp/api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      var json = await res.json()
      if (!json || json.ok !== true) {
        var error = (json && json.error) || 'request failed'
        throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
      }
      return json.value
    }

    // ── 样式（只用主题无关的透明/半透明描边，跟随宿主文字色） ──────────────
    var button = {
      cursor: 'pointer',
      borderRadius: 8,
      border: '1px solid rgba(127,127,127,0.4)',
      background: 'transparent',
      color: 'inherit',
      fontFamily: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      padding: '4px 12px',
      whiteSpace: 'nowrap',
    }
    var muted = { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6 }

    function el(type, props) {
      var children = [].slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    // ── 共享 hook：轮询状态 ───────────────────────────────────────────────
    function useStatus() {
      var state = React.useState(null)
      var status = state[0]
      var setStatus = state[1]
      var busy = React.useState(false)
      var setBusy = busy[1]
      var failure = React.useState('')
      var setFailure = failure[1]
      var alive = React.useRef(true)

      React.useEffect(function () {
        alive.current = true
        var timer
        var stopped = false
        var tick = async function () {
          try {
            var value = await post('status', {})
            if (stopped) return
            setStatus(value)
            setFailure('')
          } catch (err) {
            if (!stopped) setFailure(err instanceof Error ? err.message : String(err))
          }
          if (stopped) return
          var ready = status && (status.phase === 'ready' || status.phase === 'adopted')
          timer = setTimeout(tick, ready ? POLL_SLOW_MS : POLL_FAST_MS)
        }
        tick()
        return function () {
          stopped = true
          alive.current = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      var act = React.useCallback(async function (method) {
        setBusy(true)
        try {
          var value = await post(method, {})
          setStatus(value)
          setFailure('')
        } catch (err) {
          setFailure(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [])

      return { status: status, busy: busy[0], failure: failure[0], act: act }
    }

    // ── 工具条 ────────────────────────────────────────────────────────────
    function Toolbar(props) {
      var t = props.t
      var status = props.status
      var phase = (status && status.phase) || 'idle'
      var owned = status ? status.owned !== false : false
      var label = t(PHASE_KEYS[phase] || 'idle')
      var behind = props.busy
      return el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
        el('span', { style: { fontSize: 13, fontWeight: 600 } }, label),
        phase === 'adopted' ? null : el('button', {
          type: 'button', disabled: behind || phase === 'launching' || phase === 'readying' || phase === 'probing',
          onClick: function () { props.act('start') }, style: behind ? Object.assign({}, button, { opacity: 0.5 }) : button,
        }, t('start')),
        owned ? el('button', {
          type: 'button', disabled: behind,
          onClick: function () { props.act('stop') }, style: behind ? Object.assign({}, button, { opacity: 0.5 }) : button,
        }, t('stop')) : null,
        el('button', {
          type: 'button', disabled: behind,
          onClick: function () { props.act('restart') }, style: behind ? Object.assign({}, button, { opacity: 0.5 }) : button,
        }, t('restart')),
        status && status.url ? el('button', {
          type: 'button', title: status.url,
          onClick: function () { window.open(status.url, '_blank', 'noopener,noreferrer') }, style: button,
        }, t('open')) : null
      )
    }

    // ── 面板主体 ──────────────────────────────────────────────────────────
    function Panel(props) {
      var t = props.t
      var view = useStatus()
      var status = view.status
      var config = (status && status.config) || {}
      var phase = (status && status.phase) || 'idle'
      var height = config.panelHeight || 'min(720px, 82vh)'
      var newTab = config.openInNewTab === true

      var body
      if (newTab) {
        body = status && status.url
          ? el('button', {
              type: 'button', onClick: function () { window.open(status.url, '_blank', 'noopener,noreferrer') },
              style: Object.assign({}, button, { fontSize: 14, lineHeight: '22px', padding: '7px 16px' }),
            }, t('open'))
          : el('p', { style: muted }, t('noUrl'))
      } else if (status && status.url) {
        body = el('iframe', {
          src: status.url,
          title: t('title'),
          style: {
            display: 'block', width: '100%', height: height,
            border: '1px solid rgba(127,127,127,0.4)', borderRadius: 8, background: 'transparent',
          },
        })
      } else if (phase === 'failed') {
        body = el('p', { style: muted }, (status && status.error) || t('failed'))
      } else {
        body = el('p', { style: muted }, t('noUrl'))
      }

      return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, padding: props.titled ? '20px 8px' : 0 } },
        props.titled ? el('h3', { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t('title')) : null,
        el(Toolbar, { t: t, status: status, busy: view.busy, act: view.act }),
        phase === 'adopted' ? el('p', { style: muted }, t('adoptedHint')) : null,
        body,
        view.failure ? el('p', { style: Object.assign({}, muted, { color: 'inherit' }) }, view.failure) : null,
        el('p', { style: muted }, t('hint'))
      )
    }

    /** 侧栏行的图标：侧栏自己拥有按钮、文字与选中态。 */
    function PanelIcon() {
      return el('svg', {
        viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        el('rect', { x: 2, y: 4, width: 20, height: 14, rx: 2 }),
        el('path', { d: 'M8 21h8' })
      )
    }

    // ── 插件体 ────────────────────────────────────────────────────────────
    var inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, 'dsh-local-app: dictionaries')

      var t = ctx.locale.bind(NS)

      // 入口 ①：插件配置页（Plugins 页面里本 bundle 的详情页，key = 包名）。
      ctx.slots.inject('plugins.bundle.config', function () {
        return ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE_NAME, locale: NS }, function () {
          return React.createElement(Panel, { t: t, titled: false })
        })
      })

      // 入口 ②：侧栏行 + 它选中的全局主面板。
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, function () {
          return React.createElement(Panel, { t: t, titled: true })
        })
      })
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER,
          label: function () { return t('nav') }, locale: NS,
        }, PanelIcon)
      })

      // 入口 ③：设置页「常规」区的一行（只给状态与开关，不给 iframe —— 那里是单行容器）。
      ctx.slots.inject('settings.general.item', function () {
        return ctx.slots.register({ name: 'settings.general.item', id: 'local-app', order: 900, locale: NS },
          function () {
            var view = useStatus()
            var status = view.status
            var phase = (status && status.phase) || 'idle'
            var owned = status ? status.owned !== false : false
            return el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              el('span', { style: { fontSize: 13, fontWeight: 600 } }, t(PHASE_KEYS[phase] || 'idle')),
              phase === 'adopted' ? null : el('button', {
                type: 'button', disabled: view.busy, style: button,
                onClick: function () { view.act('start') },
              }, t('start')),
              owned ? el('button', {
                type: 'button', disabled: view.busy, style: button,
                onClick: function () { view.act('stop') },
              }, t('stop')) : null,
              status && status.url ? el('button', {
                type: 'button', title: status.url, style: button,
                onClick: function () { window.open(status.url, '_blank', 'noopener,noreferrer') },
              }, t('open')) : null,
              view.failure ? el('span', { style: { fontSize: 12, opacity: 0.7 } }, view.failure) : null
            )
          })
      })
    }

    exports.inject = inject
    exports.apply = apply
    exports.NS = NS
    exports.PANEL_ID = PANEL_ID
    exports.BUNDLE_NAME = BUNDLE_NAME
    return module.exports
  },
})

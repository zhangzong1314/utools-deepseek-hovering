// DeepSeek 悬浮助手 —— 开发自检
//
// 跑法：npm run check      （纯 Node，不联网、不写盘、不开 GUI）
//
// 它管两类事：
//   1. 静态的：plugin.json 合法、plugin/ 下每个 .js 与 HTML 内联脚本语法能编译、
//      HTML 里的本地引用都在、几处"必须两边一致"的字面量没走偏、旧机制没有残留；
//   2. 跑一遍的：用桩件把 plugin/preload.js 真跑起来，模拟
//      「进入插件 → 开球 → 点球开关对话窗 → 选中文字提问 → 地址/尺寸回流 → 快捷键三态」，
//      再把 page/chat-host.js 放进假 DOM 里跑，断言它给 webview 设了什么、报了什么。
//
// 故意不做的：GUI 里才看得出来的一切（官网到底能不能渲染、粘贴落没落到输入框）。
// 那部分只能照 README 的验收清单人工过。

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'plugin')

const SITE = 'https://chat.deepseek.com/'
const ASK_CODES = ['ask', 'translate', 'genvarname', 'summarize', 'summarizeUrl']

const checks = []
const failures = []
let passed = 0

/** 登记一条断言。fn 返回 true 通过，返回字符串就是失败原因（可以是 async） */
function check(name, fn) {
  checks.push({ name: name, fn: fn })
}

async function runAll() {
  for (const item of checks) {
    let result
    try {
      result = await item.fn()
    } catch (e) {
      failures.push(item.name + ' —— 抛异常：' + ((e && e.stack) || e))
      continue
    }
    if (result === true) passed++
    else failures.push(item.name + ' —— ' + (typeof result === 'string' ? result : '断言没通过'))
  }
}

function section(title) {
  console.log('\n' + title)
}

const readFile = (p) => fs.readFileSync(p, 'utf8')
const pluginFile = (rel) => path.join(PLUGIN, rel)
const readPlugin = (rel) => readFile(pluginFile(rel))
const exists = (p) => fs.existsSync(p)
const rel = (p) => path.relative(ROOT, p)

function walk(dir, out) {
  const acc = out || []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else acc.push(full)
  }
  return acc
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

const files = walk(PLUGIN)
const manifest = JSON.parse(readPlugin('plugin.json'))
const feature = (code) => (manifest.features || []).filter((f) => f.code === code)[0]

// ---------------------------------------------------------------- plugin.json

function checkManifest() {
  section('plugin.json')

  check('pluginName / version 已填', () =>
    (manifest.pluginName && typeof manifest.pluginName === 'string' ? true : 'pluginName 缺失') &&
    (/^\d+\.\d+\.\d+$/.test(manifest.version) ? true : 'version 不是 x.y.z：' + manifest.version))

  for (const field of ['main', 'preload', 'logo']) {
    check(field + ' 指向的文件存在（' + manifest[field] + '）', () =>
      exists(pluginFile(manifest[field])) ? true : '找不到 plugin/' + manifest[field])
  }

  check('feature 的 code 不重复', () => {
    const codes = (manifest.features || []).map((f) => f.code)
    return new Set(codes).size === codes.length ? true : '有重复：' + codes.join(', ')
  })

  check('feature 的 code 集合就是预期的那 7 条', () => {
    const want = ['deepseek', 'deepseek-window'].concat(ASK_CODES).sort()
    const got = (manifest.features || []).map((f) => f.code).sort()
    return want.join(',') === got.join(',') ? true : '实际是 ' + got.join(', ')
  })

  check('每条 feature 的 cmds 都是 1~5 项', () =>
    (manifest.features || []).every((f) => Array.isArray(f.cmds) && f.cmds.length >= 1 && f.cmds.length <= 5)
      ? true : 'uTools 限制每条 feature 最多 5 个 cmds')

  check('deepseek 这条没有 mainHide（搜索框进来要看得见面板）', () =>
    feature('deepseek') && !feature('deepseek').mainHide ? true : 'deepseek 被加了 mainHide，面板就不显示了')

  check('deepseek-window 带 mainHide（快捷键进来不闪主窗口）', () =>
    feature('deepseek-window') && feature('deepseek-window').mainHide === true ? true : '缺 mainHide')

  for (const code of ASK_CODES) {
    check(code + ' 带 mainHide（划词进来不弹面板）', () =>
      feature(code) && feature(code).mainHide === true ? true : '缺 mainHide')
  }

  check('四条 over 指令的 type/length/label 齐备', () => {
    for (const code of ['ask', 'translate', 'genvarname', 'summarize']) {
      const cmd = (feature(code).cmds || [])[0]
      if (!cmd || cmd.type !== 'over') return code + ' 的第一条 cmd 不是 over'
      if (typeof cmd.minLength !== 'number' || typeof cmd.maxLength !== 'number' || !cmd.label) {
        return code + ' 的 over 没写全 minLength/maxLength/label'
      }
    }
    return true
  })

  check('summarizeUrl 是 regex 指令', () => {
    const cmd = (feature('summarizeUrl').cmds || [])[0]
    return cmd && cmd.type === 'regex' && /^\/\^https\?/.test(cmd.match || '')
      ? true : 'summarizeUrl 的 cmd 不是预期的 regex'
  })
}

// ---------------------------------------------------------------- 静态文件

function checkSources() {
  section('静态文件')

  const bad = []
  for (const file of files) {
    if (!file.endsWith('.js')) continue
    try {
      new vm.Script(readFile(file), { filename: file })
    } catch (e) {
      bad.push(rel(file) + '：' + e.message)
    }
  }
  check('plugin/ 下每个 .js 都能编译', () => (bad.length ? bad.join('；') : true))

  const htmlFiles = files.filter((f) => f.endsWith('.html'))
  const inlineErrors = []
  for (const file of htmlFiles) {
    const html = readFile(file)
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = re.exec(html))) {
      try {
        new vm.Script(m[1], { filename: file })
      } catch (e) {
        inlineErrors.push(rel(file) + ' 的内联脚本：' + e.message)
      }
    }
  }
  check('每个 HTML 的内联脚本都能编译', () => (inlineErrors.length ? inlineErrors.join('；') : true))

  const missingRefs = []
  for (const file of htmlFiles) {
    const html = readFile(file)
    const attrRe = /\b(?:src|href)="([^"]+)"/gi
    let m
    while ((m = attrRe.exec(html))) {
      const ref = m[1]
      if (/^(https?:)?\/\//.test(ref) || /^(data:|#|mailto:)/.test(ref)) continue
      const resolved = path.resolve(path.dirname(file), ref)
      if (!exists(resolved) || !resolved.startsWith(PLUGIN)) {
        missingRefs.push(rel(file) + ' → ' + ref)
      }
    }
  }
  check('HTML 里的本地引用都存在且在 plugin/ 内', () =>
    missingRefs.length ? missingRefs.join('；') : true)

  check('没有 .DS_Store 之类的垃圾文件', () =>
    files.some((f) => path.basename(f) === '.DS_Store') ? '有 .DS_Store' : true)
}

// ---------------------------------------------------------------- 接线（字面量绑定）

function checkWiring() {
  section('接线')

  const preloadSrc = readPlugin('preload.js')
  const windowsSrc = readPlugin('js/windows.js')
  const configSrc = readPlugin('js/config.js')
  const chatHtml = readPlugin('page/chat.html')
  const chatHost = readPlugin('page/chat-host.js')
  const chatPreload = readPlugin('page/chat-preload.js')

  check('preload 的 HOTKEY_FEATURE/HOTKEY_CMD 指向 plugin.json 里那条 mainHide 指令', () => {
    const code = (preloadSrc.match(/HOTKEY_FEATURE\s*=\s*'([^']+)'/) || [])[1]
    const cmd = (preloadSrc.match(/HOTKEY_CMD\s*=\s*'([^']+)'/) || [])[1]
    if (!code || !cmd) return 'preload.js 里读不到这两个字面量'
    const f = feature(code)
    if (!f) return 'plugin.json 里没有 code=' + code + ' 的 feature'
    if (!f.mainHide) return code + ' 没带 mainHide（快捷键进来会闪搜索框）'
    if (JSON.stringify(f.cmds).indexOf('"' + cmd + '"') === -1) {
      return code + ' 的 cmds 里没有「' + cmd + '」'
    }
    return true
  })

  check('preload 的 ASK_CODES 与 plugin.json 里的划词指令一致', () => {
    const m = preloadSrc.match(/ASK_CODES\s*=\s*\[([^\]]*)\]/)
    if (!m) return 'preload.js 里找不到 ASK_CODES'
    const codes = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
    const fromManifest = (manifest.features || [])
      .filter((f) => (f.cmds || []).some((c) => typeof c === 'object'))
      .map((f) => f.code)
      .sort()
    return codes.slice().sort().join(',') === fromManifest.join(',')
      ? true
      : '两处不一致：preload=[' + codes.join(', ') + '] plugin.json=[' + fromManifest.join(', ') + ']'
  })

  check('preload 在 onPluginEnter 里分派了提问与快捷键两条路', () =>
    (preloadSrc.indexOf('ASK_CODES.indexOf(action.code)') !== -1 ? true : '没看到提问的分派') &&
    (preloadSrc.indexOf('action.code === HOTKEY_FEATURE') !== -1 ? true : '没看到快捷键的分派'))

  check('windows.openChat 建的是 webview 宿主页，且开了 webviewTag / webSecurity', () => {
    const from = windowsSrc.indexOf('function openChat')
    const body = windowsSrc.slice(from, windowsSrc.indexOf('function toggleChat'))
    if (body.indexOf("createBrowserWindow('page/chat.html'") === -1) return 'openChat 没建 page/chat.html'
    if (body.indexOf('webviewTag: true') === -1) return 'openChat 少了 webviewTag: true'
    if (body.indexOf('webSecurity: false') === -1) return 'openChat 少了 webSecurity: false'
    if (body.indexOf("preload: 'page/chat-preload.js'") === -1) return 'openChat 少了宿主页的 preload'
    return true
  })

  check('宿主页的站点常量与父窗认可会话的域名一致', () => {
    // 会话地址的判定在 windows.js 的正则里，打开哪个站点在宿主页的 SITE 上 ——
    // 这两处必须指同一个域名，否则就成了"记得住、但下次开到别的地方去"。
    const site = (chatHost.match(/var SITE\s*=\s*'([^']+)'/) || [])[1]
    if (!site) return '宿主页里找不到 SITE'
    // 取整行里最后那个 / —— 正则里全是转义的 \/，不能用它当结束标记
    const re = (windowsSrc.match(/CONVERSATION_RE\s*=\s*(\/[^\n]*\/)/) || [])[1]
    if (!re) return 'windows.js 里找不到 CONVERSATION_RE'
    const host = site.replace(/^https:\/\//, '').replace(/\/$/, '').replace(/\./g, '\\.')
    return re.indexOf(host) !== -1 ? true : '宿主页开的是 ' + site + '，父窗认的却是 ' + re
  })

  check('存储键只在 js/config.js 里定义（页面侧不自己写键名）', () => {
    const keys = ['deepseek:lastChatUrl', 'deepseek:userToken', 'deepseek:chatSize', 'deepseek:ballPos']
    const offenders = []
    for (const key of keys) {
      if (configSrc.indexOf(key) === -1) offenders.push('config.js 里没有 ' + key)
      for (const pair of [['page/chat-host.js', chatHost], ['page/chat-preload.js', chatPreload]]) {
        if (pair[1].indexOf(key) !== -1) offenders.push(pair[0] + ' 里出现了字面量 ' + key)
      }
    }
    return offenders.length ? offenders.join('；') : true
  })

  check('宿主页的存储访问一律走 chatHost（不碰 utools 全局）', () => {
    if (/utools\s*\./.test(chatHost)) return 'page/chat-host.js 里直接用了 utools'
    return chatPreload.indexOf("require('../js/config')") !== -1 ? true : 'preload 没复用 js/config'
  })

  check('chat.html 是 webview 宿主（没有顶层导航）', () => {
    if (chatHtml.indexOf('<webview') === -1) return 'chat.html 里没有 <webview>'
    if (chatHtml.indexOf('location.replace(') !== -1) return 'chat.html 里还有 location.replace（旧的顶层导航）'
    if (chatHtml.indexOf('chat-host.js') === -1) return 'chat.html 没引页面脚本'
    return true
  })

  check('宿主页的几处关键接线都在', () => {
    const need = [
      ['window.dsChat', '父窗靠这个入口递提问'],
      ["setAttribute('userAgent'", 'UA 要设给 webview'],
      ['/ Electron\\/.*? /i', 'UA 里的 Electron 标记要去掉'],
      ['did-stop-loading', '加载完要知道'],
      ['did-navigate-in-page', 'SPA 切会话要走这条'],
      ['did-fail-load', '失败了要显兜底'],
      ['errorCode === -3', 'ERR_ABORTED 不能当失败'],
      ['chat:url', '地址要回报父窗'],
      ['chat:size', '尺寸要回报父窗'],
    ]
    const missing = need
      .filter((pair) => chatHost.indexOf(pair[0]) === -1)
      .map((pair) => pair[0] + '（' + pair[1] + '）')
    return missing.length ? '缺：' + missing.join('、') : true
  })

  check('JS 侧没有旧机制的残留', () => {
    const dead = ['chat:sri', 'chat:netfail', 'chat:trace', 'chat:nodeRepair', 'repairChat',
      'watchViaSession', 'watchViaDebugger', 'watchChatConsole', 'collectChatDiagnostics',
      'openChatDevTools', '__dsHelper', 'reloadChatIgnoringCache', '_sri-ck']
    const offenders = []
    for (const file of files.filter((f) => /\.(js|html)$/.test(f))) {
      const src = readFile(file)
      for (const token of dead) {
        if (src.indexOf(token) !== -1) offenders.push(rel(file) + ' 里还有 ' + token)
      }
    }
    return offenders.length ? offenders.join('；') : true
  })

  check('面板不再引用已删掉的排查入口', () => {
    const panel = readPlugin('page/panel.js')
    const dead = ['openChatDevTools', 'copyChatDiagnostics', 'copyTraceLog', 'setOpenIn', 'openInBrowser', 'debugHint']
    const left = dead.filter((token) => panel.indexOf(token) !== -1)
    return left.length ? 'panel.js 里还有 ' + left.join(', ') : true
  })
}

// ---------------------------------------------------------------- 图标指纹

function pngText(buf, keyword) {
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (type === 'tEXt') {
      const data = buf.slice(off + 8, off + 8 + len)
      const sep = data.indexOf(0)
      if (sep > 0 && data.toString('latin1', 0, sep) === keyword) {
        return data.toString('latin1', sep + 1)
      }
    }
    if (type === 'IEND') break
    off += 12 + len
  }
  return null
}

function checkIcon() {
  section('图标')

  check('assets/logo.png 是按当前 whale.svg 生成的', () => {
    const svg = readPlugin('assets/whale.svg')
    const m = svg.match(/<path[^>]*\sd="([^"]+)"/)
    if (!m) return 'assets/whale.svg 里读不到 <path d="…">'
    const now = crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 16)
    const stored = pngText(fs.readFileSync(pluginFile('assets/logo.png')), 'deepseek-whale')
    if (!stored) return 'logo.png 里没有 deepseek-whale 指纹块'
    return stored === now
      ? true
      : '指纹对不上（' + stored + ' ≠ ' + now + '）：改过 whale.svg 就跑一次 npm run icons'
  })
}

// ---------------------------------------------------------------- 运行时桩件

/**
 * 造一个假运行环境，把 plugin/preload.js 连同它 require 的模块真跑起来。
 *
 * 桩件只做三件事：把 utools 的调用记下来、把窗口做成可断言的对象、
 * 让 ipcRenderer.on 注册的通道能被测试手动触发。
 */
function createRuntime(options) {
  const opts = options || {}
  const state = {
    created: [],
    ipc: {},
    db: new Map(),
    jsQueue: (opts.jsQueue || []).slice(),
    jsCalls: [],
    hiddenMain: 0,
    redirected: [],
    pendingCallbacks: [],
  }

  function makeWindow(url, winOpts) {
    const o = winOpts || {}
    const win = {
      url: url,
      options: o,
      destroyed: false,
      visible: o.show !== false,
      focused: false,
      bounds: {
        x: typeof o.x === 'number' ? o.x : 0,
        y: typeof o.y === 'number' ? o.y : 0,
        width: o.width || 800,
        height: o.height || 600,
      },
      sent: [],
      hideCalls: 0,
      show() { win.visible = true; win.focused = true },
      hide() { win.visible = false; win.focused = false; win.hideCalls++ },
      focus() { win.focused = true },
      isVisible() { return win.visible },
      isFocused() { return win.focused },
      isDestroyed() { return win.destroyed },
      isMinimized() { return false },
      restore() {},
      close() { win.destroyed = true; win.visible = false },
      destroy() { win.destroyed = true; win.visible = false },
      getPosition() { return [win.bounds.x, win.bounds.y] },
      setPosition(x, y) { win.bounds.x = x; win.bounds.y = y },
      getBounds() { return Object.assign({}, win.bounds) },
      setBounds(b) { Object.assign(win.bounds, b) },
      setSize(w, h) { win.bounds.width = w; win.bounds.height = h },
      setResizable() {},
      setAlwaysOnTop() {},
      on() {},
      webContents: {
        executeJavaScript(code) {
          state.jsCalls.push(code)
          const next = state.jsQueue.length ? state.jsQueue.shift() : true
          return Promise.resolve(next)
        },
        send(channel, payload) { win.sent.push({ channel: channel, payload: payload }) },
        on() {},
        openDevTools() {},
      },
    }
    return win
  }

  const utools = {
    onPluginReady(fn) { state.ipc['plugin.ready'] = fn },
    onPluginEnter(fn) { state.ipc['plugin.enter'] = fn },
    onPluginOut(fn) { state.ipc['plugin.out'] = fn },
    createBrowserWindow(url, o, cb) {
      const win = makeWindow(url, o)
      state.created.push(win)
      if (typeof cb === 'function') {
        if (opts.callbackMode === 'sync') cb(win)
        else state.pendingCallbacks.push(() => cb(win))
      }
      return win
    },
    dbStorage: {
      getItem(k) { return state.db.has(k) ? state.db.get(k) : null },
      setItem(k, v) { state.db.set(k, v) },
      removeItem(k) { state.db.delete(k) },
    },
    getPrimaryDisplay() { return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } } },
    getDisplayNearestPoint() { return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } } },
    getCursorScreenPoint() { return { x: 100, y: 100 } },
    getCmdHotKey() { return '' },
    redirectHotKeySetting(cmd) { state.redirected.push(cmd) },
    hideMainWindow() { state.hiddenMain++ },
    showMainWindow() {},
    isDev() { return false },
    isDarkColors() { return false },
    isMacOS() { return false },
    copyText() {},
    simulateKeyboardTap() {},
    sendToParent() {},
    shellOpenExternal() {},
  }

  const electron = { ipcRenderer: { on(channel, fn) { state.ipc[channel] = fn } } }

  const sandboxWindow = {}
  const context = vm.createContext({
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    utools: utools,
    window: sandboxWindow,
    navigator: { userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Electron/34.5.8 Safari/537.36' },
    document: {},
    location: { href: 'file:///plugin/index.html' },
    Buffer: Buffer,
    Promise: Promise,
  })

  const cache = new Map()
  function loadModule(abs) {
    if (cache.has(abs)) return cache.get(abs).exports
    const module = { exports: {} }
    cache.set(abs, module)
    const dir = path.dirname(abs)
    const req = (spec) => {
      if (spec === 'electron') return electron
      if (spec.charAt(0) === '.') {
        return loadModule(path.resolve(dir, /\.js$/.test(spec) ? spec : spec + '.js'))
      }
      throw new Error('自检不加载外部包：' + spec)
    }
    const fn = vm.runInContext(
      '(function (module, exports, require, __filename, __dirname) {\n' + readFile(abs) + '\n})',
      context, { filename: abs })
    fn(module, module.exports, req, abs, dir)
    return module.exports
  }

  loadModule(pluginFile('preload.js'))

  return {
    state: state,
    host: sandboxWindow.deepseekHost,
    enter: (action) => state.ipc['plugin.enter'](action),
    fireIpc: (channel, payload) => {
      const fn = state.ipc[channel]
      if (!fn) throw new Error('没有注册这个通道：' + channel)
      return fn({}, payload)
    },
    flush: () => {
      const list = state.pendingCallbacks.slice()
      state.pendingCallbacks.length = 0
      list.forEach((fn) => fn())
    },
    windowByUrl: (url) => state.created.filter((w) => w.url === url),
  }
}

function checkRuntime() {
  section('运行链路（桩件）')

  check('进入插件：桌面出现悬浮球，面板拿到状态', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek', type: 'text' })
    rt.flush()
    const balls = rt.windowByUrl('page/ball.html')
    if (balls.length !== 1) return '没建出悬浮球窗（建了 ' + rt.state.created.length + ' 个窗）'
    if (!balls[0].visible) return '悬浮球窗没显示出来'
    const panel = rt.host.state()
    if (panel.ballVisible !== true) return '面板读到的状态不对：ballVisible=' + panel.ballVisible
    if (panel.chatOpen !== false) return '这时还不该有对话窗'
    return true
  })

  check('点悬浮球：第一次开窗（参数齐全），第二次收起来（hide 而不是销毁）', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek', type: 'text' })
    rt.fireIpc('ball:click')
    const chats = rt.windowByUrl('page/chat.html')
    if (chats.length !== 1) return '点球没开出对话窗'
    const chat = chats[0]
    const wp = chat.options.webPreferences || {}
    if (wp.webviewTag !== true) return 'webPreferences 里没有 webviewTag'
    if (wp.webSecurity !== false) return 'webPreferences 里没有 webSecurity:false'
    if (wp.preload !== 'page/chat-preload.js') return '宿主页的 preload 不对：' + wp.preload
    if (chat.options.minWidth !== 320 || chat.options.minHeight !== 400) return '最小尺寸没设'
    if (rt.state.hiddenMain === 0) return '开窗时没把 uTools 主窗口收起来'

    rt.fireIpc('ball:click')
    if (chat.hideCalls !== 1) return '第二次点球没有 hide（hideCalls=' + chat.hideCalls + '）'
    if (chat.destroyed) return '第二次点球把窗口销毁了 —— 关窗要 hide 复用'

    rt.fireIpc('ball:click')
    if (!chat.visible) return '第三次点球没把窗口再显示出来'
    return true
  })

  check('选中文字提问：把 code/payload 递进宿主页的 window.dsChat', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'translate', payload: 'hello world', type: 'over' })
    rt.flush()
    if (!rt.state.jsCalls.length) return '没有向窗口注入任何东西'
    const injected = rt.state.jsCalls[0]
    if (injected.indexOf('window.dsChat') === -1) return '注入的不是宿主页的入口：' + injected
    if (injected.indexOf('"code":"translate"') === -1) return '注入串里没有 code'
    if (injected.indexOf('"payload":"hello world"') === -1) return '注入串里没有 payload'
    const chat = rt.windowByUrl('page/chat.html')[0]
    if (!chat || !chat.visible) return '提问时没把对话窗摆出来'
    if (rt.state.hiddenMain === 0) return '提问时没把主窗口收起来'
    return true
  })

  check('注入时机不对会重试（宿主页还没加载完时不能把提问丢了）', async () => {
    // 前两次注入"没人接"（返回 undefined），第三次才成功
    const rt = createRuntime({ callbackMode: 'async', jsQueue: [undefined, undefined, true] })
    rt.enter({ code: 'ask', payload: 'hi', type: 'over' })
    rt.flush()
    if (rt.state.jsCalls.length !== 1) return '第一次注入的次数不对：' + rt.state.jsCalls.length
    await sleep(300)
    if (rt.state.jsCalls.length < 3) return '没有重试（只注入了 ' + rt.state.jsCalls.length + ' 次）'
    await sleep(200)
    if (rt.state.jsCalls.length > 3) return '第三下成功之后还在继续注入'
    return true
  })

  check('地址回流：记会话、回首页忘掉、路过别的页不动', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    const conv = SITE + 'a/chat/s/75e63fe1-08bc-4e0b-a957-270557e00482'
    rt.fireIpc('chat:url', conv + '#draft-1')
    if (rt.state.db.get('deepseek:lastChatUrl') !== conv) {
      return '会话地址没记住（存的是 ' + rt.state.db.get('deepseek:lastChatUrl') + '）'
    }
    rt.fireIpc('chat:url', SITE + 'sign_in')
    if (rt.state.db.get('deepseek:lastChatUrl') !== conv) return '路过登录页把已记住的会话冲掉了'
    rt.fireIpc('chat:url', 'https://example.com/x')
    if (rt.state.db.get('deepseek:lastChatUrl') !== conv) return '站外地址把已记住的会话冲掉了'
    rt.fireIpc('chat:url', SITE)
    if (rt.state.db.has('deepseek:lastChatUrl')) return '回到对话首页没把会话忘掉'
    return true
  })

  check('窗口缩放回流：尺寸夹取后落库', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.fireIpc('chat:size', { width: 3000, height: 3000 })
    const saved = JSON.parse(rt.state.db.get('deepseek:chatSize'))
    if (saved.height > 1080) return '高度没夹进屏幕可用区：' + saved.height
    if (saved.width > 1600) return '宽度没夹进上限：' + saved.width
    rt.fireIpc('chat:size', { width: 10, height: 10 })
    const small = JSON.parse(rt.state.db.get('deepseek:chatSize'))
    if (small.width !== 320 || small.height !== 400) return '没夹到最小尺寸：' + JSON.stringify(small)
    return true
  })

  check('面板改尺寸：当场改掉已经开着的窗口', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek', type: 'text' })
    rt.fireIpc('ball:click')
    const chat = rt.windowByUrl('page/chat.html')[0]
    const next = rt.host.setChatSize(700, 800)
    if (next.chatSize.width !== 700 || next.chatSize.height !== 800) {
      return '面板拿到的尺寸不对：' + JSON.stringify(next.chatSize)
    }
    if (chat.bounds.width !== 700 || chat.bounds.height !== 800) {
      return '活着的窗口没跟着改：' + chat.bounds.width + '×' + chat.bounds.height
    }
    return true
  })

  check('快捷键三态：开 → 调到最前 → 收起', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek-window', from: 'hotkey' })
    rt.flush()
    const chat = rt.windowByUrl('page/chat.html')[0]
    if (!chat) return '快捷键没开出对话窗'
    rt.enter({ code: 'deepseek-window', from: 'hotkey' })
    if (chat.hideCalls) return '窗口不在最前面时按快捷键不该关窗'
    if (!chat.focused) return '没把窗口调到最前面'
    rt.enter({ code: 'deepseek-window', from: 'hotkey' })
    if (chat.hideCalls !== 1) return '在最前面时按快捷键没关窗（hideCalls=' + chat.hideCalls + '）'
    return true
  })

  check('悬浮球拖拽会落库位置', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek', type: 'text' })
    rt.flush()
    const ball = rt.windowByUrl('page/ball.html')[0]
    rt.fireIpc('ball:dragStart')
    rt.fireIpc('ball:drag', { dx: 40, dy: 30 })
    rt.fireIpc('ball:dragEnd')
    const pos = JSON.parse(rt.state.db.get('deepseek:ballPos'))
    if (pos.x !== ball.bounds.x || pos.y !== ball.bounds.y) return '落库的位置和窗口实际位置不一致'
    return true
  })

  check('面板契约：用得上的元素都在，删掉的入口真的没了', () => {
    const html = readPlugin('index.html')
    const needed = ['chatBtn', 'ballDot', 'ballState', 'ballToggleBtn', 'sizeWidth', 'sizeHeight',
      'sizeHint', 'hotkeyValue', 'hotkeyHint']
    const missing = needed.filter((id) => html.indexOf('id="' + id + '"') === -1)
    if (missing.length) return 'index.html 少了 ' + missing.join(', ')
    const gone = ['debugHint', 'devtoolsBtn', 'netlogBtn', 'tracelogBtn', 'name="openin"']
    const left = gone.filter((token) => html.indexOf(token) !== -1)
    return left.length ? 'index.html 里还剩 ' + left.join(', ') : true
  })

  check('窗口创建回调同步触发时也走一遍（uTools 各版本时序不一致）', () => {
    const rt = createRuntime({ callbackMode: 'sync' })
    rt.enter({ code: 'deepseek', type: 'text' })
    const ball = rt.windowByUrl('page/ball.html')[0]
    return ball && ball.visible ? true : '同步回调这条路径下悬浮球没显示'
  })
}

// ---------------------------------------------------------------- 宿主页（沙箱）

/**
 * 把 page/chat-host.js 放进一套极简的假 DOM 里跑一遍。
 *
 * 只造它真正用到的东西：webview 元素（能 setAttribute / 收事件 / executeJavaScript）、
 * 几个 getElementById 的空壳、localStorage / sessionStorage、以及 chatHost 这个桥。
 * executeJavaScript 的返回值按探针里的关键字编排 —— 这套断言能成立就靠它。
 */
function createHostRuntime(options) {
  const opts = options || {}
  const events = {}
  const attrs = {}
  const executed = []
  const reported = []
  const copied = []
  const tokens = []
  const cleared = []
  const storage = new Map()
  const session = new Map()
  const elements = {}
  let reloads = 0
  let currentUrl = opts.url || ''

  if (opts.pageToken) storage.set('userToken', opts.pageToken)
  if (opts.sessionSeenApp) session.set('dsChatSeenApp', '1')

  const webview = {
    executeJavaScript(code) {
      executed.push(code)
      if (code.indexOf('aria-disabled') !== -1) return Promise.resolve(opts.generating === true)
      if (code.indexOf('querySelector("input[type=file]') !== -1) return Promise.resolve(opts.ready !== false)
      if (code.indexOf('location.pathname') !== -1) return Promise.resolve(opts.pathname || '/')
      if (code.indexOf('getItem("userToken")') !== -1) return Promise.resolve(storage.get('userToken') || null)
      if (code.indexOf('setItem("userToken"') !== -1) {
        const m = code.match(/setItem\("userToken",\s*("(?:[^"\\]|\\.)*")\)/)
        if (m) storage.set('userToken', JSON.parse(m[1]))
        return Promise.resolve(undefined)
      }
      if (code.indexOf('focus()') !== -1) return Promise.resolve(true)
      if (code.indexOf('.click()') !== -1) return Promise.resolve(true)
      return Promise.resolve(undefined)
    },
    setAttribute(k, v) { attrs[k] = v },
    getAttribute(k) { return attrs[k] },
    addEventListener(type, fn) { (events[type] = events[type] || []).push(fn) },
    focus() {},
    reload() { reloads++ },
    getURL() { return currentUrl },
    openDevTools() {},
  }

  const chatHost = {
    isDev() { return false },
    isDark() { return false },
    readLastUrl() { return opts.savedUrl || null },
    readToken() { return opts.savedToken || null },
    writeToken(t) { tokens.push(t) },
    clearToken() { cleared.push(true) },
    copyText(t) { copied.push(t) },
    tapPaste() { copied.push('__PASTE__') },
    send(channel, payload) { reported.push({ channel: channel, payload: payload }) },
  }

  const sandboxWindow = {
    chatHost: chatHost,
    addEventListener(type, fn) { (events['window:' + type] = events['window:' + type] || []).push(fn) },
    outerWidth: 460,
    outerHeight: 900,
  }

  function element(id) {
    if (!elements[id]) {
      const classes = new Set()
      elements[id] = {
        id: id,
        textContent: '',
        classes: classes,
        classList: {
          add(c) { classes.add(c) },
          remove(c) { classes.delete(c) },
        },
      }
    }
    return elements[id]
  }

  const fakeWebview = opts.noWebview ? { setAttribute() {}, addEventListener() {} } : webview

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    window: sandboxWindow,
    document: {
      querySelector: (sel) => (sel === 'webview' ? fakeWebview : null),
      getElementById: element,
      documentElement: { classList: { add() {} } },
    },
    navigator: { userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Electron/34.5.8 Safari/537.36' },
    location: { href: 'file:///plugin/page/chat.html', pathname: '/' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    sessionStorage: {
      getItem: (k) => (session.has(k) ? session.get(k) : null),
      setItem: (k, v) => session.set(k, v),
    },
    Promise: Promise,
  })

  vm.runInContext(readPlugin('page/chat-host.js'), context, { filename: 'page/chat-host.js' })

  return {
    attrs: attrs,
    executed: executed,
    reported: reported,
    copied: copied,
    tokens: tokens,
    cleared: cleared,
    storage: storage,
    elements: elements,
    chat: sandboxWindow.dsChat,
    reloads: () => reloads,
    setUrl(u) { currentUrl = u },
    emitted: () => Object.keys(events).filter((k) => k.indexOf('window:') !== 0),
    emit(type, payload) { (events[type] || []).forEach((fn) => fn(payload)) },
    hasWindowEvent: (type) => (events['window:' + type] || []).length > 0,
    resize() { (events['window:resize'] || []).forEach((fn) => fn({})) },
  }
}

function checkHostPage() {
  section('宿主页（沙箱）')

  check('UA 里去掉了 Electron 标记，并按记住的会话设了 src', () => {
    const conv = SITE + 'a/chat/s/abc123'
    const host = createHostRuntime({ savedUrl: conv })
    const ua = host.attrs.userAgent
    if (!ua) return '没有给 webview 设 UA'
    if (ua.indexOf('Electron') !== -1) return 'UA 里还有 Electron：' + ua
    if (host.attrs.src !== conv) return 'src 不是记住的会话：' + host.attrs.src
    return true
  })

  check('没有记住的会话时落到官网首页', () => {
    const host = createHostRuntime({})
    return host.attrs.src === SITE ? true : 'src 不对：' + host.attrs.src
  })

  check('这个环境没给 webview 能力时显兜底界面，而不是留一片白', () => {
    const host = createHostRuntime({ noWebview: true })
    const fb = host.elements.fallback
    if (!fb || !fb.classes.has('show')) return '兜底界面没显示出来'
    if (!host.elements.fbTitle.textContent) return '兜底界面没有标题'
    return true
  })

  check('导航地址会报给父窗', () => {
    const host = createHostRuntime({ url: SITE })
    if (host.emitted().indexOf('did-navigate-in-page') === -1) return '没监听 did-navigate-in-page'
    host.emit('did-navigate-in-page', {})
    const urls = host.reported.filter((r) => r.channel === 'chat:url')
    if (!urls.length) return 'did-navigate-in-page 没上报地址'
    return urls[0].payload === SITE ? true : '上报的地址不对：' + urls[0].payload
  })

  check('窗口缩放会报给父窗（且跳过建窗时那一次）', async () => {
    const host = createHostRuntime({})
    if (!host.hasWindowEvent('resize')) return '没监听窗口 resize'
    host.resize()
    if (host.reported.filter((r) => r.channel === 'chat:size').length !== 0) {
      return '首次 resize 被当成用户改尺寸了'
    }
    host.resize()
    // 上报是防抖的（拖窗口时别一帧报一次），所以这里要等过防抖窗口
    await sleep(600)
    const sizes = host.reported.filter((r) => r.channel === 'chat:size')
    if (sizes.length !== 1) return '第二次 resize 没上报（' + sizes.length + ' 次）'
    if (sizes[0].payload.width !== 460 || sizes[0].payload.height !== 900) {
      return '上报的尺寸不对：' + JSON.stringify(sizes[0].payload)
    }
    return true
  })

  check('提问：带上引子前缀、先粘后发', async () => {
    const host = createHostRuntime({ ready: true })
    host.emit('did-stop-loading', {})
    await sleep(300)   // 等宿主页轮询到"页面就绪"
    await host.chat.ask({ code: 'genvarname', payload: 'foo' })
    const text = host.copied.filter((t) => t !== '__PASTE__')[0]
    if (text !== '变量取名: foo') return '复制进剪贴板的文字不对：' + text
    if (host.copied.indexOf('__PASTE__') === -1) return '没有模拟粘贴'
    const clicks = host.executed.filter((c) => c.indexOf('.click()') !== -1)
    if (!clicks.length) return '没有点发送按钮'
    return true
  })

  check('页面还没就绪时先记下提问，就绪后补发', async () => {
    const host = createHostRuntime({ ready: true })
    await host.chat.ask({ code: 'ask', payload: 'queued' })
    await sleep(50)
    if (host.copied.length) return '页面没就绪就把文字送进去了'
    host.emit('did-stop-loading', {})
    await sleep(1200)
    const text = host.copied.filter((t) => t !== '__PASTE__')[0]
    return text === 'queued' ? true : '就绪后没补发：' + text
  })

  check('正在生成时先停掉再发新消息', async () => {
    const host = createHostRuntime({ ready: true, generating: true })
    host.emit('did-stop-loading', {})
    await sleep(300)
    await host.chat.ask({ code: 'ask', payload: 'again' })
    const clicks = host.executed.filter((c) => c.indexOf('.click()') !== -1)
    if (clicks.length < 2) return '只点了 ' + clicks.length + ' 次（应该先停一次、再发一次）'
    return true
  })

  check('登录页：把记住的令牌写回去并重载（只重载一次）', async () => {
    const host = createHostRuntime({
      ready: true, pathname: '/sign_in', savedToken: 'tok-1', pageToken: null,
    })
    host.emit('did-stop-loading', {})
    await sleep(400)
    if (host.storage.get('userToken') !== 'tok-1') return '没把令牌写回 localStorage'
    if (host.reloads() !== 1) return '写回后没重载（' + host.reloads() + ' 次）'
    host.emit('did-stop-loading', {})
    await sleep(400)
    return host.reloads() === 1 ? true : '重载了多次（' + host.reloads() + ' 次），会陷入刷新循环'
  })

  check('已登录：把页面里的令牌存一份', async () => {
    const host = createHostRuntime({ ready: true, pathname: '/', pageToken: 'tok-9' })
    host.emit('did-stop-loading', {})
    await sleep(400)
    return host.tokens.indexOf('tok-9') !== -1 ? true : '没把官网的令牌存下来'
  })

  check('登出：丢掉镜像，不把旧令牌塞回去', async () => {
    const host = createHostRuntime({
      ready: true, pathname: '/sign_in', savedToken: 'tok-old', sessionSeenApp: true, pageToken: null,
    })
    host.emit('did-stop-loading', {})
    await sleep(400)
    if (host.storage.get('userToken')) return '把旧令牌又写回页面了（用户会登不出去）'
    return host.cleared.length ? true : '没有清掉镜像'
  })

  check('失败浮层只在真的失败时出现（ERR_ABORTED 不算）', () => {
    const host = createHostRuntime({})
    host.emit('did-fail-load', { errorCode: -3, isMainFrame: true, errorDescription: 'ERR_ABORTED' })
    if (host.elements.fallback.classes.has('show')) return '正常的导航中断被当成加载失败了'
    host.emit('did-fail-load', { errorCode: -105, isMainFrame: true, errorDescription: 'ERR_NAME_NOT_RESOLVED' })
    return host.elements.fallback.classes.has('show') ? true : '真的加载失败却没显兜底界面'
  })
}

// ---------------------------------------------------------------- 主流程

async function main() {
  checkManifest()
  checkSources()
  checkWiring()
  checkIcon()
  checkRuntime()
  checkHostPage()

  await runAll()

  console.log('')
  if (failures.length) {
    console.log('未通过 ' + failures.length + ' / ' + (passed + failures.length) + ' 项：')
    failures.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
  console.log('全部通过（' + passed + ' 项）')
}

main()

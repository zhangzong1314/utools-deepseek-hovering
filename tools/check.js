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

  check('对话窗走的是 uTools 自带的浏览器（utools.ubrowser）', () => {
    const need = [
      ['utools.ubrowser', '对话窗要由 uTools 的浏览器来开'],
      ['getIdleUBrowsers', '窗口在不在只能问它'],
      ['wait(SEL_INPUT', '要等官网界面出来'],
      ['paste(', '把文字送进输入框'],
      ['click(SEL_SEND)', '点发送按钮'],
      ['PREFIX', '划词指令的引子'],
    ]
    const missing = need.filter((p) => windowsSrc.indexOf(p[0]) === -1).map((p) => p[0] + '（' + p[1] + '）')
    if (missing.length) return 'windows.js 里缺：' + missing.join('、')
    if (windowsSrc.indexOf("createBrowserWindow('page/chat.html'") !== -1) {
      return '对话窗还在拿自建窗口装页面 —— 那个窗口里装不了官网（见 README 的已知限制）'
    }
    return true
  })

  check('对话窗的宿主页文件已经删干净', () => {
    const gone = ['page/chat.html', 'page/chat-host.js', 'page/chat-preload.js']
    const left = gone.filter((p) => exists(pluginFile(p)))
    return left.length ? '这些文件还在：' + left.join(', ') : true
  })

  check('会话地址靠"问页面"拿（uTools 给的实例没有 url）', () => {
    if (windowsSrc.indexOf('function probePage') === -1) return 'windows.js 里没有 probePage'
    if (windowsSrc.indexOf('function inspectChat') === -1) return 'windows.js 里没有 inspectChat'
    if (windowsSrc.indexOf('location.href') === -1) return 'probePage 没读 location.href'
    // 反面：不该再有人拿实例上的 url 当唯一来源
    if (windowsSrc.indexOf('absorb') !== -1) return 'absorb（读实例 url 的那版）还在'
    return true
  })

  check('窗口摆着时会轮询地址（用户拿窗口的 × 关窗时我们收不到事件）', () => {
    if (windowsSrc.indexOf('CHAT_POLL_MS') === -1) return '没有轮询间隔常量'
    if (windowsSrc.indexOf('function startChatPoll') === -1) return '没有 startChatPoll'
    if (windowsSrc.indexOf('function stopChatPoll') === -1) return '没有 stopChatPoll'
    const startCalls = (windowsSrc.match(/startChatPoll\(\)/g) || []).length
    const stopCalls = (windowsSrc.match(/stopChatPoll\(\)/g) || []).length
    if (startCalls < 3) return '开窗那几条路上没接上 startChatPoll（只在定义处见到）'
    if (stopCalls < 2) return '藏窗时没停掉轮询'
    return true
  })

  check('所有对已有窗口的操作都走 runOnWindow（否则分不清"窗口忙"和"窗口没了"）', () => {
    const runs = (windowsSrc.match(/\.run\(id\)/g) || []).length
    // 唯一允许直接 .run(id) 的地方是 runOnWindow 自己
    return runs === 1 ? true : 'window.js 里有 ' + runs + ' 处直接 .run(id)，应该都走 runOnWindow'
  })

  check('SITE 与"认可会话地址"的域名一致', () => {
    const site = (windowsSrc.match(/const SITE\s*=\s*'([^']+)'/) || [])[1]
    if (!site) return 'windows.js 里找不到 SITE'
    const prefix = (windowsSrc.match(/CHAT_HOST_PREFIX\s*=\s*'([^']+)'/) || [])[1]
    if (!prefix) return 'windows.js 里找不到 CHAT_HOST_PREFIX'
    return prefix.indexOf(site) === 0 || site.indexOf(prefix) === 0
      ? true
      : 'SITE=' + site + '，但认地址的前缀是 ' + prefix
  })

  check('存储键只在 js/config.js 里定义', () => {
    const keys = ['deepseek:lastChatUrl', 'deepseek:chatSize', 'deepseek:ballPos', 'deepseek:chatShown']
    const missing = keys.filter((key) => configSrc.indexOf(key) === -1)
    return missing.length ? 'config.js 里没有 ' + missing.join(', ') : true
  })

  check('config 里有"对话窗显/藏"这个键（uBrowser 不给可见性，只能自己记）', () =>
    configSrc.indexOf('function isChatShown') !== -1 && configSrc.indexOf('function setChatShown') !== -1
      ? true
      : 'config.js 里没有 isChatShown/setChatShown')

  check('JS 侧没有旧机制的残留', () => {
    const dead = ['chat:sri', 'chat:netfail', 'chat:trace', 'chat:nodeRepair', 'chat:url', 'chat:size',
      'repairChat', 'watchViaSession', 'watchViaDebugger', 'watchChatConsole', 'collectChatDiagnostics',
      'openChatDevTools', '__dsHelper', 'dsChat', 'chatHost', 'reloadChatIgnoringCache', '_sri-ck']
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
    hiddenMain: 0,
    redirected: [],
    pendingCallbacks: [],
    // uBrowser 那一侧：每次 run() 记一条链，造出来的窗口也记着
    chains: [],
    ubWindows: [],
    nextWinId: 0,
    // 页面里 evaluate 出来的东西（假 DOM 里没有真页面，由测试按需塞：
    // inspectChat 读的那个 {url,width,height} 就从这儿来）
    probe: null,
  }

  /** 假窗口（悬浮球用） */
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
        executeJavaScript() { return Promise.resolve(true) },
        send(channel, payload) { win.sent.push({ channel: channel, payload: payload }) },
        on() {},
        openDevTools() {},
      },
    }
    return win
  }

  const UB_METHODS = ['goto', 'show', 'hide', 'wait', 'focus', 'paste', 'click', 'evaluate',
    'userAgent', 'devTools', 'css', 'press', 'input', 'check', 'scroll', 'clearCookies']

  /** 假的链式 uBrowser：每一步都记下来，run() 时把整条链收进 state.chains */
  function makeChain(steps) {
    const chain = {}
    UB_METHODS.forEach((name) => {
      chain[name] = function () {
        steps.push({ op: name, args: Array.prototype.slice.call(arguments) })
        return chain
      }
    })
    chain.run = function (target) {
      const record = { steps: steps.slice(), target: target }
      state.chains.push(record)

      if (typeof target === 'number') {
        const win = state.ubWindows.filter((w) => w.id === target)[0]
        if (!win) return Promise.reject(new Error('uBrowser 窗口已经不在了'))
        if (record.steps.some((s) => s.op === 'hide')) win.shown = false
        if (record.steps.some((s) => s.op === 'show')) win.shown = true
        const results = record.steps.map((s) => (s.op === 'evaluate' ? state.probe : undefined))
        return Promise.resolve(results.concat([win]))
      }

      const winOpts = target || {}
      const goto = record.steps.filter((s) => s.op === 'goto').slice(-1)[0]
      const win = {
        id: ++state.nextWinId,
        url: goto ? goto.args[0] : '',
        title: winOpts.title || '',
        width: winOpts.width || 800,
        height: winOpts.height || 600,
        x: 0,
        y: 0,
        shown: true,
        options: winOpts,
      }
      state.ubWindows.push(win)
      const results = record.steps.map((s) => (s.op === 'evaluate' ? state.probe : undefined))
      return Promise.resolve(results.concat([win]))
    }
    return chain
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
    // 真的 utools.ubrowser 每次访问都是一条**新的**操作队列（链），不是同一条往下挂，
    // 所以这里用 getter 每次给一条新链 —— 否则上一轮的步骤会留在队列里，
    // run() 返回的 [...各步结果] 就对不上号了。
    get ubrowser() { return makeChain([]) },
    getIdleUBrowsers() {
      // "空闲"= 操作队列跑完了；桩件里没有并发，所以创建过的都算空闲（藏着的也算 ——
      // uTools 那个列表同样不带可见性）
      return state.ubWindows.map((w) => ({
        id: w.id, url: w.url, title: w.title,
        width: w.width, height: w.height, x: w.x, y: w.y,
      }))
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
    settle: () => new Promise((ok) => setTimeout(ok, 0)),
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

  check('点悬浮球：第一次开对话窗（尺寸来自配置），第二次藏起来（hide，窗口还在）', async () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek', type: 'text' })
    rt.fireIpc('ball:click')
    await rt.settle()
    const wins = rt.state.ubWindows
    if (wins.length !== 1) return '点球没开出对话窗（uBrowser 窗口数 ' + wins.length + '）'
    const win = wins[0]
    if (win.width !== 460 || win.height !== 900) {
      return '窗口尺寸不是配置里的默认值：' + win.width + '×' + win.height
    }
    if (win.url !== SITE) return '没有记住的会话时该开到官网首页，实际是 ' + win.url
    if (rt.state.hiddenMain === 0) return '开窗时没把 uTools 主窗口收起来'
    if (rt.host.state().chatOpen !== true) return '面板读到的状态是"没开"'

    rt.fireIpc('ball:click')
    await rt.settle()
    const hid = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'hide'))
    if (!hid.length) return '第二次点球没有走 hide（uBrowser 里"关闭"就是 hide）'
    if (rt.state.ubWindows.length !== 1) return '第二次点球又开了一个窗口'
    if (rt.host.state().chatOpen !== false) return '藏起来之后面板还当成开着'

    rt.fireIpc('ball:click')
    await rt.settle()
    const shown = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'show'))
    if (shown.length < 2) return '第三次点球没把窗口再摆出来'
    return true
  })

  check('选中文字提问：等界面 → 处理在途生成 → 贴文字 → 点发送', async () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'translate', payload: 'hello world', type: 'over' })
    await rt.settle()
    const chain = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'paste')).slice(-1)[0]
    if (!chain) return '没有把文字送进对话窗（没见过 paste 这一步）'
    const ops = chain.steps.map((s) => s.op)
    const wait = chain.steps.filter((s) => s.op === 'wait')[0]
    if (!wait || wait.args[0] !== 'textarea') return '没有先等输入框出现'
    if (ops.indexOf('evaluate') === -1) return '没有先处理"正在生成"这件事（缺 evaluate）'
    if (ops.indexOf('focus') === -1) return '没有把焦点放进输入框'
    if (ops.indexOf('click') === -1) return '没有点发送按钮'
    const paste = chain.steps.filter((s) => s.op === 'paste')[0]
    if (paste.args[0] !== '请翻译下面内容: hello world') return '粘进去的文字不对：' + paste.args[0]
    const click = chain.steps.filter((s) => s.op === 'click')[0]
    if (click.args[0] !== 'input[type=file][multiple] + div[role=button]') {
      return '点发送按钮的选择器不对：' + click.args[0]
    }
    if (rt.state.ubWindows.length !== 1) return '提问时不该另开窗口'
    if (rt.state.hiddenMain === 0) return '提问时没把主窗口收起来'
    return true
  })

  check('五条划词指令各自的引子都对', async () => {
    const want = {
      ask: 'hi',
      translate: '请翻译下面内容: hi',
      genvarname: '变量取名: hi',
      summarize: '总结下面内容: hi',
      summarizeUrl: '总结这个网页的内容: hi',
    }
    const codes = Object.keys(want)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      const rt = createRuntime({ callbackMode: 'async' })
      rt.enter({ code: code, payload: 'hi', type: 'over' })
      await rt.settle()
      const chain = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'paste')).slice(-1)[0]
      if (!chain) return code + ' 没有把文字送进去'
      const paste = chain.steps.filter((s) => s.op === 'paste')[0]
      if (paste.args[0] !== want[code]) return code + ' 的引子不对：' + paste.args[0]
    }
    return true
  })

  check('只开窗（没有文字）时不往里塞东西', async () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'summarizeUrl', payload: '', type: 'regex' })
    await rt.settle()
    if (rt.state.ubWindows.length !== 1) return '没开窗'
    const pasted = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'paste'))
    if (pasted.length) return '没带文字却粘了东西进去'
    const focused = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'focus'))
    return focused.length ? true : '该把光标放进输入框，却什么都没做'
  })

  check('地址与尺寸回流：只能从页面里问（uTools 给的窗口实例没有 url）', async () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.fireIpc('ball:click')
    await rt.settle()
    if (rt.state.db.has('deepseek:lastChatUrl')) {
      return '刚开窗就把地址记下来了 —— 那会儿页面还没进去，问回来的只会是空的/首页'
    }

    const conv = SITE + 'a/chat/s/75e63fe1-08bc-4e0b-a957-270557e00482'
    rt.state.probe = { url: conv + '#draft', width: 3000, height: 3000 }
    rt.fireIpc('ball:click')          // 关：先问地址和尺寸，再藏
    await rt.settle()
    if (rt.state.db.get('deepseek:lastChatUrl') !== conv) {
      return '没记住会话地址（存的是 ' + rt.state.db.get('deepseek:lastChatUrl') + '）'
    }
    const size = JSON.parse(rt.state.db.get('deepseek:chatSize'))
    if (size.width > 1600 || size.height > 1080) return '尺寸没夹取就落库了：' + JSON.stringify(size)

    rt.state.probe = { url: SITE + 'sign_in', width: 460, height: 900 }
    rt.fireIpc('ball:click')          // 开：show 之后也会问一次
    await rt.settle()
    if (rt.state.db.get('deepseek:lastChatUrl') !== conv) return '路过登录页把记住的会话冲掉了'

    rt.state.probe = { url: SITE, width: 460, height: 900 }
    rt.fireIpc('ball:click')          // 关：这次问回来的是对话首页
    await rt.settle()
    if (rt.state.db.has('deepseek:lastChatUrl')) return '回到对话首页没把会话忘掉'
    return true
  })

  check('快捷键和点球一个动作：第一下开，第二下关', async () => {
    const rt = createRuntime({ callbackMode: 'async' })
    rt.enter({ code: 'deepseek-window', from: 'hotkey' })
    await rt.settle()
    if (rt.state.ubWindows.length !== 1) return '快捷键没开出对话窗'
    rt.enter({ code: 'deepseek-window', from: 'hotkey' })
    await rt.settle()
    const hid = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'hide'))
    if (!hid.length) return '第二下没把窗口藏起来（快捷键要和点球一样是开关）'
    if (rt.host.state().chatOpen !== false) return '藏起来之后面板还当成开着'
    rt.enter({ code: 'deepseek-window', from: 'hotkey' })
    await rt.settle()
    const shown = rt.state.chains.filter((c) => c.steps.some((s) => s.op === 'show'))
    return shown.length >= 2 ? true : '第三下没把窗口再摆出来'
  })

  check('记住的会话：下次开窗直接开到那儿', async () => {
    const rt = createRuntime({ callbackMode: 'async' })
    const conv = SITE + 'a/chat/s/abc'
    rt.state.db.set('deepseek:lastChatUrl', conv)
    rt.fireIpc('ball:click')
    await rt.settle()
    return rt.state.ubWindows[0].url === conv
      ? true
      : '开的不是记住的会话：' + rt.state.ubWindows[0].url
  })

  check('面板改尺寸：夹取后落库（uBrowser 改不了正在开的窗口，新尺寸下次开窗生效）', () => {
    const rt = createRuntime({ callbackMode: 'async' })
    const next = rt.host.setChatSize(700, 800)
    if (next.chatSize.width !== 700 || next.chatSize.height !== 800) {
      return '面板拿到的尺寸不对：' + JSON.stringify(next.chatSize)
    }
    const saved = JSON.parse(rt.state.db.get('deepseek:chatSize'))
    if (saved.width !== 700 || saved.height !== 800) return '尺寸没落库'
    rt.host.setChatSize(99999, 99999)
    const clamped = JSON.parse(rt.state.db.get('deepseek:chatSize'))
    if (clamped.width > 1600 || clamped.height > 1080) {
      return '超范围的尺寸没被夹取：' + JSON.stringify(clamped)
    }
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
async function main() {
  checkManifest()
  checkSources()
  checkWiring()
  checkIcon()
  checkRuntime()

  await runAll()

  console.log('')
  if (failures.length) {
    console.log('未通过 ' + failures.length + ' / ' + (passed + failures.length) + ' 项：')
    failures.forEach((f) => console.log('  ✗ ' + f))
    process.exit(1)
  }
  console.log('全部通过（' + passed + ' 项）')
  // 插件代码里有 setInterval（对话窗的地址轮询），跑完得自己退出，
  // 否则 Node 会一直等着那个定时器。
  process.exit(0)
}

main()

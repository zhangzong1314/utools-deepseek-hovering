// DeepSeek 悬浮助手 —— 主 preload
//
// 这个文件跑在 uTools 搜索框主窗口的渲染进程里（Node 环境，可以 require），
// 并且它和 index.html 共享同一个 window 对象 —— 所以主面板直接读 window.deepseekHost 即可，
// 不需要走 ipc。

const { ipcRenderer, shell, clipboard } = require('electron')
const config = require('./js/config')
const windows = require('./js/windows')
const trace = require('./js/trace')

const SITE = windows.SITE

// 全局快捷键。uTools 不给插件"自己注册系统级快捷键"的 API，
// 它的做法是：用户在 uTools 设置里，给 plugin.json 里声明的某条**指令**绑定一个快捷键，
// 按下时 uTools 打开插件并告诉你 from === 'hotkey'。所以这里能做的只有两件事：
//   1. getCmdHotKey(cmdLabel) —— 读出用户给这条指令配了什么键，显示在面板上；
//   2. redirectHotKeySetting(cmdLabel) —— 把用户送到 uTools 的快捷键设置页面去配。
// 这两个字面量必须和 plugin.json 里第二个 feature 对上，tools/check.js 有断言钉住。
const HOTKEY_FEATURE = 'deepseek-window'
const HOTKEY_CMD = 'DeepSeek窗口'

function currentHotkey() {
  try {
    const key = utools.getCmdHotKey(HOTKEY_CMD)
    return typeof key === 'string' && key ? key : null
  } catch (e) {
    // 老版本 uTools 没有这个 API —— 面板会显示"未设置"，不影响其它功能
    return null
  }
}

// ---------------------------------------------------------------- 面板桥接

const listeners = new Set()

function snapshot() {
  return {
    site: SITE,
    ballVisible: config.isBallVisible(),
    ballRunning: !!windows.getBallWindow(),
    openIn: config.getOpenIn(),
    chatOpen: windows.isChatVisible(),
    chatSize: windows.resolveChatSize(),
    chatSizeDefault: windows.DEFAULT_CHAT_SIZE,
    chatSizeMin: windows.MIN_CHAT_SIZE,
    hotkey: currentHotkey(),
    hotkeyCmd: HOTKEY_CMD,
  }
}

function emit() {
  const state = snapshot()
  listeners.forEach((fn) => {
    try {
      fn(state)
    } catch (e) {
      console.error('[host] 面板回调出错:', e)
    }
  })
}

function hidePanelWindow() {
  // 打开了对话就顺手把 uTools 搜索框收起来 —— 插件干完活该让位，
  // 不然搜索框会一直压在对话窗上面。窗口本来就隐藏时调用也无害。
  try {
    utools.hideMainWindow()
  } catch (e) {
    console.error('[host] 隐藏主窗口失败:', e)
  }
}

function openInBrowser() {
  // 优先用 uTools 的 shell 封装（它会做 URL 合法性检查），
  // 没有就退回 Electron 原生的 shell。
  hidePanelWindow()
  try {
    const p = utools.shellOpenExternal(SITE)
    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[host] 打开浏览器失败:', e))
    return
  } catch (e) {
    console.error('[host] shellOpenExternal 不可用，改用 electron.shell:', e)
  }
  try {
    const p = shell.openExternal(SITE)
    if (p && typeof p.catch === 'function') p.catch((e) => console.error('[host] 打开浏览器失败:', e))
  } catch (e) {
    console.error('[host] 打开浏览器彻底失败:', e)
  }
}

function openChatWindow() {
  hidePanelWindow()
  return windows.openChat()
}

/**
 * 开着的对话窗就关掉，没开就打开。
 *
 * 开还是关这件事由 js/windows.js 的 toggleChat() 一个人说了算，这里只补 uTools 那侧的规矩：
 * **关的时候不收** uTools 搜索框 —— 这次多半是用户刚在面板上点的「关闭对话」，
 * 把面板一起收走会像"点了没反应"。收搜索框只发生在"要开窗"的那条路径上。
 * @returns {boolean} true 表示这次是打开
 */
function toggleChatWindow() {
  if (!windows.isChatVisible()) hidePanelWindow()
  return windows.toggleChat()
}

/**
 * 快捷键按下时干什么。语义见 js/windows.js 的 summonChat()：三态，
 * 和点悬浮球的纯开关不一样（那里是"开着就关"，这里第一下永远是"叫到跟前"）。
 *
 * 收不收 uTools 搜索框跟着**动作**走，不跟着"窗口开没开"走：
 * 从搜索框里敲 `DeepSeek窗口` 回车也能进到这里，那时搜索框正开着，
 * 只要这一下是要把窗口摆到面前（open / front），就顺手把搜索框让开。
 * 配了 mainHide 的话（走快捷键那条路）搜索框根本没显示，这次调用也就无害。
 */
function handleHotkeyEnter() {
  const action = windows.summonChat()
  if (action !== 'close') hidePanelWindow()
  emit()
  return action
}

function openHotkeySetting() {
  // 只跳转，不改配置 —— uTools 文档写明：该方法仅负责跳转快捷键设置界面，
  // 不会自动创建或修改快捷键配置。真正按键组合由用户在那边定（系统级注册归 uTools 管）。
  try {
    utools.redirectHotKeySetting(HOTKEY_CMD)
    return true
  } catch (e) {
    console.error('[host] 打开 uTools 快捷键设置失败（版本太老？）:', e)
    return false
  }
}

function setPanelHeight(height) {
  // v8 文档与类型定义里叫 setExpandHeight；v7 时代拼作 setExpendHeight。
  // 两个都试一下，谁的机上装的是哪版都能用。
  const fn = utools.setExpandHeight || utools.setExpendHeight
  if (typeof fn !== 'function') return false
  try {
    return !!fn.call(utools, height)
  } catch (e) {
    console.error('[host] 设置面板高度失败:', e)
    return false
  }
}

/**
 * 打开对话窗的开发者工具。排查"哪个请求没成"最直接的工具，比我们自己在页面里
 * 包一层 XHR / fetch 强 —— Network 面板会给出每条请求的完整因果。
 * 原样把 windows.js 那句话返回给面板显示（失败原因也要让人看见）。
 */
function openChatDevTools() {
  const message = windows.openChatDevTools()
  console.log('[host] 开发者工具:', message)
  return message
}

/**
 * 把排查日志读出来复制到剪贴板，顺手回一句结果。
 *
 * 为什么要这条路：最要紧的两类行只落在那个日志文件里 —— 浏览器自己说的
 * `Failed to load resource: net::ERR_…`（它直接点名是谁把请求掐掉的），
 * 以及页面侧报上来的 `元素换走 blob …`。页面上的报告看不到它们（那是另一个进程），
 * 日志文件又埋在 %TEMP%，所以按一下按钮比让人自己去找强。
 */
function copyTraceLog() {
  const text = trace.read()
  try {
    clipboard.writeText(text)
    console.log('[host] 排查日志已复制:\n' + text)
  } catch (e) {
    console.error('[host] 写剪贴板失败:', e)
  }
  return '已经复制到剪贴板了：' + text.length + ' 字节（日志文件 ' + trace.logPath() + '）'
}

/**
 * 把对话窗里的"失败请求记录"取回来并复制到剪贴板。
 *
 * 为什么不让用户直接在页面上点「复制」：那个报告框挂在官网的 DOM 上，
 * 登录那一步要是触发一次导航，框就跟着文档一起没了（实测撞见过，用户回头找不到）。
 * 这条路由父窗去问页面要，取回来在父窗复制 —— 页面那边在不在都无所谓。
 */
function copyChatDiagnostics() {
  return windows.collectChatDiagnostics()
    .then((text) => {
      try {
        clipboard.writeText(text)
        console.log('[host] 对话窗现场记录已复制:\n' + text)
        return text
      } catch (e) {
        console.error('[host] 写剪贴板失败:', e)
        return text
      }
    })
    .catch((e) => '取记录失败：' + ((e && e.message) || e))
}

const host = {
  state: snapshot,
  onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  showBall() {
    windows.showBall()
    emit()
    return snapshot()
  },
  hideBall() {
    windows.hideBall()
    emit()
    return snapshot()
  },
  toggleBall() {
    return config.isBallVisible() ? host.hideBall() : host.showBall()
  },
  // 球被拖丢（换显示器、改分辨率）之后的救场入口
  resetBallPos() {
    windows.resetBallPos()
    emit()
    return snapshot()
  },
  openChat() {
    openChatWindow()
    emit()
    return snapshot()
  },
  closeChat() {
    windows.closeChat()
    emit()
    return snapshot()
  },
  toggleChat() {
    toggleChatWindow()
    emit()
    return snapshot()
  },
  // 快捷键（面板上只显示"当前配了哪个键"，按键组合由 uTools 管，这里只能跳过去配）
  summonChat() {
    handleHotkeyEnter()
    return snapshot()
  },
  openHotkeySetting,
  openInBrowser,
  setOpenIn(mode) {
    config.setOpenIn(mode)
    emit()
    return snapshot()
  },
  setChatSize(width, height) {
    windows.saveChatSize(width, height)
    emit()
    return snapshot()
  },
  resetChatSize() {
    windows.resetChatSize()
    emit()
    return snapshot()
  },
  setPanelHeight,
  hidePanel: hidePanelWindow,
  // 排查用：一个开对话窗的 DevTools，一个把"这个窗口里失败的请求"捞出来复制，
  // 一个把日志文件里那几行（含浏览器自己说的错误码）捞出来复制。
  openChatDevTools,
  copyChatDiagnostics,
  copyTraceLog,
}

window.deepseekHost = host

// ---------------------------------------------------------------- 悬浮球消息

function handleBallClick() {
  if (config.getOpenIn() === config.OPEN_IN.browser) openInBrowser()
  else toggleChatWindow()
  emit()
}

// 菜单项的文案跟着窗口状态走：开着的时候第一项该是「关闭对话」。
function menuItems() {
  return [
    { id: 'chat', label: windows.isChatVisible() ? '关闭对话' : '打开对话' },
    { id: 'browser', label: '在浏览器中打开' },
    { id: 'hide', label: '隐藏悬浮球' },
  ]
}

function handleMenuPick(id) {
  if (id === 'chat') toggleChatWindow()
  else if (id === 'browser') openInBrowser()
  else if (id === 'hide') windows.hideBall()
  emit()
}

/**
 * 悬浮球右键：球窗只有 60×60，菜单塞不下，所以由这边把球窗临时撑大成一个
 * 「球 + 菜单」的包围盒，再把各自在窗口内的坐标发给球页去画。
 * 打开期间窗口的透明区域会短暂吃掉桌面点击 —— 这跟原生菜单的行为一致，可接受。
 * 任何一步失败都退回「打开主面板」，至少不会点了没反应。
 */
function openBallMenu() {
  const win = windows.getBallWindow()
  if (!win) return
  const items = menuItems()
  let geom = null
  try {
    geom = windows.expandBallForMenu(items.length)
  } catch (e) {
    console.error('[host] 展开悬浮球菜单失败:', e)
  }
  if (!geom) {
    try {
      utools.showMainWindow()
    } catch (e) {
      console.error('[host] 打开主面板失败:', e)
    }
    return
  }
  try {
    win.webContents.send('ball:menu', { geom, items })
  } catch (e) {
    console.error('[host] 下发菜单失败:', e)
    windows.collapseBallMenu()
  }
}

function closeBallMenu() {
  try {
    windows.collapseBallMenu()
  } catch (e) {
    console.error('[host] 收起悬浮球菜单失败:', e)
  }
}

function registerBallIpc() {
  ipcRenderer.on('ball:click', () => handleBallClick())
  ipcRenderer.on('ball:dragStart', () => windows.beginDrag())
  ipcRenderer.on('ball:drag', (_e, delta) => {
    if (delta) windows.dragTo(delta.dx, delta.dy)
  })
  ipcRenderer.on('ball:dragEnd', () => {
    windows.endDrag()
    emit()
  })
  ipcRenderer.on('ball:requestMenu', () => openBallMenu())
  ipcRenderer.on('ball:menuPick', (_e, id) => {
    closeBallMenu()
    handleMenuPick(id)
  })
  ipcRenderer.on('ball:menuClose', () => closeBallMenu())
}

function registerChatIpc() {
  // 对话窗跑在官网页面上时会把当前地址报上来。「记哪个、什么时候忘」这套判断
  // 集中在 js/windows.js 的 rememberChatUrl 里（只认会话地址，回首页才清）。
  ipcRenderer.on('chat:url', (_e, url) => {
    windows.rememberChatUrl(url)
    // 顺手记一笔地址变化。这条对排查特别有用：登录那一步要是**发生了导航**，
    // 页面上的报告框就会跟着文档一起消失（实测就是这么找不到的），
    // 而这行日志能直接证实"登录那一下换过文档"。
    trace.append('导航: ' + url)
  })
  // 官网脚本没通过完整性校验（SRI）时，页面被换成一张"资源加载异常"的图
  // （页面侧的识别与"只救一次"的逻辑见 page/chat-preload.js）。
  // 坏副本常常同时在缓存里，所以这里要绕过缓存重载，而不是让页面自己 reload。
  // 日志里的措辞不带 SRI：那张图对"请求压根没发出去"一样会响，函数名叫 _sriCk
  // 只是作者预判最常见的病因，不是诊断结论。
  ipcRenderer.on('chat:sri', (_e, info) => {
    console.warn('[chat] 官网脚本没加载成，重载一次（绕过缓存）:', info && info.url)
    trace.append('入口脚本没加载成: ' + ((info && info.url) || '?') + ' → 绕过缓存重载一次')
    windows.reloadChatIgnoringCache()
  })
  // 页面侧"自己验一遍后放行"也试不通时，改用 Node 侧那条路：
  // 由父窗自己去取官网脚本（Node 没有 CORS 这一层）、按 HTML 里写的 integrity
  // 验过哈希，再用 executeJavaScript 灌进对话窗。判断和注入都在 js/windows.js 的
  // repairChat() + js/repair.js 里，这里只负责把页面报上来的脚本清单转过去。
  ipcRenderer.on('chat:nodeRepair', (_e, info) => {
    console.warn('[chat] 页面侧放行失败，改走 Node 侧取回并注入:', info && info.scripts && info.scripts.length)
    trace.append('改走父窗放行: 脚本 ' + ((info && info.scripts && info.scripts.length) || 0) +
      ' 只，样式 ' + ((info && info.styles && info.styles.length) || 0) + ' 只')
    windows.repairChat(info)
  })
  // 对话窗里失败的网络请求（XHR / fetch / WebSocket）—— 页面侧认出来一条就报一条。
  // 这是整个排查里最要紧的一份数据：登录失败时官网只回一句"网络异常"，
  // 而这几行直接说明是"请求没发出去"还是"服务端不受理"。
  // 带上"指纹当时的状态"，是因为登录接口要 device_id，而那是官网的设备指纹脚本给的 ——
  // 指纹没起来，422 缺 device_id 和"资源没加载成"就是同一件事的两头。
  ipcRenderer.on('chat:netfail', (_e, entry) => {
    if (!entry) return
    trace.append('请求失败: ' + entry.method + ' ' + entry.url + ' → ' + entry.result +
      (entry.error ? '：' + entry.error : '') +
      (entry.sent ? ' / 我们发的字段: ' + entry.sent : '') +
      (entry.body ? ' / 服务端说: ' + entry.body : '') +
      (entry.device ? ' / 指纹: ' + entry.device : ''))
  })
  // 页面侧自己发生的、值得留一行的事（认出错误页、两级放行各自的结果）。
  // 只收一行文本，格式由页面那边决定 —— 这里就是个转发，不做判断。
  ipcRenderer.on('chat:trace', (_e, line) => {
    if (line) trace.append(String(line))
  })
}

// ---------------------------------------------------------------- 生命周期

// ipcRenderer 的监听是进程级的不随窗口销毁解绑，只能注册一次；
// 注册两次的话窗口每次重建都会让每条消息被处理两遍（球会一下开出两个对话窗）。
let ipcRegistered = false
function setupOnce() {
  if (ipcRegistered) return
  ipcRegistered = true
  registerBallIpc()
  registerChatIpc()
}

// 加载完成、正式进入之前的一次性初始化。
// 这里故意不建悬浮球：窗口创建在 onPluginReady 里做太早，uTools 还没进入插件，
// 而且 onPluginEnter 一定会紧随其后，放那边更稳。
utools.onPluginReady(() => {
  setupOnce()
  console.log('[plugin] ready, 站点:', SITE)
  // 记一行"这次进程开始了"，并把日志路径打出来 —— 事后读日志时得知道这几行是哪次运行的。
  trace.sessionStart('站点 ' + SITE)
  console.log('[plugin] 排查日志写到:', trace.logPath())
})

utools.onPluginEnter((action) => {
  setupOnce()
  // 用户设定的"退出后台 3 分钟后回收"会把球一起收走，所以每次进入插件都重新确认一次。
  if (config.isBallVisible()) {
    try {
      windows.showBall()
    } catch (e) {
      console.error('[plugin] 显示悬浮球失败:', e)
    }
  }
  // 快捷键、或者从搜索框敲 `DeepSeek窗口` 进来的：这次不是来开面板的，是要开/关对话窗。
  // （配了 mainHide 的 feature 走快捷键进入时，uTools 压根不会显示搜索框，所以不会闪。）
  if (action && action.code === HOTKEY_FEATURE) {
    console.log('[plugin] 快捷键进入（from=' + (action.from || '?') + '）')
    handleHotkeyEnter()
    return
  }
  emit()
})

// onPluginOut 里什么都不要销毁 —— 官方文档明确警告：
// "避免在 onPluginOut 事件中关闭自定义窗口，以免插件应用自动退出时关闭仍在使用的自定义窗口"。
// isKill === false 表示进程还在后台跑，悬浮球正是靠这条路径活着。
utools.onPluginOut((isKill) => {
  console.log('[plugin] out, 进程结束:', !!isKill)
})

setupOnce()

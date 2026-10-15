// DeepSeek 悬浮助手 —— 主 preload
//
// 这个文件跑在 uTools 搜索框主窗口的渲染进程里（Node 环境，可以 require），
// 并且它和 index.html 共享同一个 window 对象 —— 所以主面板直接读 window.deepseekHost 即可，
// 不需要走 ipc。

const { ipcRenderer } = require('electron')
const config = require('./js/config')
const windows = require('./js/windows')
const hotkey = require('./js/hotkey')

// 插件里那几条"选中文字"指令的 code（plugin.json 里 declare 的）。
// 它们进来时是带 payload 的：把选中内容丢给对话窗去问。字面量必须和 plugin.json 对上，
// tools/check.js 有断言钉住。
const ASK_CODES = ['ask', 'translate', 'genvarname', 'summarize', 'summarizeUrl']

// 保活定时任务：uTools 会在插件退到后台几分钟后回收进程（本机设置是 3 分钟），
// 进程一没，自己注册的全局热键和悬浮球就都跟着没了。用一个每分钟的定时任务把插件拉回来 ——
// 官方文档写明 onScheduleTrigger 在插件未运行时也会拉起进程。
const KEEPALIVE_CODE = 'keep-alive'
const KEEPALIVE_CRON = '* * * * *'

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
    ballVisible: config.isBallVisible(),
    ballRunning: !!windows.getBallWindow(),
    chatOpen: windows.isChatVisible(),
    chatSize: windows.resolveChatSize(),
    chatSizeDefault: windows.DEFAULT_CHAT_SIZE,
    chatSizeMin: windows.MIN_CHAT_SIZE,
    // 插件自己注册的全局热键（默认 Ctrl+Space，见 js/hotkey.js）
    hotkey: hotkeySpec(),
    hotkeyState: hotkey.state(),
    // uTools 那边那条指令的绑定（只能显示 + 跳过去设置，插件改不了）
    utoolsHotkey: currentHotkey(),
    hotkeyCmd: HOTKEY_CMD,
  }
}

/** 现在生效的热键：配置里存过的，没有就是默认值 */
function hotkeySpec() {
  return config.getHotkey() || hotkey.DEFAULT_HOTKEY
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

/**
 * 把对话窗打开（或从藏着的状态摆出来）。
 * 对话窗是 uTools 自带的浏览器窗口，开关都是异步的 —— 返回 Promise<snapshot | boolean>。
 */
function openChatWindow() {
  hidePanelWindow()
  return windows.showChat().then(() => snapshot())
}

/**
 * 开着的对话窗就藏起来，没开就打开。
 *
 * 开还是关这件事由 js/windows.js 的 toggleChat() 一个人说了算，这里只补 uTools 那侧的规矩：
 * **关的时候不收** uTools 搜索框 —— 这次多半是用户刚在面板上点的「关闭对话」，
 * 把面板一起收走会像"点了没反应"。收搜索框只发生在"要开窗"的那条路径上。
 * @returns {Promise<boolean>} true 表示这次是打开
 */
function toggleChatWindow() {
  if (!windows.isChatVisible()) hidePanelWindow()
  return windows.toggleChat()
}

/**
 * 快捷键按下时干什么。
 *
 * 语义见 js/windows.js 的 summonChat()：uBrowser 给不出"窗口在不在最前面"，所以现在
 * **只做"叫到跟前"，永不关窗**。既然永远不会关，搜索框就一律让开 ——
 * 从搜索框里敲 `DeepSeek窗口` 回车也能进到这里，那时搜索框正开着，顺手收掉才对；
 * 走快捷键那条路时搜索框根本没显示（feature 上配了 mainHide），这次调用也无害。
 */
function handleHotkeyEnter() {
  hidePanelWindow()
  return windows.summonChat().then((action) => {
    emit()
    return action
  })
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

// ---------------------------------------------------------------- 全局热键（插件自己注册）

/**
 * 保证热键助手在跑。
 *
 * 为什么每次进入插件都查一遍：uTools 会在插件退到后台几分钟后回收进程，进程一没，
 * 自己注册的热键就跟着没了（那个小助手是插件的子进程）。保活定时任务会把它拉回来，
 * 拉回来之后走的就是这里。
 */
function ensureHotkey() {
  if (hotkey.isRunning()) return
  hotkey.start(hotkeySpec())
}

/** 面板上设的新热键：存下来 + 立刻换过去（改绑 = 杀掉重开，见 js/hotkey.js 的注释） */
function setHotkey(spec) {
  const wanted = (spec || '').trim() || hotkey.DEFAULT_HOTKEY
  config.setHotkey(wanted)
  hotkey.start(wanted)
  return snapshot()
}

function clearHotkey() {
  config.clearHotkey()
  hotkey.stop()
  return snapshot()
}

/** 保活：把热键助手拉起来，顺带把该显示的悬浮球补回来 */
function keepAliveTick() {
  ensureHotkey()
  if (config.isBallVisible() && !windows.getBallWindow()) {
    try {
      windows.showBall()
    } catch (e) {
      console.error('[host] 保活时补回悬浮球失败:', e)
    }
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
 * 选中文字进来的一条指令（plugin.json 里的 over / regex 那几条）：开窗 + 把文字送进去。
 *
 * 顺手把 uTools 主窗口收起来 —— 用户的意图是"问 DeepSeek"，不是回来看搜索框的。
 * 那几条 feature 都带了 mainHide，正常不会显示主窗口，这一句是兜底。
 */
function askChatWindow(action) {
  hidePanelWindow()
  return windows.askChat(action).then(() => snapshot())
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
  // 对话窗这三颗按钮都是异步的（uBrowser 的开关是链式操作）：返回 Promise<snapshot>。
  // 面板那边对 Promise 是认的（见 page/panel.js 的点击处理）。
  openChat() {
    return openChatWindow()
  },
  closeChat() {
    return windows.hideChat().then(() => {
      emit()
      return snapshot()
    })
  },
  toggleChat() {
    return toggleChatWindow().then(() => {
      emit()
      return snapshot()
    })
  },
  openHotkeySetting,
  // 插件自己注册的全局热键：面板上按一下组合键就改（不依赖 uTools 的快捷键页）
  setHotkey,
  clearHotkey,
  // 面板上改尺寸：先夹取再落库。对话窗是 uTools 自己的浏览器窗口，改不了已经开着的那个
  // （链式 API 里没有改窗口尺寸这一步），所以新尺寸下次开窗生效 —— 面板文案是这么写的。
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
}

window.deepseekHost = host

// ---------------------------------------------------------------- 悬浮球消息

function handleBallClick() {
  // 开关是异步的（对话窗是 uTools 自己的浏览器窗口），状态要等它落定再报给面板，
  // 否则面板上那颗按钮的字会慢一拍（点了「打开对话」还写着「打开对话」）。
  toggleChatWindow().then(emit, (e) => {
    console.error('[host] 开关对话窗失败:', e)
    emit()
  })
}

// 菜单项的文案跟着窗口状态走：开着的时候第一项该是「关闭对话」。
function menuItems() {
  return [
    { id: 'chat', label: windows.isChatVisible() ? '关闭对话' : '打开对话' },
    { id: 'hide', label: '隐藏悬浮球' },
  ]
}

function handleMenuPick(id) {
  if (id === 'chat') {
    toggleChatWindow().then(emit, (e) => {
      console.error('[host] 开关对话窗失败:', e)
      emit()
    })
    return
  }
  if (id === 'hide') windows.hideBall()
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

// ---------------------------------------------------------------- 生命周期

// ipcRenderer 的监听是进程级的不随窗口销毁解绑，只能注册一次；
// 注册两次的话窗口每次重建都会让每条消息被处理两遍（球会一下开出两个对话窗）。
let ipcRegistered = false
function setupOnce() {
  if (ipcRegistered) return
  ipcRegistered = true
  registerBallIpc()
}

// 加载完成、正式进入之前的一次性初始化。
// 这里故意不建悬浮球：窗口创建在 onPluginReady 里做太早，uTools 还没进入插件，
// 而且 onPluginEnter 一定会紧随其后，放那边更稳。
utools.onPluginReady(() => {
  setupOnce()

  // 自己注册的全局热键：按一下 = 开/关对话窗（和点悬浮球一样）
  hotkey.setFireHandler(() => {
    toggleChatWindow()
  })
  hotkey.onChange(() => emit())
  ensureHotkey()

  // 保活：uTools 回收插件进程后，靠这个每分钟的定时任务把自己拉回来
  // （官方文档写明 onScheduleTrigger 在插件未运行时也会拉起进程）。
  try {
    utools.requestSchedule({
      code: KEEPALIVE_CODE,
      label: 'DeepSeek 悬浮助手保活',
      trigger: { cron: KEEPALIVE_CRON },
    })
  } catch (e) {
    console.error('[plugin] 注册保活定时任务失败（热键和悬浮球在插件被回收后会暂时失效）:', e)
  }
})

utools.onScheduleTrigger(() => {
  keepAliveTick()
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
  // 热键助手是插件的子进程，进程重建之后要补回来（正常由保活定时任务兜着）
  ensureHotkey()
  // 选中文字进来的（plugin.json 里那几条 over / regex 指令）：把文字丢给对话窗去问，
  // 这次不是来开面板的。这几条 feature 都带了 mainHide，正常不会显示主窗口。
  if (action && ASK_CODES.indexOf(action.code) !== -1) {
    console.log('[plugin] 提问进入:', action.code, '（from=' + (action.from || '?') + '）')
    askChatWindow(action)
    return
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

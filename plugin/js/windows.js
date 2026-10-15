// DeepSeek 悬浮助手 —— 窗口管理
//
// 只在插件主 preload 里被 require。悬浮球窗和对话窗都由这里创建并持有引用：
//   - createBrowserWindow(url, ...) 的 url 只接受「相对于插件根目录的本地 HTML」，
//     不能直接传外部网址；窗口实例上又没有 loadURL 可用（实测抛 "win.loadURL is not a function"）。
//     所以对话窗装的是本地宿主页 page/chat.html，官网友在它里面的 <webview> 里。
//   - uTools 没有「按 id 取回自定义窗口」的 API，复用只能靠自己存实例 + isDestroyed() 判活。

const config = require('./config')

// 悬浮球窗口尺寸（DIP）。球体在窗口内留 2px 内边距画投影，
// 余量越小，透明窗口四角那圈"看不见但能点到"的死区越小。
const BALL_SIZE = 60

let ballWin = null
let chatWin = null
let dragOrigin = null

// 有些窗口方法的可用性在 uTools 各版本间并不一致（loadURL 就是这么没的），
// 而这些判断函数每次取窗口状态都会被调用 —— 真出问题是"查日志"，不是"刷屏"，所以同一条只报一次。
const warned = new Set()

function warnOnce(key, message, err) {
  if (warned.has(key)) return
  warned.add(key)
  if (err) console.error(message, err)
  else console.error(message)
}

function alive(win) {
  if (!win) return null
  try {
    return win.isDestroyed() ? null : win
  } catch (e) {
    // 问不出来就当它活着：引用还在手上，凭空丢掉只会导致重复开窗
    warnOnce('isDestroyed', '[windows] window.isDestroyed 不可用，按"窗口还活着"处理:', e)
    return win
  }
}

function getBallWindow() {
  ballWin = alive(ballWin)
  return ballWin
}

function getChatWindow() {
  chatWin = alive(chatWin)
  return chatWin
}

// ---------- 位置计算 ----------

const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }

function primaryWorkArea() {
  try {
    return utools.getPrimaryDisplay().workArea
  } catch (e) {
    return FALLBACK_WORK_AREA
  }
}

function workAreaFor(x, y) {
  try {
    return utools.getDisplayNearestPoint({ x, y }).workArea
  } catch (e) {
    return primaryWorkArea()
  }
}

// 夹到「光标所在那块屏」的可用区域里（排除任务栏）。保存的位置可能来自一块
// 已经拔掉的显示器，getDisplayNearestPoint 会给出最近的屏，于是顺手把球拉回可见范围。
function clampToWorkArea(x, y) {
  const wa = workAreaFor(x, y)
  return {
    x: Math.round(Math.min(Math.max(x, wa.x), wa.x + wa.width - BALL_SIZE)),
    y: Math.round(Math.min(Math.max(y, wa.y), wa.y + wa.height - BALL_SIZE)),
  }
}

function defaultBallPos() {
  const wa = primaryWorkArea()
  return clampToWorkArea(wa.x + wa.width - BALL_SIZE - 32, wa.y + wa.height - BALL_SIZE - 64)
}

function resolveBallPos() {
  const saved = config.getBallPos()
  return saved ? clampToWorkArea(saved.x, saved.y) : defaultBallPos()
}

// ---------- 悬浮球 ----------

/**
 * 幂等地保证悬浮球存在并可见。不碰配置——是否「应该显示」由调用方决定。
 */
function ensureBall() {
  const existing = getBallWindow()
  if (existing) {
    if (!existing.isVisible()) existing.show()
    return existing
  }

  const pos = resolveBallPos()

  // 官方示例的写法是 `const win = createBrowserWindow(..., () => { win.show() })`，
  // 闭包引用的 win 能在回调里用，说明回调一定晚于 createBrowserWindow 返回。
  // 但这条时序没写进文档，不值得赌：这里让回调碰不到未初始化的变量，
  // 万一回调是同步触发的，下面 `if (callbackRan)` 那一行会补上。
  let ready = false
  let callbackRan = false

  function activate(win) {
    if (!win || ready) return
    ready = true
    try {
      win.setAlwaysOnTop(true, 'screen-saver')
    } catch (e) {
      // 置顶层级只是个加分项，设不上不影响使用
    }
    win.show()
    // 窗口真正显示之后再让页面播入场动画，否则动画会在隐藏期间就跑完
    try {
      win.webContents.send('ball:shown')
    } catch (e) {
      console.error('[ball] 通知显示失败:', e)
    }
  }

  // show: false + 页面加载完再 show()，避免先闪一个未绘制完成的窗口。
  const win = utools.createBrowserWindow('page/ball.html', {
    show: false,
    x: pos.x,
    y: pos.y,
    width: BALL_SIZE,
    height: BALL_SIZE,
    frame: false,
    transparent: true,
    // 官方文档：透明窗口要收到鼠标事件，backgroundColor 得设成「接近全透明但确实有背景」的
    // 颜色。写成纯 #00000000 时部分环境下窗口收不到鼠标事件，球就点不动了。
    backgroundColor: 'rgba(255, 255, 255, 0.01)',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: 'page/ball-preload.js',
    },
  }, () => {
    callbackRan = true
    activate(ballWin)
  })

  ballWin = win
  if (callbackRan) activate(win)
  return win
}

function showBall() {
  const win = ensureBall()
  config.setBallVisible(true)
  return win
}

function hideBall() {
  const win = getBallWindow()
  if (win) {
    win.destroy()
    ballWin = null
    dragOrigin = null
  }
  // 菜单状态要跟着一起清，否则下次建球时会被当成"还撑着"而跳过撑开。
  preMenuBounds = null
  lastMenuGeom = null
  config.setBallVisible(false)
}

/**
 * 「找回悬浮球」：清掉记住的位置、放回主屏右下角并显示出来。
 * 球被拖到屏幕外或者换过显示器之后靠这个救回来。
 */
function resetBallPos() {
  if (preMenuBounds) collapseBallMenu()
  config.clearBallPos()
  const pos = defaultBallPos()
  const win = ensureBall()
  try {
    win.setPosition(pos.x, pos.y)
    win.show()
  } catch (e) {
    console.error('[ball] 重置位置失败:', e)
  }
  config.setBallPos(pos.x, pos.y)
  config.setBallVisible(true)
  return pos
}

// ---------- 悬浮球拖拽 ----------
//
// 拖动由悬浮球窗口自己按帧驱动（它是可见窗口，定时器不会被 Chromium 的后台节流钳住；
// 主窗口隐藏后主 preload 里的定时器会被钳到 1Hz，用来做拖拽会卡成幻灯片）。
// 球只上报「相对按下点的位移」，真实位置和边界夹取都在这里做，
// 这样即使贴边被夹住，球也不会相对光标漂移。

function beginDrag() {
  const win = getBallWindow()
  if (!win) return
  // 菜单还开着就先收回去，不然拖的是那个撑大的包围盒窗口，位置全乱。
  if (preMenuBounds) collapseBallMenu()
  const [x, y] = win.getPosition()
  dragOrigin = { x, y }
}

function dragTo(dx, dy) {
  const win = getBallWindow()
  if (!win || !dragOrigin) return
  const pos = clampToWorkArea(dragOrigin.x + (Number(dx) || 0), dragOrigin.y + (Number(dy) || 0))
  win.setPosition(pos.x, pos.y)
}

function endDrag() {
  const win = getBallWindow()
  dragOrigin = null
  if (!win) return
  const [x, y] = win.getPosition()
  config.setBallPos(x, y)
}

// ---------- 悬浮球右键菜单 ----------
//
// 球窗只有 60×60，装不下菜单。做法是打开菜单时把球窗临时撑成「球 + 菜单」的包围盒，
// 再把球和菜单各自在这个大窗里的坐标告诉球页，由球页负责画。
// 关掉时恢复原尺寸，球在屏幕上的位置分毫不动。

const MENU_WIDTH = 156
const MENU_ROW_HEIGHT = 34
const MENU_PADDING = 8
const MENU_GAP = 8

let preMenuBounds = null
let lastMenuGeom = null

function menuSize(itemCount) {
  const rows = Math.max(1, Number(itemCount) || 1)
  return {
    width: MENU_WIDTH,
    height: rows * MENU_ROW_HEIGHT + MENU_PADDING * 2,
  }
}

/**
 * 撑开球窗以容纳菜单，返回球与菜单各自在窗口坐标系里的位置。
 * 窗口已撑开时直接返回上次的几何数据（重复右键不会越撑越大）。
 */
function expandBallForMenu(itemCount) {
  const win = getBallWindow()
  if (!win) return null
  if (preMenuBounds) return lastMenuGeom

  const ball = win.getBounds()
  const size = menuSize(itemCount)
  const wa = workAreaFor(ball.x, ball.y)

  // 默认向上弹（球多半贴屏幕底边），上面放不下就翻到下面。
  let menuX = ball.x
  let menuY = ball.y - MENU_GAP - size.height
  if (menuY < wa.y) menuY = ball.y + ball.height + MENU_GAP
  // 贴到另外三条边时往回收，保证菜单整块可见。
  menuX = Math.min(Math.max(menuX, wa.x), wa.x + wa.width - size.width)
  menuY = Math.min(Math.max(menuY, wa.y), wa.y + wa.height - size.height)

  const left = Math.min(ball.x, menuX)
  const top = Math.min(ball.y, menuY)
  const right = Math.max(ball.x + ball.width, menuX + size.width)
  const bottom = Math.max(ball.y + ball.height, menuY + size.height)

  preMenuBounds = ball
  const geom = {
    ball: { x: ball.x - left, y: ball.y - top },
    menu: { x: menuX - left, y: menuY - top, width: size.width, height: size.height },
  }
  lastMenuGeom = geom
  // 让球窗拿到焦点：菜单开着时用户点到别的窗口上，球窗会收到 blur，
  // 球页据此把菜单收起来 —— 否则那个撑大的透明窗口会一直挂在桌面上挡住点击。
  try {
    win.focus()
  } catch (e) {
    console.error('[ball] 聚焦球窗失败（菜单需要手动点一下才能关，不影响使用）:', e)
  }
  setBoundsForced(win, { x: left, y: top, width: right - left, height: bottom - top })
  return geom
}

/**
 * 改窗口尺寸。先直接改，改不动才走临时放开 resizable 的路子 ——
 * 有些平台上 resizable:false 的窗口会忽略程序化的 setBounds，
 * 但反复改 resizable 对透明窗口有副作用，所以不到必要时不碰。
 */
function setBoundsForced(win, bounds) {
  try {
    win.setBounds(bounds)
    const now = win.getBounds()
    if (now.width === bounds.width && now.height === bounds.height &&
      now.x === bounds.x && now.y === bounds.y) {
      return
    }
  } catch (e) {
    console.error('[ball] setBounds 失败，改用放开 resizable 的方式:', e)
  }
  try {
    win.setResizable(true)
    win.setBounds(bounds)
  } catch (e) {
    console.error('[ball] 改窗口尺寸彻底失败:', e)
  } finally {
    try {
      win.setResizable(false)
    } catch (e) {
      console.error('[ball] 恢复 resizable 失败:', e)
    }
  }
}

/**
 * 收起菜单：窗口缩回 60×60 并回到撑开前的位置。
 */
function collapseBallMenu() {
  const win = getBallWindow()
  const bounds = preMenuBounds
  preMenuBounds = null
  lastMenuGeom = null
  if (!win || !bounds) return
  setBoundsForced(win, bounds)
}

// ---------- DeepSeek 对话窗 ----------

// 默认按手机比例做，比真手机窗口略大一圈：窄而高，和官网手机版布局对得上，
// 不会像宽窗口那样在两侧留一大片空白。
const DEFAULT_CHAT_SIZE = { width: 460, height: 900 }
const MIN_CHAT_SIZE = { width: 320, height: 400 }
const MAX_CHAT_SIZE = { width: 1600, height: 1600 }

function clampNumber(value, min, max) {
  const n = Number(value)
  if (!isFinite(n)) return min
  return Math.round(Math.min(Math.max(n, min), max))
}

/**
 * 算出对话窗该用多大：存过的尺寸（没有就用手机尺寸），再夹进当前主屏的可用区域。
 * 夹取是为了别在 768 高的小屏笔记本上开出一个半截在屏幕外的窗口。
 * @param {{width:number,height:number}} [override] 用这套尺寸代替存储里的（设置面板保存时用）
 */
function resolveChatSize(override) {
  const saved = override || config.getChatSize() || DEFAULT_CHAT_SIZE
  const wa = primaryWorkArea()
  return {
    width: clampNumber(saved.width, MIN_CHAT_SIZE.width, Math.min(MAX_CHAT_SIZE.width, wa.width)),
    height: clampNumber(saved.height, MIN_CHAT_SIZE.height, Math.min(MAX_CHAT_SIZE.height, wa.height)),
  }
}

/**
 * 保存设置面板填的尺寸。先夹取再落库 —— 存进去的就是下次真正会用的大小，
 * 面板回填的也是这个值，不会出现"填了 3000 高、开出来却是 1080"的错位。
 */
function saveChatSize(width, height) {
  const size = resolveChatSize({ width, height })
  config.setChatSize(size.width, size.height)
  return size
}

/**
 * 面板上点「应用」：存下来，并且**当场**把已经开着的那个窗口改成这个大小。
 *
 * 为什么要动活窗口：关窗现在是 hide 复用，窗口会一直活着 —— 只写库的话，
 * 用户点了「应用」在界面上什么都不会发生，等到下次窗口真的被重建才生效（可能是几天后）。
 */
function applyChatSize(width, height) {
  const size = saveChatSize(width, height)
  const win = getChatWindow()
  if (!win) return size
  try {
    if (typeof win.setSize === 'function') win.setSize(size.width, size.height)
    else win.setBounds({ width: size.width, height: size.height })
  } catch (e) {
    // 改不动就只落库：下次窗口重建时会按新尺寸开，不是"白设"。
    warnOnce('setSize', '[chat] window.setSize 不可用，新尺寸下次开窗生效:', e)
  }
  return size
}

function resetChatSize() {
  config.clearChatSize()
  return resolveChatSize()
}

/**
 * 对话窗开着没有。判据是"可见"：窗口被手动关掉后 getChatWindow() 会返回 null，
 * 而最小化的窗口在这里也算"开着" —— 点一下球把它关掉也说得通。
 */
function isChatVisible() {
  const win = getChatWindow()
  if (!win) return false
  try {
    const visible = win.isVisible()
    if (typeof visible === 'boolean') return visible
  } catch (e) {
    warnOnce('isVisible', '[chat] window.isVisible 不可用，按"已打开"处理（点球会关掉它）:', e)
    return true
  }
  // 拿不到布尔值也按"开着"处理：这样点球仍然是"关闭"，开开关关依然成立。
  // 反过来（按"关着"处理）会让点球永远只做 show()，再也关不掉窗口。
  return true
}

/**
 * 打开或聚焦 DeepSeek 对话窗。已存在就前置，不重复开窗。
 *
 * 窗口装的是本地宿主页 page/chat.html，官网友在它的 <webview> 里 —— 这套做法是从参考插件
 * （JinkoWu 的 DeepSeek）搬来的，同一台机器上它能把 chat.deepseek.com 正常打开。
 * 早先那一版是让窗口自己顶层导航到官网，官网那两只带 integrity + crossorigin 的脚本
 * 在那种窗口里加载不起来（请求 0 字节结束，官网弹「页面资源加载异常」），所以换掉了。
 *
 * webPreferences 里有两项是关键，而 uTools 的窗口选项类型定义里没声明它们，
 * 靠透传给 Electron：
 *   - webSecurity: false —— 关掉同源策略。代价只落在这个窗口里（它只装 chat.deepseek.com），
 *     换来的是官网的跨域资源不再被 CORS 那一层卡住；
 *   - webviewTag: true   —— 不给的话页面上根本没有 <webview> 可用。
 */
function openChat() {
  const existing = getChatWindow()
  if (existing) {
    existing.show()
    existing.focus()
    return existing
  }

  const size = resolveChatSize()
  const win = utools.createBrowserWindow('page/chat.html', {
    show: true,
    title: 'DeepSeek',
    width: size.width,
    height: size.height,
    minWidth: MIN_CHAT_SIZE.width,
    minHeight: MIN_CHAT_SIZE.height,
    center: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      // 宿主页的 preload：上次的会话地址、登录令牌的镜像、剪贴板与粘贴都从它挂出来的
      // window.chatHost 上取（页面自己不碰 utools 全局）。
      preload: 'page/chat-preload.js',
      webSecurity: false,
      webviewTag: true,
      devTools: true,
    },
  })

  chatWin = win
  return win
}

/**
 * 点悬浮球的行为：开着就关，关着就开。
 * @returns {boolean} true 表示这次是"打开"
 */
function toggleChat() {
  if (isChatVisible()) {
    closeChat()
    return false
  }
  openChat()
  return true
}

/**
 * 把对话窗收起来。
 *
 * 这里是 hide 而不是销毁：窗口留着，里面那一页（登录态、正在打的字、滚动位置）都还在，
 * 点球再开是一瞬间的事。uTools 官方文档也明确警告过不要在 onPluginOut 里关闭自定义窗口，
 * 留着窗口正顺着这条规矩。hide 失败才退回销毁 —— 那说明这个窗口已经不健康了。
 *
 * 注意 chatWin 引用要留着，下次 openChat 就是把它 show() 出来。
 */
function closeChat() {
  const win = getChatWindow()
  if (!win) return
  try {
    win.hide()
  } catch (e) {
    warnOnce('hide', '[chat] window.hide 不可用，改销毁窗口:', e)
    chatWin = null
    try {
      win.destroy()
    } catch (e2) {
      console.error('[chat] 销毁窗口也失败:', e2)
    }
  }
}

// ---------- 把选中文字送进对话窗 ----------

/**
 * 执行一次"向 DeepSeek 提问/翻译/总结"：开窗（或前置）之后，把这一步的进入动作交给
 * 宿主页，由它粘进官网输入框、该发送就发送。
 *
 * 交给页面的方式是 executeJavaScript —— 父 → 子只有这一条路（宿主页是本地页，
 * 父窗没有别的办法跟它说话）；为了敲得着，宿主页把入口挂在 window.dsChat 上。
 *
 * 为什么要重试：窗口刚建出来时宿主页的脚本可能还没跑完，那一下 window.dsChat 是 undefined，
 * executeJavaScript 会静静地返回 undefined（不报错）。所以这里以"返回值是不是 true"为准，
 * 拿不到就等下一轮 —— 一次提问没有第二次机会，不能靠"应该加载完了"。
 *
 * @param {{code?: string, payload?: string}} action uTools 的进入动作
 * @returns {Promise<boolean>} 有没有把提问递进页面
 */
function askChat(action) {
  const data = {
    code: (action && action.code) || '',
    payload: (action && action.payload) || '',
  }
  const win = openChat()
  // 粘贴是往系统里注入按键，窗口必须在眼前；窗口本来就开着也要前置一下，
  // 否则用户会看到"文字进了剪贴板但没粘到任何地方"。
  try {
    win.show()
    win.focus()
  } catch (e) {
    warnOnce('askShow', '[chat] 前置对话窗失败（粘贴可能落不到输入框）:', e)
  }

  let wc = null
  try {
    wc = win.webContents
  } catch (e) {
    wc = null
  }
  if (!wc || typeof wc.executeJavaScript !== 'function') {
    warnOnce('askExecute', '[chat] webContents.executeJavaScript 不可用，提问送不进去')
    return Promise.resolve(false)
  }

  const code = 'window.dsChat && window.dsChat.ask && (window.dsChat.ask(' +
    JSON.stringify(data) + '), true)'

  function attempt(triesLeft) {
    let call = null
    try {
      call = wc.executeJavaScript(code, false)
    } catch (e) {
      warnOnce('askThrow', '[chat] executeJavaScript 抛错，提问送不进去:', e)
      return Promise.resolve(false)
    }
    return Promise.resolve(call).then((ok) => {
      if (ok === true) return true
      if (triesLeft <= 0) {
        console.error('[chat] 提问没能送进对话窗（宿主页没加载起来？）')
        return false
      }
      return sleep(100).then(() => attempt(triesLeft - 1))
    })
  }

  return attempt(50)
}

function sleep(ms) {
  return new Promise((ok) => setTimeout(ok, ms))
}

// ---------- 全局快捷键：把窗口"叫到跟前" ----------

/**
 * 对话窗是不是就在最前面（拿着焦点）。
 *
 * 拿不到 isFocused 时一律按"不在最前面"处理：快捷键的职责是"把窗口叫出来"，
 * 叫不出来最多是白按一下；反过来判成"在最前面"，就会把用户正想看的窗口关掉。
 */
function isChatFocused(win) {
  const target = win || getChatWindow()
  if (!target) return false
  try {
    const focused = target.isFocused()
    if (typeof focused === 'boolean') return focused
  } catch (e) {
    warnOnce('isFocused', '[chat] window.isFocused 不可用，快捷键只做"调到前台"（不再靠它关窗）:', e)
  }
  return false
}

/** 把对话窗调到最前面：最小化了先还原，然后显示并聚焦 */
function bringChatToFront(win) {
  const target = win
  try {
    // 最小化的窗口 isVisible() 仍然是 true（它是"显示着但缩了"），
    // 所以这里得单独认一下，否则 show() 只会把它从任务栏捞出来，窗口还缩着。
    if (typeof target.isMinimized === 'function' && typeof target.restore === 'function' && target.isMinimized()) {
      target.restore()
    }
  } catch (e) {
    warnOnce('restore', '[chat] window.restore 不可用，直接 show():', e)
  }
  try {
    target.show()
  } catch (e) {
    warnOnce('show', '[chat] window.show 失败:', e)
  }
  try {
    target.focus()
  } catch (e) {
    warnOnce('focus', '[chat] window.focus 失败:', e)
  }
}

/**
 * 全局快捷键按一下该干什么 —— **三态**，和"点悬浮球"的纯开关刻意不一样：
 *
 *   窗口没开                         → 打开
 *   开着但不在最前面（被盖住/最小化） → 调到最前面，**不关**
 *   开着且就在最前面                 → 关掉
 *
 * 为什么不全用"开着就关"：鼠标点球的时候窗口就在眼前，点一下关掉是明确的意图；
 * 按快捷键的时候窗口多半藏在别的窗口后面，用户要的是"给我调出来"。
 * 这时候要是把它关掉，就成了"我想看它、它却没了"——按键盲操最容易踩这个。
 * 所以快捷键的第一下永远是"把它摆到你面前"，只有它已经在面前了，再按才是收起。
 *
 * @returns {'open'|'front'|'close'} 这次做了什么（调用方据此决定要不要收 uTools 搜索框，也方便单测）
 */
function summonChat() {
  const win = getChatWindow()
  if (!win) {
    openChat()
    return 'open'
  }
  if (isChatFocused(win)) {
    closeChat()
    return 'close'
  }
  bringChatToFront(win)
  return 'front'
}

// ---------- 记住上次打开的会话 ----------

// 官网的会话地址长这样：https://chat.deepseek.com/a/chat/s/75e63fe1-08bc-4e0b-a957-270557e00482
const CONVERSATION_RE = /^https:\/\/chat\.deepseek\.com\/a\/chat\/s\/[0-9A-Za-z_-]+/
// 对话首页（新对话 / 刚登录进来），命中它就把记住的会话忘掉
const CHAT_HOME_RE = /^https:\/\/chat\.deepseek\.com(?:\/a\/chat)?\/?(?:[?#].*)?$/

/**
 * 对话窗报上来一个地址，决定要不要记住。
 * 只认会话地址；回到对话首页就清掉；登录页、中间的跳转页一律不动 ——
 * 那些只是路过，不该把用户上一次的会话冲掉。
 *
 * "下次该开哪个地址"由宿主页自己读（page/chat-preload.js 把 config 递过去），
 * 所以这边只有这一条：**记哪个、什么时候忘**。
 */
function rememberChatUrl(url) {
  if (typeof url !== 'string' || !url) return
  const clean = url.split('#')[0]
  if (CONVERSATION_RE.test(clean)) {
    // 去掉 hash（SPA 的临时状态），查询串保留
    config.setLastChatUrl(clean)
    return
  }
  if (CHAT_HOME_RE.test(clean)) config.setLastChatUrl(null)
}

module.exports = {
  BALL_SIZE,
  DEFAULT_CHAT_SIZE,
  MIN_CHAT_SIZE,
  MAX_CHAT_SIZE,
  getBallWindow,
  getChatWindow,
  ensureBall,
  showBall,
  hideBall,
  resetBallPos,
  beginDrag,
  dragTo,
  endDrag,
  expandBallForMenu,
  collapseBallMenu,
  openChat,
  closeChat,
  toggleChat,
  isChatVisible,
  askChat,
  summonChat,
  isChatFocused,
  resolveChatSize,
  saveChatSize,
  applyChatSize,
  resetChatSize,
  // 会话地址的取舍规则（记住会话、回首页忘掉、别的不碰）留在父窗这一侧：
  // 宿主页只负责把地址报上来（chat:url），"值不值得记"由这里说了算。
  rememberChatUrl,
}

// DeepSeek 悬浮助手 —— 窗口管理
//
// 只在插件主 preload 里被 require。悬浮球窗和对话窗都由这里创建并持有引用：
//   - createBrowserWindow(url, ...) 的 url 只接受「相对于插件根目录的本地 HTML」，
//     不能直接传外部网址。而窗口实例上又没有 loadURL 可用（见 openChat 的注释），
//     所以官网由 page/chat.html 自己导航过去。
//   - uTools 没有「按 id 取回自定义窗口」的 API，复用只能靠自己存实例 + isDestroyed() 判活。

const config = require('./config')
const repair = require('./repair')
const trace = require('./trace')

const SITE = 'https://chat.deepseek.com/'

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
 * 这里**不**负责加载官网。createBrowserWindow 的第一个参数只收插件目录内的本地路径，
 * 而 uTools 返回的窗口实例上并没有 loadURL（实测 v8.0.0 直接抛
 * "win.loadURL is not a function"，类型定义里写着有，运行时没给）。
 * 所以跳转改由 page/chat.html 自己 location.replace 到目标地址 —— 那就是一次普通网页导航，
 * 不依赖任何 uTools API。那页在跳不过去时会显示兜底界面。
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
      // 这个 preload 会在窗口的每次导航里重跑：先跑在本地落地页上（把该跳的地址告诉它），
      // 之后跟着页面一起跑到官网里（把当前地址上报回来，好记住是哪个会话）。
      preload: 'page/chat-preload.js',
    },
  })

  chatWin = win
  watchChatNetwork(win)
  // 控制台那一条是按 webContents 算的（session 那条是按 session，只挂一次就够），
  // 所以这里单独把 webContents 取出来交给它。
  let chatWc = null
  try {
    chatWc = win.webContents
  } catch (e) {
    chatWc = null
  }
  watchChatConsole(chatWc)
  return win
}

// ---------- 从父窗这一侧盯网络 ----------

// 目的地在同一个 session 上（uTools 所有窗口共用一个默认 session），
// 所以 webRequest 只要挂一次就够，多挂会让每条请求被记两遍。
let netWatched = false

// 只盯官网相关的域名：这个过滤器是"拿整个 uTools 的请求流"来过一遍的，
// 不加范围的话，uTools 自己和别的插件发的请求也会跟着进来。
const NET_FILTER = { urls: ['*://chat.deepseek.com/*', '*://*.deepseek.com/*'] }

/**
 * 把对话窗发出的请求记到排查日志里 —— **父窗这一侧的视角**。
 *
 * 为什么值得再来这一层：页面里那套（包 XHR/fetch、听元素 error 事件）看得见"谁失败了"，
 * 但看不见"是谁拦的"。网络层这里带的是浏览器/Electron 自己的错误码
 * （`net::ERR_BLOCKED_BY_CLIENT`、`net::ERR_ABORTED`、`net::ERR_FAILED`…），
 * 那个名字往往直接把拦人的那一层点出来 —— 之前"元素发起的请求会 0 字节结束"
 * 这个现象，一直缺的就是这么个名字。
 *
 * 两条路，先试哪条是有讲究的：
 *   1. `session.webRequest` —— 最省事，给的是 Electron 的错误码；
 *   2. 退而求其次用 `webContents.debugger`（CDP 的 Network 域）—— 给的是
 *      `errorText` + `blockedReason`，信息一样管用，但**和开发者工具互斥**：
 *      同一个 webContents 上已经有调试器（开发者工具就是一个）时 attach 会失败。
 * 两条都没成的话，日志里会留一句"为什么没成"，不会静默 —— 静默过一次就够了：
 * 头一版就是失败时只打 console，结果日志里看不出到底挂没挂上。
 *
 * 只记两种，不让日志变成流水账：
 *   - 出错的：这就是我们要找的那类；
 *   - HTTP >= 400 的：和页面侧那份相互印证。
 * 正常的 200 一条都不记 —— 一次页面加载就有几十条。
 */
function watchChatNetwork(win) {
  if (netWatched) return
  netWatched = true
  let wc = null
  try {
    wc = win.webContents
  } catch (e) {
    wc = null
  }
  if (!wc) {
    trace.append('网络层观察: 取不到 webContents，这一层看不成')
    return
  }
  if (watchViaSession(wc)) return
  watchViaDebugger(wc)
}

/**
 * 第一条路：session.webRequest。成了返回 true（并且已经写了"挂上了"那行）。
 * 没成返回 false，并且把**原因**写进日志 —— 这样下次读日志时一眼就知道
 * 该换哪条路，而不是猜"到底挂没挂上"。
 */
function watchViaSession(wc) {
  let session = null
  try {
    session = wc.session
  } catch (e) {
    trace.append('网络层观察: 取 webContents.session 抛错（' + ((e && e.message) || e) + '），改用 CDP')
    return false
  }
  if (!session || !session.webRequest) {
    trace.append('网络层观察: ' + (session ? 'session 上没有 webRequest' : 'webContents 上没有 session') +
      '，改用 CDP')
    return false
  }
  try {
    if (typeof session.webRequest.onErrorOccurred === 'function') {
      session.webRequest.onErrorOccurred(NET_FILTER, (details) => {
        try {
          trace.append('网络层出错: ' + details.method + ' ' + details.url + ' → ' + details.error +
            '（' + (details.resourceType || '?') + '）')
        } catch (e) {}
      })
    }
    if (typeof session.webRequest.onCompleted === 'function') {
      session.webRequest.onCompleted(NET_FILTER, (details) => {
        try {
          if ((details.statusCode || 0) < 400) return
          trace.append('网络层拒绝: ' + details.method + ' ' + details.url + ' → HTTP ' +
            details.statusCode + '（' + (details.resourceType || '?') + '）')
        } catch (e) {}
      })
    }
    trace.append('网络层观察已挂上: session.webRequest（这一行只在进程里第一次开对话窗时出现一次）')
    return true
  } catch (e) {
    trace.append('网络层观察: 挂 session.webRequest 失败（' + ((e && e.message) || e) + '），改用 CDP')
    return false
  }
}

/**
 * 第二条路：CDP（`webContents.debugger` → Network 域）。
 *
 * 和 webRequest 的区别不只是"备用"：CDP 的 `Network.loadingFailed` 多给一个
 * `blockedReason`（`csp` / `mixed-content` / `inspector` …），那个字段直接说出
 * **是谁**拦的；`errorText` 则是 `net::` 错误码。两个一起看，基本就定案了。
 *
 * 一个必须说清楚的代价：**开发者工具开着的时候 attach 会失败**（同一个
 * webContents 只允许一个调试器）。所以这条路要求"先把开发者工具关掉" ——
 * 失败时日志里会留话，不会让人一头雾水。
 */
function watchViaDebugger(wc) {
  let dbg = null
  try {
    dbg = wc.debugger
  } catch (e) {
    dbg = null
  }
  if (!dbg || typeof dbg.attach !== 'function') {
    trace.append('网络层观察: 也没有 webContents.debugger，这一层这次看不成')
    return false
  }
  // requestId → url：`Network.loadingFailed` 只给 requestId，地址得自己记住
  const urls = new Map()
  const remember = (id, url) => {
    try {
      if (id && url) urls.set(id, url)
      if (urls.size > 200) urls.delete(urls.keys().next().value)
    } catch (e) {}
  }
  try {
    dbg.attach('1.3')
    dbg.on('message', (_event, method, params) => {
      try {
        if (method === 'Network.requestWillBeSent') {
          remember(params.requestId, params.request && params.request.url)
          return
        }
        if (method === 'Network.loadingFailed') {
          trace.append('网络层出错: ' + (params.type || '?') + ' ' +
            (urls.get(params.requestId) || params.requestId) + ' → ' + params.errorText +
            (params.blockedReason ? '（blockedReason=' + params.blockedReason + '）' : '') +
            (params.canceled ? '（被取消）' : ''))
          return
        }
        if (method === 'Network.responseReceived') {
          const res = params.response || {}
          if ((res.status || 0) < 400) return
          trace.append('网络层拒绝: ' + (params.type || '?') + ' ' + res.url + ' → HTTP ' + res.status)
        }
      } catch (e) {}
    })
    dbg.sendCommand('Network.enable')
    trace.append('网络层观察已挂上: CDP Network 域（这个窗口的开发者工具得关着才挂得上）')
    return true
  } catch (e) {
    trace.append('网络层观察: CDP 也没挂上（' + ((e && e.message) || e) +
      '）—— 开发者工具开着的时候挂不上，关掉它再复现一次')
    return false
  }
}

// ---------- 从父窗这一侧读页面的控制台 ----------

// 官网自己会往控制台打很多日志（埋点、调试），全收进来会把排查日志淹掉，
// 所以只留认得出是"没加载成"的那些。另外 error 级别的一律留。
const CONSOLE_RE = /net::|ERR_|Failed to load|Refused to|integrity|blocked|violat|CORS|cross-origin|Mixed Content|Content Security/i
const CONSOLE_MAX = 40
let consoleLines = 0

/**
 * 把对话窗页面的控制台消息记进排查日志。
 *
 * 这一层是冲着**唯一一句能直接说清楚的话**去的：资源加载失败时，浏览器会往控制台写一行
 * `Failed to load resource: net::ERR_BLOCKED_BY_CLIENT`（或 ERR_FAILED / ERR_ABORTED…）。
 * 那句话**不经过页面里的 console 对象** —— 是浏览器内部直接塞进控制台的，
 * 所以在页面里包 console.error 也收不到它；只有从 webContents 这一侧听得见。
 * 它带着的错误码就是"是谁拦的"的证据，前面几轮一直缺的正是这一句。
 *
 * 挂不上的可能要说清楚：uTools 给的窗口对象是个代理，不是原生 BrowserWindow
 * （实测它上面既没有 session 也没有 debugger），这条路同样可能没有 ——
 * 那就把"为什么没成"写进日志，不静默。
 *
 * 参数和上面两条路一样是 **webContents**（不是窗口）：这样自检能各自单独喂一个假的进来跑。
 */
function watchChatConsole(wc) {
  if (!wc || typeof wc.on !== 'function') {
    trace.append('控制台观察: webContents 上没有 on()（uTools 的窗口代理没给这条路），这一层看不成')
    return
  }
  try {
    wc.on('console-message', function () {
      try {
        const args = arguments
        let msg = ''
        let level = ''
        // Electron 30 之后传一个对象；再早是 (event, level, message, line, sourceId)。
        // 两种都认，免得因为版本不同白挂一场。
        if (args.length === 1 && args[0] && typeof args[0] === 'object' && args[0].message) {
          msg = String(args[0].message)
          level = String(args[0].level || '')
        } else {
          msg = typeof args[2] === 'string' ? args[2] : ''
          level = String(args[1])
        }
        if (!msg) return
        const isError = level === 'error' || level === '3'
        if (!isError && !CONSOLE_RE.test(msg)) return
        if (consoleLines >= CONSOLE_MAX) return
        consoleLines++
        trace.append('页面控制台: ' + msg.replace(/\s+/g, ' ').slice(0, 300))
      } catch (e) {}
    })
    trace.append('控制台观察已挂上: webContents console-message（"Failed to load resource: net::ERR_…" 这类行会落到这里）')
  } catch (e) {
    trace.append('控制台观察: 挂 console-message 失败（' + ((e && e.message) || e) + '）')
  }
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

function closeChat() {
  const win = getChatWindow()
  chatWin = null
  if (!win) return
  try {
    win.close()
  } catch (e) {
    // close 可能被页面拦下（beforeunload 之类），那就别客气了
    console.error('[chat] close 失败，直接销毁:', e)
    try {
      win.destroy()
    } catch (e2) {
      console.error('[chat] 销毁窗口也失败:', e2)
    }
  }
}

// ---------- 官网脚本没加载起来：带缓存绕过重载一次 ----------

/**
 * 重载对话窗，并且**绕过 HTTP 缓存**。
 *
 * 官网那两个 <script> 带 integrity（SRI）校验：响应字节和 HTML 里写的哈希对不上，
 * 浏览器就拒绝执行，官网自己会弹一张"页面资源加载异常，请刷新重试"的图
 * （page/chat-preload.js 认出来后会让这边重载一次）。
 * 这种坏副本常常同时躺在缓存里 —— 官网的 JS 是 max-age 30 天，页内 location.reload()
 * 会把它原样捞回来，所以这里优先用 reloadIgnoringCache。
 *
 * 三个方法按"能绕缓存的程度"往下退：uTools 的窗口代理给不给这些方法没有文档保证
 * （loadURL 就是这么没的），拿不到就返回 false，让页内那 1.2 秒的兜底重载接手。
 * @returns {boolean} 是否已经发起重载
 */
function reloadChatIgnoringCache() {
  const win = getChatWindow()
  if (!win) return false
  const wc = win.webContents
  try {
    if (wc && typeof wc.reloadIgnoringCache === 'function') {
      wc.reloadIgnoringCache()
      return true
    }
  } catch (e) {
    warnOnce('reloadIgnoringCache', '[chat] webContents.reloadIgnoringCache 不可用，退回普通 reload:', e)
  }
  try {
    if (wc && typeof wc.reload === 'function') {
      wc.reload()
      return true
    }
  } catch (e) {
    warnOnce('reload', '[chat] webContents.reload 不可用:', e)
  }
  return false
}

/**
 * 兜底方案：**在 Node 侧**把官网的脚本取回来、验完哈希、直接灌进对话窗。
 *
 * 页面侧那条路（重新插 <script>）实测走不通 —— 那次加载是 HTTP 0、0 字节、1ms，
 * 请求根本没发出去。所以不再指望浏览器去发这个请求：Node 没有 CORS 这一层，
 * 取回来的字节仍旧按官网 HTML 里写的 integrity 逐只验过（见 js/repair.js），
 * 验过了才用 executeJavaScript 灌进页面，全程不经过 <script> 标签。
 *
 * 成败都要回告页面（`window.__dsHelper.showRepairResult`）：失败原因得让用户看见，
 * 不能默默什么都不发生 —— 那种"点了没反应"比报错更难查。
 *
 * @param {{scripts?: Array<{src: string, integrity: string}>, styles?: Array<{href: string}>}} info
 *        页面侧报上来的脚本与样式清单
 * @returns {Promise<object>} repair.run 的结果
 */
function repairChat(info) {
  const scripts = (info && info.scripts) || []
  const styles = (info && info.styles) || []
  const win = getChatWindow()
  if (!win) return Promise.resolve({ ok: false, reason: 'nowindow', message: '对话窗已经关了' })

  let wc = null
  try {
    wc = win.webContents
  } catch (e) {
    warnOnce('repairWebContents', '[chat] 取不到 webContents，没法走 Node 侧修复:', e)
  }
  if (!wc || typeof wc.executeJavaScript !== 'function') {
    warnOnce('repairExecute', '[chat] webContents.executeJavaScript 不可用，Node 侧修复走不了')
    return Promise.resolve({ ok: false, reason: 'noexec', message: '这个窗口上没法执行脚本' })
  }

  // userGesture 传 true：该动作的源头是用户点了报告框里的按钮，
  // 灌进去的官网代码里有依赖"用户手势"的 API 时不会莫名其妙失效。
  const executeJavaScript = (code) => wc.executeJavaScript(code, true)
  // insertCSS 不一定有（uTools 的窗口代理给不给这些方法一向没保证），
  // 没有就让 repair.js 退到页内插一只 <style>。这里只在真拿得到时才往下传。
  const insertCSS = (() => {
    try {
      if (typeof wc.insertCSS === 'function') return (css) => wc.insertCSS(css)
    } catch (e) {
      warnOnce('repairInsertCSS', '[chat] webContents.insertCSS 不可用，改用页内 <style>:', e)
    }
    return null
  })()

  return repair.run({
    scripts,
    styles,
    fetchScript: repair.fetchScript,
    executeJavaScript,
    insertCSS,
  }).catch((e) => ({
    ok: false,
    reason: 'threw',
    message: '取回/注入过程中出错：' + ((e && e.message) || e),
  })).then((result) => {
    console.log('[chat] Node 侧修复结果:', result && result.reason, result && result.message)
    // 回告页面。JSON.stringify 两遍是为了把结果安全地嵌进 JS 字符串字面量里 ——
    // 里面可能有引号、换行（错误信息），少一遍就拼出一段语法错误的代码。
    try {
      executeJavaScript('window.__dsHelper && window.__dsHelper.showRepairResult(' +
        JSON.stringify(JSON.stringify(result)) + ')').catch(() => {})
    } catch (e) {
      console.error('[chat] 回告修复结果失败（页面可能已经不在了）:', e)
    }
    return result
  })
}

/**
 * 打开对话窗的开发者工具。
 *
 * 这是排查"页面里到底哪个请求没成"最直接的工具 —— 比我们自己在页面里包一堆东西都强。
 * Network 面板会给出每条请求的完整因果：谁发起的、有没有发出去、卡在哪一步。
 * 不过它是给用户临时用的：uTools 的窗口代理给不给这个方法没有文档保证
 * （loadURL 就是这么没的），拿不到就报个"这条路走不通"，让调用方去用别的办法。
 *
 * 顺带记两条 GUI 里的等价入口，代码走不通时可以先试它们：
 * uTools 给插件窗口挂了右键菜单，里面有一项就是「开发者工具」（i18n key
 * `menu.plugin.devTools`），accelerator 是 Ctrl+Shift+I；在 uTools 的 app.asar 里
 * 能搜到 `Control+Shift+I` 和 `Command+Alt+I` 一并列着，跟 uTools 自己的窗口通用。
 *
 * @returns {string} 给用户看的一句话结果
 */
function openChatDevTools() {
  const win = getChatWindow()
  if (!win) return '对话窗没开着 —— 先把对话窗打开，再按这个键。'
  let wc = null
  try {
    wc = win.webContents
  } catch (e) {
    return '取不到这个窗口的 webContents。'
  }
  if (!wc || typeof wc.openDevTools !== 'function') {
    return '这个版本的 uTools 没给 openDevTools —— 在对话窗里按 Ctrl+Shift+I，或者右键找「开发者工具」。'
  }
  try {
    // detach：对话窗本来是手机比例（默认 460 宽），DevTools 停靠进去会把页面挤到没法看，
    // 而排查这件事恰恰要看清页面本身。拆成独立窗口对两边都好。
    wc.openDevTools({ mode: 'detach', activate: true })
    return '开发者工具已经开成独立窗口了。看 Network 那一栏：红色的就是没成的请求，'
      + '点开看 Status 和 Timing —— 尤其分清 Status 是 (failed) / net::ERR_…（请求根本没发出去）'
      + '还是真的 4xx / 5xx（发出去了、服务端不受理）。'
  } catch (e) {
    warnOnce('openDevTools', '[chat] webContents.openDevTools 失败:', e)
    return '调 openDevTools 出错了：' + ((e && e.message) || e)
      + ' —— 试试在对话窗里按 Ctrl+Shift+I。'
  }
}

/**
 * 把对话窗里的"失败请求记录"取回来（面板上的按钮用）。
 *
 * 走 executeJavaScript 直接问页面要那段文本，**不经过页面上的 DOM** ——
 * 报告框会随导航一起消失（实测：进了登录页、点登录，回头"左上角横条"就没了），
 * 而 `window.__dsHelper.netReport` 每个新文档都会重新挂上。
 * 页面侧没挂上（改版、preload 没跑）就返回一句能看懂的话，不抛。
 *
 * @returns {Promise<string>}
 */
function collectChatDiagnostics() {
  const win = getChatWindow()
  if (!win) return Promise.resolve('对话窗没开着 —— 打开它、复现一次，再来取记录。')
  let wc = null
  try {
    wc = win.webContents
  } catch (e) {
    return Promise.resolve('取不到这个窗口的 webContents。')
  }
  if (!wc || typeof wc.executeJavaScript !== 'function') {
    return Promise.resolve('这个版本的 uTools 没给 executeJavaScript，取不了记录。')
  }
  return Promise.resolve(
    wc.executeJavaScript(
      '(window.__dsHelper && window.__dsHelper.netReport)'
      + ' ? window.__dsHelper.netReport()'
      + ' : "这个页面上没有记录入口（preload 没跑起来，或者官网改版了）"', true)
  ).catch((e) => '取记录时出错：' + ((e && e.message) || e))
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

/** 下次该打开哪个地址：记住的会话，没有就是官网首页 */
function chatTargetUrl() {
  return config.getLastChatUrl() || SITE
}

module.exports = {
  SITE,
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
  // 导出这两条是为了让自检能各跑一遍 —— 它们是两条独立的路，
  // 拆开导出后 CDP 那条也测得到（watchChatNetwork 自己带"只挂一次"的闸）。
  // watchChatConsole 每建一个窗口挂一次（它是按 webContents 算的，不是按 session），
  // 同样导出给自检。
  watchViaSession,
  watchViaDebugger,
  watchChatConsole,
  reloadChatIgnoringCache,
  repairChat,
  openChatDevTools,
  collectChatDiagnostics,
  summonChat,
  isChatFocused,
  resolveChatSize,
  saveChatSize,
  resetChatSize,
  rememberChatUrl,
  chatTargetUrl,
}

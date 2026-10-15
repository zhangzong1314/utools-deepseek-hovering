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
//
// 对话窗用的**不是**我们自己 createBrowserWindow 出来的窗口，而是 uTools 自带的浏览器
// （utools.ubrowser，uTools 文档里的"内置浏览器"）。这是实测逼出来的：
//   - 我们自己的窗口里装不了官网：<webview> 根本用不了 —— uTools 构造窗口时只把
//     webPreferences.preload 透给 Electron，webviewTag 没这一项（uTools 自己的类型定义里
//     webPreferences 也只声明了 preload），页面上拿到的只是个空元素；
//     让窗口自己顶层导航到官网，又会撞上官网那两只脚本加载不起来（只弹"页面资源加载异常"）。
//   - uBrowser 是 uTools 自己管着的浏览器窗口：官网在里面正常渲染，而且它的会话是**持久化**的
//     （%APPDATA%\uTools\Partitions\<插件id>.ubrowser 真落盘），登录态和页面存储重启都在。
// 代价是这一层只能用 uTools 给的那套链式 API（goto / wait / focus / paste / evaluate / show / hide），
// 没有窗口实例可拿：窗口在不在，只能问 utools.getIdleUBrowsers()。

const SITE = 'https://chat.deepseek.com/'

// 认"哪个 uBrowser 窗口是我们的"：地址落在官网域名上就算（登录页也算）。
const CHAT_URL_RE = /^https:\/\/chat\.deepseek\.com\//

// 官网的 DOM 钩子。这几条是从参考实现（JinkoWu 的 DeepSeek）那儿搬来的实测值，
// 官网改版会让它们失效 —— 那时表现是"文字没粘进去"或"点了不发送"，先看这里。
const SEL_INPUT = 'textarea'
const SEL_SEND = 'input[type=file][multiple] + div[role=button]'

// 选中文字那几条指令，注入前给文字加的引子（参考实现的措辞）。
const PREFIX = {
  translate: '请翻译下面内容: ',
  genvarname: '变量取名: ',
  summarize: '总结下面内容: ',
  summarizeUrl: '总结这个网页的内容: ',
}

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
 * 算出对话窗该开多大：存过的尺寸（没有就用手机尺寸），再夹进当前主屏的可用区域。
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

// uBrowser 的窗口 id。它只是个缓存：真判断"窗口还在不在"一律以 getIdleUBrowsers 为准。
let chatWinId = null

/**
 * 当前插件空闲的 uBrowser 窗口里，哪些是 DeepSeek 对话窗。
 *
 * getIdleUBrowsers() 给的是"本插件下、操作队列已经跑完"的窗口 —— 我们自己的链式操作
 * 执行期间那个窗口不在列表里，所以这个函数只在链条外面调。
 * 认领条件两条：id 和我们记的那个对得上（用户把页面点到站外了也还认），
 * 或者地址在官网域名上（插件重启、id 丢了的时候靠它认回来）。
 */
function chatWindows() {
  let list = []
  try {
    list = utools.getIdleUBrowsers() || []
  } catch (e) {
    warnOnce('idleBrowsers', '[chat] utools.getIdleUBrowsers 不可用，认不出已经开着的对话窗:', e)
    return []
  }
  const mine = list.filter((w) => w && (w.id === chatWinId ||
    (typeof w.url === 'string' && CHAT_URL_RE.test(w.url))))
  chatWinId = mine.length ? mine[mine.length - 1].id : null
  return mine
}

/**
 * 对话窗现在摆在桌面上没有。
 *
 * uBrowser 的窗口实例只有 id / 地址 / 标题 / 宽高 / 坐标，**没有"可见性"这一栏**，
 * 所以"显着还是藏着"只能插件自己记（config.isChatShown）；窗口本身还在不在则以窗口列表为准：
 * 用户用窗口自己的 × 关掉之后列表里就没有它了，这里会退化成"没开"，下次点球重新开一个。
 */
function isChatVisible() {
  if (!chatWindows().length) return false
  return config.isChatShown()
}

/** uBrowser 的 run() 返回 [...各步结果, 窗口实例]，要的永远是最后那一个 */
function lastOf(result) {
  return Array.isArray(result) ? result[result.length - 1] : null
}

/**
 * 把窗口实例上的信息收下来：当前地址（记住上次的会话）和当前尺寸（用户拖过窗口就靠这个记住）。
 * 每次跟这个窗口打完交道都过一遍。
 */
function absorb(instance) {
  if (!instance) return
  if (typeof instance.url === 'string' && instance.url) rememberChatUrl(instance.url)
  if (typeof instance.width === 'number' && typeof instance.height === 'number' &&
    instance.width > 0 && instance.height > 0) {
    saveChatSize(instance.width, instance.height)
  }
}

/** 开窗（没有的话）或把已经开着的窗口摆到桌面上 */
function showChat() {
  const list = chatWindows()
  if (list.length) {
    const id = list[list.length - 1].id
    return utools.ubrowser.show().run(id).then((result) => {
      absorb(lastOf(result))
      config.setChatShown(true)
      return true
    }).catch((e) => {
      console.error('[chat] 显示对话窗失败:', e)
      return false
    })
  }

  const size = resolveChatSize()
  return utools.ubrowser
    .goto(config.getLastChatUrl() || SITE)
    .show()
    .run({
      title: 'DeepSeek',
      width: size.width,
      height: size.height,
      minWidth: MIN_CHAT_SIZE.width,
      minHeight: MIN_CHAT_SIZE.height,
      center: true,
    })
    .then((result) => {
      const instance = lastOf(result)
      if (instance && typeof instance.id === 'number') chatWinId = instance.id
      absorb(instance)
      config.setChatShown(true)
      return true
    })
    .catch((e) => {
      console.error('[chat] 打开对话窗失败:', e)
      return false
    })
}

/**
 * 把对话窗藏起来 —— uBrowser 没有程序化的"关窗"，藏起来就是我们的"关闭"。
 * 藏起来之后那一页还在（登录态、正在打的字都在），再点球是一瞬间的事。
 */
function hideChat() {
  const list = chatWindows()
  config.setChatShown(false)
  if (!list.length) return Promise.resolve(false)
  const id = list[list.length - 1].id
  return utools.ubrowser.hide().run(id).then((result) => {
    absorb(lastOf(result))
    return true
  }).catch((e) => {
    console.error('[chat] 隐藏对话窗失败:', e)
    return false
  })
}

/**
 * 点悬浮球（或面板上那颗按钮）：开着就藏起来，没开就开。
 * @returns {Promise<boolean>} true 表示这次是"打开"
 */
function toggleChat() {
  return isChatVisible()
    ? hideChat().then(() => false)
    : showChat().then(() => true)
}

/**
 * 官网正在生成回答时先替用户停掉它 —— 不然新消息只会被官网排队，看着像"发了没反应"。
 *
 * 判据是"输入框空着 + 发送按钮却可点"：生成期间那个按钮是"停止"，一直可点；空闲时它只有
 * 输入框里有字才可点。只认"按钮可点"会误判 —— 用户打着草稿时会被我们替他发出去。
 * （这份更严的条件取自参考实现早先那版 ubrowser 代码。）
 * 注意：这个函数会被序列化后送进页面执行，不能引用外部任何东西，参数只能靠入参传进来。
 */
function stopGenerating(sel) {
  try {
    const input = document.querySelector(sel.input)
    const btn = document.querySelector(sel.send)
    if (btn && !(input && input.value && input.value.length) &&
      btn.getAttribute('aria-disabled') === 'false') {
      btn.click()
    }
  } catch (e) {
    // 官网改版 / 元素还没出来，就当没这回事
  }
}

/**
 * 选中文字进来的那条路：开窗（或前置）之后把文字贴进输入框，该发送就发送。
 *
 * wait(SEL_INPUT, …) 一次兼了两件事：等官网界面渲染出来、以及用户还没登录时等他把登录走完。
 * 等不到会 reject（超时），这里吞掉并记一条 —— 用户看到的是"没反应"，不该看到我们的异常。
 *
 * @param {{code?: string, payload?: string}} action uTools 的进入动作
 * @returns {Promise<boolean>} 有没有把文字送进去
 */
function askChat(action) {
  const code = (action && action.code) || ''
  let text = (action && action.payload) || ''
  if (text) {
    if (PREFIX[code]) text = PREFIX[code] + text
    else if (code !== 'ask') text = ''
  }

  return showChat().then((shown) => {
    if (!shown) return false
    const list = chatWindows()
    if (!list.length) return false
    const id = list[list.length - 1].id

    let chain = utools.ubrowser.wait(SEL_INPUT, 60 * 1000)
    if (text) {
      chain = chain
        .evaluate(stopGenerating, { input: SEL_INPUT, send: SEL_SEND })
        .wait(200)
        .focus(SEL_INPUT)
        .paste(text)
        .wait(500)
        .click(SEL_SEND)
    } else {
      chain = chain.focus(SEL_INPUT)
    }

    return chain.show().run(id).then((result) => {
      absorb(lastOf(result))
      config.setChatShown(true)
      return true
    }).catch((e) => {
      console.error('[chat] 把文字送进对话窗失败:', e)
      return false
    })
  })
}

/**
 * 快捷键按一下：把对话窗叫到跟前。
 *
 * 和上一版有个差别得说清楚：**快捷键不再关窗**。以前是"三态"（没开就开 / 被别的窗口盖住就
 * 调到最前 / 已经在最前面才收起），第三态靠 window.isFocused() 判断；uBrowser 的窗口实例
 * 只给 id / 地址 / 标题 / 几何，没有焦点也没有可见性，那个判断做不了了。
 * 所以现在的规矩是"快捷键只管把窗口叫出来，关窗交给点球、球的右键菜单、或者窗口自己的 ×"——
 * 盲操时第一下就把用户正想看的窗口关掉，比"多按一下没关掉"难受得多。
 *
 * @returns {Promise<'open'|'front'>} 这次是开了个新的，还是把已有的叫到跟前
 */
function summonChat() {
  const wasVisible = isChatVisible()
  return showChat().then(() => (wasVisible ? 'front' : 'open'))
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
  SITE,
  BALL_SIZE,
  DEFAULT_CHAT_SIZE,
  MIN_CHAT_SIZE,
  MAX_CHAT_SIZE,
  getBallWindow,
  ensureBall,
  showBall,
  hideBall,
  resetBallPos,
  beginDrag,
  dragTo,
  endDrag,
  expandBallForMenu,
  collapseBallMenu,
  // 对话窗这一组全是异步的（uBrowser 的链式操作返回 Promise）：
  // showChat/hideChat/toggleChat 返回 Promise<boolean>（true = 现在开着），
  // askChat 返回 Promise<boolean>（有没有把文字送进去），summonChat 返回 Promise<'open'|'front'>。
  showChat,
  hideChat,
  toggleChat,
  isChatVisible,
  askChat,
  summonChat,
  resolveChatSize,
  saveChatSize,
  resetChatSize,
  // 会话地址的取舍规则（记住会话、回首页忘掉、别的不碰）留在父窗这一侧：
  // 每次跟对话窗打交道时，从 uBrowser 给的窗口实例上把地址收下来喂给它。
  rememberChatUrl,
}

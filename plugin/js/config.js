// DeepSeek 悬浮助手 —— 配置读写
//
// 全部走 utools.dbStorage（uTools 自带的持久化 KV，随插件走，不写自己的文件）。
// 这里是唯一碰存储的地方，所以每处都套了 try/catch：dbStorage 在极端情况下
// （磁盘满、数据被手动清掉）会抛，而配置读失败不该让整个插件挂掉，一律退回默认值。

const KEYS = {
  ballPos: 'deepseek:ballPos',
  ballVisible: 'deepseek:ballVisible',
  chatSize: 'deepseek:chatSize',
  lastChatUrl: 'deepseek:lastChatUrl',
  // 对话窗此刻是不是"摆着"（而不是被我们藏起来了）。
  // uBrowser 给的窗口信息里没有"可见性"这一栏（只有 id / 地址 / 标题 / 几何），
  // 所以"显还是藏"只能插件自己记 —— 见 js/windows.js 的 isChatVisible。
  chatShown: 'deepseek:chatShown',
  // 全局快捷键。没存过就用 js/hotkey.js 里的默认值（Ctrl+Space）——
  // 这个键是插件自己注册的（Windows 的 RegisterHotKey），不走 uTools 的快捷键页。
  hotkey: 'deepseek:hotkey',
}

function read(key, fallback) {
  try {
    const raw = utools.dbStorage.getItem(key)
    return raw === null || raw === undefined ? fallback : raw
  } catch (e) {
    console.error('[config] 读取失败:', key, e)
    return fallback
  }
}

function write(key, value) {
  try {
    utools.dbStorage.setItem(key, value)
  } catch (e) {
    console.error('[config] 写入失败:', key, e)
  }
}

function remove(key) {
  try {
    utools.dbStorage.removeItem(key)
  } catch (e) {
    console.error('[config] 删除失败:', key, e)
  }
}

// ---- 悬浮球位置 ----
// 存成 JSON 字符串而不是裸对象：dbStorage 对对象的行为没在文档里写死，
// 字符串是各种情况下都稳的最小表示。

function getBallPos() {
  const raw = read(KEYS.ballPos, null)
  if (typeof raw !== 'string') return null
  try {
    const pos = JSON.parse(raw)
    if (typeof pos.x === 'number' && typeof pos.y === 'number') return { x: pos.x, y: pos.y }
  } catch (e) {
    console.error('[config] 位置数据损坏，已忽略:', raw)
  }
  return null
}

function setBallPos(x, y) {
  write(KEYS.ballPos, JSON.stringify({ x: Math.round(x), y: Math.round(y) }))
}

function clearBallPos() {
  remove(KEYS.ballPos)
}

// ---- 悬浮球是否显示 ----
// 默认 true：第一次进入插件就该看到桌面上出现悬浮球。

function isBallVisible() {
  const raw = read(KEYS.ballVisible, true)
  return raw !== false
}

function setBallVisible(visible) {
  write(KEYS.ballVisible, !!visible)
}

// ---- 对话窗尺寸 ----
// 存成 {width, height} 的 JSON 字符串（同样是"字符串最稳"的理由）。
// 这里只负责存取，范围校验和屏幕可用区域夹取在 js/windows.js 做 —— 那属于窗口的事。

function getChatSize() {
  const raw = read(KEYS.chatSize, null)
  if (typeof raw !== 'string') return null
  try {
    const size = JSON.parse(raw)
    if (typeof size.width === 'number' && typeof size.height === 'number' &&
      size.width > 0 && size.height > 0) {
      return { width: Math.round(size.width), height: Math.round(size.height) }
    }
  } catch (e) {
    console.error('[config] 窗口尺寸数据损坏，已忽略:', raw)
  }
  return null
}

function setChatSize(width, height) {
  write(KEYS.chatSize, JSON.stringify({ width: Math.round(width), height: Math.round(height) }))
}

function clearChatSize() {
  remove(KEYS.chatSize)
}

// ---- 上次打开的会话地址 ----
// 由 js/windows.js 判定「什么样的地址值得记」，这里只管存。
// 传 null / '' 表示忘掉（回到首页了）。

function getLastChatUrl() {
  const raw = read(KEYS.lastChatUrl, null)
  return typeof raw === 'string' && raw ? raw : null
}

function setLastChatUrl(url) {
  if (!url) remove(KEYS.lastChatUrl)
  else write(KEYS.lastChatUrl, String(url))
}

// ---- 对话窗是不是摆着 ----
// 默认 false：没开过就是藏着的（那时窗口列表里也不会有它）。

function isChatShown() {
  const raw = read(KEYS.chatShown, false)
  return raw === true
}

function setChatShown(shown) {
  write(KEYS.chatShown, !!shown)
}

// ---- 全局快捷键 ----
// 存的是 "Ctrl+Space" 这样的字符串（写法见 helper/hotkey.cs 的解析）。没存过返回 null，
// 由调用方自己决定用什么默认值 —— 默认值属于"功能"这一层，不属于配置。

function getHotkey() {
  const raw = read(KEYS.hotkey, null)
  return typeof raw === 'string' && raw ? raw : null
}

function setHotkey(spec) {
  if (!spec) remove(KEYS.hotkey)
  else write(KEYS.hotkey, String(spec))
}

function clearHotkey() {
  remove(KEYS.hotkey)
}

module.exports = {
  KEYS,
  getBallPos,
  setBallPos,
  clearBallPos,
  isBallVisible,
  setBallVisible,
  getChatSize,
  setChatSize,
  clearChatSize,
  getLastChatUrl,
  setLastChatUrl,
  isChatShown,
  setChatShown,
  getHotkey,
  setHotkey,
  clearHotkey,
}

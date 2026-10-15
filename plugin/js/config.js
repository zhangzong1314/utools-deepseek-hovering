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
  // 官网登录令牌的镜像。对话窗用的是非持久化会话（重启就丢），
  // 靠这份副本免掉重新登录 —— 见 page/chat-preload.js 与 page/chat-host.js 的 syncToken。
  userToken: 'deepseek:userToken',
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

// ---- 登录令牌的镜像 ----
// 是个字符串（官网自己存在 localStorage 里的那份），只有"有没有"两种状态，不做解析。
// 用户点了登出、令牌过期时都会把它清掉（判断在 page/chat-host.js 的 syncToken 里）。

function getUserToken() {
  const raw = read(KEYS.userToken, null)
  return typeof raw === 'string' && raw ? raw : null
}

function setUserToken(token) {
  if (!token) remove(KEYS.userToken)
  else write(KEYS.userToken, String(token))
}

function clearUserToken() {
  remove(KEYS.userToken)
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
  getUserToken,
  setUserToken,
  clearUserToken,
}

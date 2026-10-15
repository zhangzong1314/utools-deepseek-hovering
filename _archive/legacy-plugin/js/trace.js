// DeepSeek 悬浮助手 —— 把"这个窗口里到底发生了什么"落到一个文件里
//
// 为什么要有这个模块：前面两版取证工具都栽在同一个地方 —— 取证手段本身要求用户在 GUI 里
// 配合，而那些手段一个比一个脆：
//   - 页面上那份报告挂在官网的 DOM 上，登录那一步要是触发一次导航，整个文档被换掉，框就没了；
//   - 面板上的按钮要先重新打包才存在，而且用户在面板上找不找得到还两说；
//   - 开发者工具在 uTools 的窗口上不一定打得开（accel 到底是不是 Ctrl+Shift+I，只能试）。
// 而这件事（"登录为什么失败"）我们不需要用户在界面上做任何事 —— 让他照着复现一次就够了。
// 所以：插件自己把关键事件追加写到一个已知路径的文件里，事后直接看文件。
//
// 边界说清楚：这里只记**请求的地址、方法、结果**这类元信息，不碰任何请求体、响应体、
// 令牌、验证码 —— 记的是"哪条路没走通"，不是"路上运了什么"。写文件本身也全程 try/catch，
// 磁盘满、目录只读、权限不够都只是"少记一条"，绝不能连累插件本身。

const fs = require('fs')
const path = require('path')

// 系统临时目录：好找、可写、系统会自己清。找不到就退到当前目录 —— 有日志总比没有强。
function resolveDir() {
  try {
    const temp = utools.getPath('temp')
    if (temp) return temp
  } catch (e) {
    // uTools 老版本没有 getPath，往下面退
  }
  return process.env.TEMP || process.env.TMP || '.'
}

let filePath = null

function logPath() {
  if (!filePath) filePath = path.join(resolveDir(), 'deepseek-hovering-net.log')
  return filePath
}

// 超过这个大小就从头来过（只留最近这一段）。排查场景要的是"刚刚那一次"，
// 不是考古；无上限地长下去反而是个隐患。
const MAX_BYTES = 512 * 1024

function stamp() {
  const d = new Date()
  function two(n) { return (n < 10 ? '0' : '') + n }
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()) + '.' +
    String(d.getMilliseconds()).padStart(3, '0')
}

/**
 * 追加一行。**永远不会抛** —— 这个模块跑在插件的正常路径上，
 * 记日志失败不能变成功能失败。
 * @param {string} line
 */
function append(line) {
  const target = logPath()
  try {
    let size = 0
    try {
      size = fs.statSync(target).size
    } catch (e) {
      size = 0
    }
    if (size > MAX_BYTES) {
      fs.writeFileSync(target, '（超过 ' + MAX_BYTES + ' 字节，从这里重新开始）\n')
    }
    fs.appendFileSync(target, '[' + stamp() + '] ' + line + '\n')
  } catch (e) {
    console.error('[trace] 写日志失败（不影响功能）:', e && e.message)
  }
}

/** 一个会话（一次插件进程）开始的那一行。好让事后读日志的人分得清哪几行是一次运行。 */
function sessionStart(extra) {
  append('=== 插件进程开始（' + (extra || '') + '） ===')
}

/**
 * 读回日志的尾巴（默认最后 32 KB），给面板上那颗「复制排查日志」用。
 *
 * 为什么值得专门开一条路：最要紧的两类行只落在这个文件里 —— 浏览器自己说的
 * `Failed to load resource: net::ERR_…`（它直接点名是谁把请求掐掉的），
 * 以及页面侧报上来的 `元素换走 blob …`。让人自己去 %TEMP% 翻文件太费事，
 * 而这颗按钮和「复制失败请求记录」一样，按一下就能粘出来。
 *
 * 从中间截断会截坏一行，所以跳到第一个换行之后才开始 —— 半行日志比没有更误导人。
 */
function read(maxBytes) {
  const limit = maxBytes || 32 * 1024
  const target = logPath()
  try {
    const buf = fs.readFileSync(target)
    if (buf.length <= limit) return buf.toString('utf8')
    const tail = buf.slice(buf.length - limit).toString('utf8')
    const nl = tail.indexOf('\n')
    return '（日志较长，这里只取最后 ' + limit + ' 字节）\n' + (nl === -1 ? tail : tail.slice(nl + 1))
  } catch (e) {
    return '读日志失败：' + ((e && e.message) || e) + '\n日志文件：' + target
  }
}

module.exports = {
  MAX_BYTES,
  logPath,
  append,
  sessionStart,
  read,
}

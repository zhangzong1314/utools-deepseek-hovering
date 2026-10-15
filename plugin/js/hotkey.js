// DeepSeek 悬浮助手 —— 全局快捷键（插件自己注册，不依赖 uTools）
//
// uTools 没给插件"自己注册系统级热键"的 API，它自带的快捷键设置里 Ctrl+Space 这类组合
// 也设不上（Windows 上它默认归输入法的中英切换）。所以插件自己扛：带一份 C# 源码
// （helper/hotkey.cs），第一次用到时用系统自带的 csc.exe 现编成 exe，让那个小助手去调
// Windows 原生的 RegisterHotKey；按下热键时它往 stdout 打一行 hotkey，这里接住就去开关对话窗。
//
// 为什么不用页面里的按键监听：那种只在插件窗口有焦点时才算数，等于没有全局快捷键。
//
// 改绑 = 把助手杀掉、用新组合重新拉一个。启动时注册这条实测最稳；"从别的线程拿那个窗口句柄
// 再去 RegisterHotKey"会被系统当成重复注册（win32 1408），试过了，不通。

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync, spawn } = require('child_process')

const DEFAULT_HOTKEY = 'Ctrl+Space'

// 编译产物放临时目录：插件装成 .upx 之后自己的目录是只读的（asar），写不进去。
const BUILD_DIR = path.join(os.tmpdir(), 'deepseek-hovering')

let child = null
let fireHandler = null
let listeners = []
// state: idle（没启动）/ starting / ok / fail / unsupported
let status = { spec: null, state: 'idle', message: '' }

function sourceFile() {
  return path.join(__dirname, '..', 'helper', 'hotkey.cs')
}

/** 找 .NET Framework 自带的 C# 编译器（Win10 一定有，不需要用户装任何东西） */
function findCompiler() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const exe of candidates) {
    try {
      if (fs.existsSync(exe)) return exe
    } catch (e) {
      // 拿不到就试下一个
    }
  }
  return null
}

/**
 * 把 helper/hotkey.cs 编成 exe（已经编过、且比源码新就直接用）。
 * @returns {{ok: boolean, exe?: string, message?: string}}
 */
function ensureHelper() {
  const src = sourceFile()
  const exe = path.join(BUILD_DIR, 'hotkey.exe')

  try {
    const srcStat = fs.statSync(src)
    if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= srcStat.mtimeMs) {
      return { ok: true, exe: exe }
    }
  } catch (e) {
    return { ok: false, message: '找不到 helper/hotkey.cs（插件文件不完整？）' }
  }

  const csc = findCompiler()
  if (!csc) return { ok: false, message: '系统里没找到 csc.exe（.NET Framework 的 C# 编译器）' }

  try {
    if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true })
  } catch (e) {
    return { ok: false, message: '建不了临时目录：' + ((e && e.message) || e) }
  }

  // 编译要一秒左右，只在第一次（或改了源码之后）发生
  const result = spawnSync(csc, [
    '-nologo', '-target:exe', '-out:' + exe, src, '-r:System.Windows.Forms.dll',
  ], { windowsHide: true, encoding: 'utf8', timeout: 20000 })

  if (result.error) return { ok: false, message: '调用编译器失败：' + result.error.message }
  if (result.status !== 0) {
    const out = String(result.stdout || '') + String(result.stderr || '')
    return { ok: false, message: '编译热键助手失败：' + out.trim().slice(0, 300) }
  }
  if (!fs.existsSync(exe)) return { ok: false, message: '编译完了却没找到产物' }
  return { ok: true, exe: exe }
}

function setStatus(next) {
  status = next
  listeners.forEach((fn) => {
    try {
      fn(status)
    } catch (e) {
      console.error('[hotkey] 状态回调出错:', e)
    }
  })
}

function handleLine(line) {
  if (!line) return
  if (line === 'hotkey') {
    if (fireHandler) {
      try {
        fireHandler()
      } catch (e) {
        console.error('[hotkey] 处理热键按下时出错:', e)
      }
    }
    return
  }
  if (line.indexOf('ok') === 0) {
    setStatus({ spec: status.spec, state: 'ok', message: '' })
    return
  }
  if (line.indexOf('fail') === 0) {
    setStatus({ spec: status.spec, state: 'fail', message: line.slice(4).trim() })
  }
}

/**
 * 启动（或重启）热键助手。
 * @param {string} [spec] 组合，例如 Ctrl+Space；不传就用配置里的、再不然用默认的
 */
function start(spec) {
  stop()
  const wanted = spec || DEFAULT_HOTKEY

  if (process.platform !== 'win32') {
    setStatus({ spec: wanted, state: 'unsupported', message: '只有 Windows 上能用（用的是 Win32 的 RegisterHotKey）' })
    return status
  }

  const built = ensureHelper()
  if (!built.ok) {
    setStatus({ spec: wanted, state: 'unsupported', message: built.message })
    return status
  }

  setStatus({ spec: wanted, state: 'starting', message: '' })

  let proc = null
  try {
    proc = spawn(built.exe, [wanted], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    setStatus({ spec: wanted, state: 'fail', message: '启动热键助手失败：' + ((e && e.message) || e) })
    return status
  }

  child = proc
  proc.stdout.setEncoding('utf8')
  let buffer = ''
  proc.stdout.on('data', (chunk) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      handleLine(buffer.slice(0, idx).trim())
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
    }
  })
  proc.stderr.on('data', (chunk) => {
    console.error('[hotkey] 助手 stderr:', String(chunk).trim())
  })
  proc.on('error', (e) => {
    if (child !== proc) return
    child = null
    setStatus({ spec: wanted, state: 'fail', message: '热键助手出错：' + ((e && e.message) || e) })
  })
  proc.on('exit', (code) => {
    if (child !== proc) return
    child = null
    // 还没报 ok 就退了、或者注册成功过又退了 —— 都得在面板上说一句，
    // 否则用户只会看到"按了没反应"
    if (status.state === 'ok' || status.state === 'starting') {
      setStatus({ spec: wanted, state: 'fail', message: '热键助手退出了（code ' + code + '）' })
    }
  })

  return status
}

function stop() {
  const proc = child
  child = null
  if (!proc) return
  try {
    if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end()
  } catch (e) {
    // 关不上就算了，下面还要 kill
  }
  try {
    proc.kill()
  } catch (e) {
    console.error('[hotkey] 关掉热键助手失败:', e)
  }
}

function isRunning() {
  return !!child
}

function state() {
  return Object.assign({}, status)
}

/** 面板/自检拿它订阅状态变化 */
function onChange(fn) {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((item) => item !== fn)
  }
}

function setFireHandler(fn) {
  fireHandler = fn
}

module.exports = {
  DEFAULT_HOTKEY,
  start,
  stop,
  isRunning,
  state,
  onChange,
  setFireHandler,
}

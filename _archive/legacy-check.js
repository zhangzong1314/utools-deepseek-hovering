// 插件自检 —— 零依赖
//
// 我改不了 uTools 的 GUI，但大部分低级错误（路径写错、plugin.json 少字段、
// 语法挂掉、进入插件时根本没建窗口）都能在命令行里抓出来。这个脚本做三件事：
//   1. 校验 plugin.json 以及它引用的每个文件是否真的在；
//   2. 语法编译插件目录下所有 JS，顺带检查 HTML 里引用的本地资源是否存在；
//   3. 用桩件把 preload.js 真正跑起来，模拟"进入插件 → 建悬浮球 → 点球 →
//      拖球 → 右键菜单 → 隐藏球"整条链路，断言窗口创建参数和开窗结果。
//
// 跑法：npm run check

const fs = require('fs')
const path = require('path')
const vm = require('vm')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const PLUGIN = path.join(ROOT, 'plugin')

let failures = 0
let checks = 0

function ok(msg) {
  checks++
  console.log('  ✓ ' + msg)
}

function fail(msg) {
  checks++
  failures++
  console.error('  ✗ ' + msg)
}

function check(cond, msg, detail) {
  if (cond) ok(msg)
  else fail(msg + (detail ? ' —— ' + detail : ''))
  return !!cond
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

function exists(relPath) {
  return fs.existsSync(path.join(PLUGIN, relPath))
}

/**
 * 去掉注释再查"代码里有没有这个东西"。不然一句"别 require(x)"的注释就会被当成真的在 require。
 * 前面是冒号的 // 不当行注释（躲开字符串里的 https://）。
 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

// ---------------------------------------------------------------- 1. plugin.json

function checkManifest() {
  console.log('plugin.json')
  const file = path.join(PLUGIN, 'plugin.json')
  if (!check(fs.existsSync(file), 'plugin.json 位于插件根目录 ' + rel(PLUGIN) + '/')) return null

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    fail('plugin.json 不是合法 JSON: ' + e.message)
    return null
  }
  ok('plugin.json 是合法 JSON')

  check(!!manifest.pluginName, 'pluginName 已填')
  check(/^\d+\.\d+\.\d+/.test(manifest.version || ''), 'version 形如 x.y.z', String(manifest.version))

  // v8 起必须显式声明 main，否则进入插件后主窗口是空白
  if (check(!!manifest.main, '声明了 main（v8 必填）', '当前: ' + manifest.main)) {
    check(exists(manifest.main), 'main 指向的文件存在: ' + manifest.main)
  }
  if (check(!!manifest.preload, '声明了 preload', '当前: ' + manifest.preload)) {
    check(exists(manifest.preload), 'preload 指向的文件存在: ' + manifest.preload)
  }
  if (manifest.logo) check(exists(manifest.logo), 'logo 指向的文件存在: ' + manifest.logo)

  const features = Array.isArray(manifest.features) ? manifest.features : []
  check(features.length > 0, '至少声明了一个 feature')

  const codes = new Set()
  features.forEach((f, i) => {
    const tag = 'features[' + i + ']'
    check(!!f.code, tag + '.code 非空')
    if (f.code) check(!codes.has(f.code), tag + '.code 唯一: ' + f.code)
    codes.add(f.code)
    if (f.icon) check(exists(f.icon), tag + '.icon 存在: ' + f.icon)

    const cmds = Array.isArray(f.cmds) ? f.cmds : []
    // uTools 每个功能最多 5 个 cmds，'{}' 这类占位符不算
    const words = cmds.filter((c) => typeof c === 'string' && c.trim() && c.trim() !== '{}')
    check(words.length > 0 && words.length <= 5, tag + ' 的文本 cmds 在 1~5 个之间', '当前 ' + words.length + ' 个')
  })

  return manifest
}

// ---------------------------------------------------------------- 2. 语法与引用

function walk(dir, out) {
  out = out || []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function checkSources() {
  console.log('静态文件')
  const files = walk(PLUGIN)

  const jsFiles = files.filter((f) => f.endsWith('.js'))
  check(jsFiles.length > 0, '找到 ' + jsFiles.length + ' 个 JS 文件')
  for (const file of jsFiles) {
    const code = fs.readFileSync(file, 'utf8')
    try {
      new vm.Script(code, { filename: file })
      ok('语法通过: ' + rel(file))
    } catch (e) {
      fail('语法错误 ' + rel(file) + ': ' + e.message)
    }
  }

  // HTML 里引用的本地资源必须存在。写错一个 src 在浏览器里就是静默失效，
  // 面板会白屏且没有任何报错，所以值得单独查。
  const htmlFiles = files.filter((f) => f.endsWith('.html'))
  check(htmlFiles.length > 0, '找到 ' + htmlFiles.length + ' 个 HTML 文件')
  const attrRe = /(?:src|href)\s*=\s*["']([^"']+)["']/g
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8')
    const dir = path.dirname(file)
    const refs = []
    let m
    while ((m = attrRe.exec(html))) {
      const url = m[1]
      if (/^(https?:)?\/\//.test(url) || /^(data:|#|mailto:)/.test(url)) continue
      refs.push(url)
    }
    if (!refs.length) {
      ok('无本地引用: ' + rel(file))
    } else {
      refs.forEach((url) => {
        const target = path.resolve(dir, url)
        check(fs.existsSync(target) && target.startsWith(PLUGIN), rel(file) + ' → ' + url + ' 存在')
      })
    }

    // 内联 <script> 也是要跑的代码，悬浮球那页最绕的逻辑就在里面，
    // 顺手编译一遍，别等进了 GUI 才发现少个括号。
    const inlineRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g
    let n = 0
    let s
    while ((s = inlineRe.exec(html))) {
      n++
      const body = s[1]
      if (!body.trim()) continue
      try {
        new vm.Script(body, { filename: rel(file) + ' 内联脚本#' + n })
        ok('内联脚本语法通过: ' + rel(file) + ' #' + n)
      } catch (e) {
        fail('内联脚本语法错误 ' + rel(file) + ' #' + n + ': ' + e.message)
      }
    }
  }

  check(!files.some((f) => path.basename(f) === '.DS_Store'), '没有混进 .DS_Store 之类的垃圾文件')

  // 对话窗能不能连上官网，全靠 chat.html 自己那句跳转 —— 父窗没有 loadURL 可用
  // （uTools 8.0.0 实测），所以这条链路必须由页面承担。写错了在 GUI 里就是白屏，
  // 这里先把它钉死。
  const chatHtml = fs.readFileSync(path.join(PLUGIN, 'page', 'chat.html'), 'utf8')
  check(/location\.replace\(\s*target\s*\)/.test(chatHtml), 'page/chat.html 用 location.replace 跳到目标地址')
  check(chatHtml.indexOf('chatHost') !== -1, 'page/chat.html 的目标地址取自 chat-preload 挂的 chatHost')
  check(chatHtml.indexOf('https://chat.deepseek.com/') !== -1, 'page/chat.html 里写明官网地址作为兜底')

  // chat-preload.js 会跟着窗口跑到官网那种普通网页上执行，两条底线不能破：
  // 不能 require（那里未必还有 Node 环境），不能假设 utools 一定在。
  const chatPreloadSrc = fs.readFileSync(path.join(PLUGIN, 'page', 'chat-preload.js'), 'utf8')
  check(!/\brequire\s*\(/.test(stripComments(chatPreloadSrc)),
    'page/chat-preload.js 不 require 任何模块（它要在官网页面上执行）')
  check(/typeof\s+utools\s*!==\s*'undefined'/.test(chatPreloadSrc),
    'page/chat-preload.js 用 typeof 判断 utools 全局是否存在')
  check(chatPreloadSrc.indexOf('sendToParent') !== -1,
    'page/chat-preload.js 用 sendToParent 把当前地址上报给父窗')

  // 官网脚本没通过 integrity（SRI）校验时的识别与"只救一次"：这几处任一被删掉，
  // 表现都是"用户看到官网那张'资源加载异常'的图，插件这边毫无察觉"。
  check(chatPreloadSrc.indexOf('_sri-ck') !== -1,
    'page/chat-preload.js 认得出官网那句"页面资源加载异常"提示（._sri-ck）')
  check(chatPreloadSrc.indexOf("send('chat:sri'") !== -1 ||
    chatPreloadSrc.indexOf("'chat:sri'") !== -1,
    'page/chat-preload.js 发现资源校验失败时通知父窗')
  check(/sessionStorage/.test(chatPreloadSrc),
    'page/chat-preload.js 用 sessionStorage 记住"已经救过一次"（避免自动刷新成死循环）')
  const windowsSrc = fs.readFileSync(path.join(PLUGIN, 'js', 'windows.js'), 'utf8')
  check(/function\s+reloadChatIgnoringCache/.test(windowsSrc) &&
    windowsSrc.indexOf('reloadIgnoringCache') !== -1,
    'js/windows.js 提供绕过缓存的对话窗重载')
  const mainPreloadSrc = fs.readFileSync(path.join(PLUGIN, 'preload.js'), 'utf8')
  check(mainPreloadSrc.indexOf("ipcRenderer.on('chat:sri'") !== -1 &&
    mainPreloadSrc.indexOf('reloadChatIgnoringCache') !== -1,
    'preload.js 收到 chat:sri 后调那个重载')
  check(mainPreloadSrc.indexOf("ipcRenderer.on('chat:nodeRepair'") !== -1 &&
    mainPreloadSrc.indexOf('repairChat') !== -1,
    'preload.js 收到 chat:nodeRepair 后走 Node 侧取回并注入')
  check(/function\s+repairChat\s*\(/.test(windowsSrc) && windowsSrc.indexOf('executeJavaScript') !== -1,
    'js/windows.js 用 executeJavaScript 把验过的脚本灌进对话窗')
  check(windowsSrc.indexOf('insertCSS') !== -1,
    'js/windows.js 用 insertCSS 灌样式（没有就退到页内 <style>）')
  // 结果要嵌进一段 JS 字符串里再送进页面（父窗没有别的说话方式）。少一层 stringify
  // 就是拼出一段语法错误的代码 —— 而"页面里什么都没发生"比报错更难查，所以钉住。
  check(windowsSrc.indexOf('JSON.stringify(JSON.stringify(result))') !== -1,
    'js/windows.js 把结果安全地嵌进 executeJavaScript 的字符串里（两遍 stringify）')

  // 救不回来时要在页面上摆一份"现场侦察"报告。装好的插件里用户既没有插件控制台、
  // 也没耐心翻 DevTools，这段是唯一能把"字节不对"和"请求被拒"分开的东西 ——
  // 少了它，用户能反馈的就只有"还是那张图"。所以在这几处钉钉子。
  check(/function\s+diagnose\s*\(/.test(chatPreloadSrc),
    'page/chat-preload.js 有一个 diagnose() 现场侦察')
  // 自己算 sha384 跟 HTML 里写的 integrity 比 —— 这是判断"网络换了字节"的唯一办法
  check(chatPreloadSrc.indexOf("crypto.subtle.digest('SHA-384'") !== -1,
    'page/chat-preload.js 自己算 SHA-384 去比对 integrity')
  check(chatPreloadSrc.indexOf("cache: 'no-store'") !== -1,
    'page/chat-preload.js 重取脚本时绕开缓存（否则验的还是那份坏副本）')
  // 这两个响应头是判断"网络换了字节"之外那半边的关键：content-type 不是 javascript
  // 说明拿回来的是网关插的错误页；Allow-Origin 不合法则能解释"字节对但浏览器仍拒脚本"。
  check(chatPreloadSrc.indexOf("headers.get('content-type')") !== -1,
    'page/chat-preload.js 记下重取响应的 Content-Type')
  check(chatPreloadSrc.indexOf("headers.get('access-control-allow-origin')") !== -1,
    'page/chat-preload.js 记下重取响应的 Access-Control-Allow-Origin')
  // 同样的地址取两遍（绕过缓存 / 走缓存），两遍的哈希一比就能分开
  // "缓存里躺着一份坏的"和"链路上一直在换字节" —— 这两种的处置方式完全不同。
  check(/function\s+probe\s*\(/.test(chatPreloadSrc) && chatPreloadSrc.indexOf('function fresh()') !== -1,
    'page/chat-preload.js 每只脚本取两遍（绕过缓存 + 走缓存）来比对')
  check(/function\s+verdict\s*\(/.test(chatPreloadSrc) && chatPreloadSrc.indexOf('cachedOk') !== -1,
    'page/chat-preload.js 按两遍的结果给出结论，而不是只报数字')
  check(chatPreloadSrc.indexOf('script[src][integrity]') !== -1,
    'page/chat-preload.js 从 HTML 里读 integrity，而不是把哈希写死一份')
  check(chatPreloadSrc.indexOf('data-deepseek-helper') !== -1 &&
    chatPreloadSrc.indexOf('body.insertBefore') !== -1,
    'page/chat-preload.js 把诊断结果摆到页面上（而不是只打控制台）')
  // 重载有可能"点了没动静"（父窗那个方法不存在、页内 reload 也被拦）。那时探针要自己顶上，
  // 而且报告可能被生成两次（心跳一次、按钮一次），渲染前必须先撤掉旧的，不能越叠越高。
  check(/setTimeout\(function \(\) \{ diagnose\(showDiag\) \}, 5000\)/.test(chatPreloadSrc),
    'page/chat-preload.js 5 秒后页面还活着就开始侦察（重载没真的发生时兜底）')
  check(chatPreloadSrc.indexOf("querySelector('[data-deepseek-helper=\"diag\"]')") !== -1,
    'page/chat-preload.js 渲染前先撤掉上一份报告（不会叠出好几层）')
  // 报告里三个按钮：救一次（绕过缓存）、换个浏览器看、把内容复制出来发给人看
  ;['重新加载（绕过缓存）', '在系统浏览器打开', '复制这些信息'].forEach((label) => {
    check(chatPreloadSrc.indexOf(label) !== -1,
      'page/chat-preload.js 诊断面板上有「' + label + '」按钮')
  })

  // 报告里还要有"浏览器自己记的那次加载"—— 诊断是事后重取的，跟当时那次不是一个请求；
  // 事后重取永远正常，光看它会把"当时请求根本没成"和"当时取到了但没被接受"混为一谈。
  check(chatPreloadSrc.indexOf("getEntriesByType('resource')") !== -1 &&
    chatPreloadSrc.indexOf('responseStatus') !== -1,
    'page/chat-preload.js 读性能时间线，报"这次加载"实际拿到了什么')

  // 最后一道自救：自己把哈希验一遍，再把脚本以"不带 crossorigin"的方式放行
  //（官网的脚本是跨域 + crossorigin + integrity，字节没问题却卡在 CORS 上时只能这么救）。
  // 验不过就必须一个字都不注入 —— 那才是真正的降级，所以这条断言盯的是"验在前、注入在后"。
  check(/function\s+patchAndRun\s*\(/.test(chatPreloadSrc) &&
    /function\s+injectInline\s*\(/.test(chatPreloadSrc),
    'page/chat-preload.js 有"自己验完再放行"这条路')
  check(chatPreloadSrc.indexOf("=== item.expected") !== -1,
    'page/chat-preload.js 放行前拿算出来的哈希跟 HTML 里的 integrity 比过')
  // 实测：插 `<script src>` 和插 `<link rel=stylesheet>` 一样，请求会在 2 毫秒内被挡掉
  // （那只脚本原样的加载就是 HTTP 0、0 字节）。所以放行必须是**内联**的 ——
  // 一旦这里有人改回 `el.src = ...`，"点了试一次没反应"就会回来。
  check(chatPreloadSrc.indexOf('el.textContent = asset.source') !== -1 &&
    chatPreloadSrc.indexOf('el.src = item.src') === -1,
    'page/chat-preload.js 以内联方式放行（不发子资源请求，那条路是被挡的）')
  check(/function\s+injectScripts\s*\(/.test(chatPreloadSrc) === false,
    'page/chat-preload.js 不再走"重新插 <script src>"那条老路')
  // 样式和脚本一样会被挡，只放脚本的结果就是"界面出来了、一个样式都没有"（实测撞上过）
  check(chatPreloadSrc.indexOf('link[rel~="stylesheet"]') !== -1 &&
    chatPreloadSrc.indexOf('style.textContent = text') !== -1,
    'page/chat-preload.js 把样式也取回来插成 <style>（<link> 同样加载不起来）')
  check(chatPreloadSrc.indexOf('stylesToLoad') !== -1 && chatPreloadSrc.indexOf('needStyle') !== -1,
    'page/chat-preload.js 按"浏览器自己记的那次加载拿没拿到字节"挑要重取的样式')
  check(/function\s+restoreBody\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('bodySnapshot') !== -1,
    'page/chat-preload.js 放行前把 body 还原（官网那张错误图删掉了 #root）')
  check(chatPreloadSrc.indexOf('自己验一遍后放行（试一次）') !== -1,
    'page/chat-preload.js 把"放行"做成人点的按钮，不自动动别人的页面')
  // body 得在 _sriCk 动手之前存下来：挂捕获阶段，抢在元素自己的 onerror 前面
  check(/document\.addEventListener\('error', function \(ev\) \{/.test(chatPreloadSrc),
    'page/chat-preload.js 有捕获阶段的脚本失败监听（用来抢存 body）')
  check(chatPreloadSrc.indexOf('el.tagName === \'SCRIPT\'') !== -1,
    'page/chat-preload.js 只对 <script> 的失败动手（别的不碰）')

  // 页面侧重插 <script> 这条路实测走不通（请求压根发不出去，HTTP 0 / 0 字节），
  // 所以失败之后要能自动改走父窗那条路。而"哈希对不上"必须排除在外 ——
  // 父窗取回来的是同样的字节，照样会拒，白跑一趟还容易让人以为换条路就能蒙过去。
  check(/function\s+fallbackReason\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf("reason !== 'integrity'") !== -1,
    'page/chat-preload.js 页面侧失败后会自动改走父窗那条路（哈希对不上除外）')
  check(chatPreloadSrc.indexOf("send('chat:nodeRepair'") !== -1,
    'page/chat-preload.js 把脚本清单交给父窗去 Node 侧取回')
  check(chatPreloadSrc.indexOf('window.__dsHelper') !== -1 &&
    chatPreloadSrc.indexOf('showRepairResult') !== -1,
    'page/chat-preload.js 挂了 window.__dsHelper（父窗只能 executeJavaScript，没有别的说话方式）')

  // "脚本 load 事件到了"和"官网界面起来了"是两件事：脚本可能自己抛错，
  // 也可能要挂的那个 #root 早被那张错误图删掉了。只看 load 会报假成功。
  check(chatPreloadSrc.indexOf('childElementCount') !== -1 &&
    /function\s+rootState\s*\(/.test(chatPreloadSrc),
    'page/chat-preload.js 放行后回读 #root，别把"没报错"当成"起来了"')
  check(chatPreloadSrc.indexOf('securitypolicyviolation') !== -1,
    'page/chat-preload.js 记下 CSP 拦截（万一有哪个环节开始往窗口注入策略）')
  // 探针：光记"没加载成"说不出"为什么"，而"为什么"决定了还有没有路。
  // 同一个地址换几种发法各试一次，成与不成一眼分开。
  check(/function\s+runProbe\s*\(/.test(chatPreloadSrc) &&
    /function\s+probeFetch\s*\(/.test(chatPreloadSrc) &&
    /function\s+probeElement\s*\(/.test(chatPreloadSrc),
    'page/chat-preload.js 有"同一个地址换几种发法"的探针')
  check(chatPreloadSrc.indexOf("data:text/javascript;charset=utf-8") !== -1 &&
    chatPreloadSrc.indexOf('URL.createObjectURL(new Blob(') !== -1 &&
    chatPreloadSrc.indexOf('<img src=官网图标（跨域、非脚本）>') !== -1,
    '探针里含 data: / blob: / 非脚本元素这几路对照 —— 缺哪一路就少一个分岔口')
  check(chatPreloadSrc.indexOf('elFails.length) runProbe()') !== -1 &&
    chatPreloadSrc.indexOf('runProbe()') !== -1,
    '探针在"真的出现过没加载成"时才跑（登录页那种界面正常、个别脚本没加载成的情况也覆盖到）')
  check(chatPreloadSrc.indexOf('── 探针：同一个地址，换几种发法各试一次') !== -1,
    '探针结论进得了那份现场报告')
  // Reporting API：浏览器会主动上报 csp-violation / integrity-violation，说得比 error 事件清楚。
  // 尤其 integrity-violation —— 一条都没报就说明压根不是 SRI 的问题，这个"没有"本身就是结论。
  check(chatPreloadSrc.indexOf('ReportingObserver') !== -1 &&
    chatPreloadSrc.indexOf("'integrity-violation'") !== -1 &&
    chatPreloadSrc.indexOf("'csp-violation'") !== -1 &&
    chatPreloadSrc.indexOf('buffered: true') !== -1,
    'page/chat-preload.js 用 ReportingObserver 收 csp/integrity 报告（buffered 才能补收注册前那几只脚本的）')
  // 浏览器自己记的那次加载是 0 字节 = 请求根本没发出去，这条得给出处方，
  // 否则报告只陈述现象，看的人还是不知道该按哪个按钮。
  check(chatPreloadSrc.indexOf('item.timing.bytes === 0') !== -1,
    'page/chat-preload.js 认得出"那次加载 0 字节 = 请求没发出去"并给出下一步')

  // 元素改道：探针量出来"元素直接取 http(s) 地址"这一类被挡（②⑥失败），
  // 而 fetch / data: / blob: / 非脚本元素都成（①③④⑤成功）。
  // 于是把这一类元素换成"自己 fetch 回文本 → blob 地址 → 再挂上去"。
  // 这条路的边界得在代码里钉住，不能只写在文档里：
  check(/function\s+installShim\s*\(/.test(chatPreloadSrc) &&
    /function\s+shimLoad\s*\(/.test(chatPreloadSrc) &&
    /function\s+shimWants\s*\(/.test(chatPreloadSrc),
    'page/chat-preload.js 有"元素改道"（<script> / <link> 换成自己取的 blob）')
  check(chatPreloadSrc.indexOf('Node.prototype') !== -1 &&
    chatPreloadSrc.indexOf('proto.appendChild = function') !== -1 &&
    chatPreloadSrc.indexOf('proto.insertBefore = function') !== -1,
    '改道装在 appendChild / insertBefore 上（官网注入脚本就是一句 document.head.appendChild）')
  check(chatPreloadSrc.indexOf('origAppend.call(this, node)') !== -1 &&
    chatPreloadSrc.indexOf('origInsert.call(this, node, ref)') !== -1,
    '改道只对"要换的那些"生效，其余原样交给原生方法往下走')
  // 只认 https：页面自己是 https，http 子资源本来就会被混合内容规则挡掉；
  // data: / blob: / file: 更不该经我们的手。本地落地页因此天然够不着。
  check(chatPreloadSrc.indexOf("if (p.protocol !== 'https:') return ''") !== -1,
    '改道只管 https（http / data: / blob: / file: 一概不碰，落地页上不该动手）')
  // 探针那条路必须保持原样，否则量到的是被改过的那条路，结论就废了。
  check(chatPreloadSrc.indexOf('data-ds-probe') !== -1 &&
    chatPreloadSrc.indexOf("el.setAttribute('data-ds-probe', '1')") !== -1,
    '改道绕开探针自己造的元素（不然探针量的是被换过的路）')
  // 顺序：先 fetch → 改 src → 才插进文档。反过来的话，一只是"启动过又失败"的脚本元素
  // 不会再加载；而且官网是先 appendChild 后写 onload，插入推迟到 fetch 完，
  // 它的 onload 才能落在加载之前。
  check(chatPreloadSrc.indexOf('el.src = blobUrl') !== -1 &&
    chatPreloadSrc.indexOf('URL.createObjectURL(new Blob([text]') !== -1 &&
    chatPreloadSrc.indexOf('insert(el)') !== -1,
    '改道是"取回文本 → 换成 blob 地址 → 才插进去"（顺序反了就不会重新加载）')
  // 换不成要能退回原样：退回顶多是今天这个样子，不能更差。
  check(chatPreloadSrc.indexOf('按原样插回去，让浏览器自己去试') !== -1 &&
    chatPreloadSrc.indexOf('if (!res.ok) throw new Error') !== -1,
    '改道失败（取不回、造不出 blob）就按原样插回去，退化成今天的行为')
  // 别转圈：换失败 → 元素报错 → 官网重试 → 又换 —— 得封顶。
  // 而且封的是**按地址**那一层：登录页一屏就有 12 只被挡的元素，
  // 只按总数封 12 的话，后面的等于全放掉了（头一版就是这么写的）。
  check(/var\s+SHIM_MAX\s*=\s*\d+/.test(chatPreloadSrc) &&
    /var\s+SHIM_PER_URL\s*=\s*\d+/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('shimCount < SHIM_MAX') !== -1 &&
    chatPreloadSrc.indexOf('>= SHIM_PER_URL') !== -1,
    '改道两层封顶：总数是保险丝，同一地址试两回就放手（防转圈，不挡正常的量）')
  check(chatPreloadSrc.indexOf("installShim()") !== -1 &&
    chatPreloadSrc.indexOf('deepseek\\.com$/i.test(location.origin)') !== -1,
    '改道只在官网源上挂（preload 跑在页面脚本之前，是最早的时机）')
  check(chatPreloadSrc.indexOf('── 元素改道（<script> / <link> 换走 blob') !== -1,
    '改道记录进得了那份现场报告（换没换、换成没有，一眼可见）')
  // 跨域这条路是"fetch 说了算"（CORS）：能读回字节就成，读不回就按原样插回去。
  // 所以判据里不能再出现"只做同源" —— 那正是头一版写死的、后来证明太窄的那条。
  check(chatPreloadSrc.indexOf('p.host === location.host ? \'same\' : \'cross\'') !== -1 &&
    chatPreloadSrc.indexOf("if (p.protocol !== 'https:') return ''") !== -1,
    '改道同源、跨域都走（同源/跨域只影响日志措辞，能不能成由 fetch 说了算）')
  check(chatPreloadSrc.indexOf('isSameOriginUrl') === -1,
    '不再按"同源"一票否决（跨域的 CDN 实测回 access-control-allow-origin: *）')
  // 那个坑：`el.src` 是空串时，new URL('', location.href) 会解析成"当前页面"，
  // 于是内联 <script> 被误判成同源脚本劫走 —— 报告里那两行
  // `元素换走 blob: /undefined / 8301 字节`（8301 正是 index.html 自己）。
  check(/function\s+rawTarget\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf("el.getAttribute(tag === 'LINK' ? 'href' : 'src')") !== -1 &&
    chatPreloadSrc.indexOf("if (!raw) return ''") !== -1,
    '改道先看原始 src/href 属性（空串会解析成"当前页面"，那样会劫走内联脚本）')
  // 报告里出现过的第二类脏数据：拿回一张 HTML 当脚本灌进去。类型不对就退回原路。
  check(chatPreloadSrc.indexOf("res.headers.get('content-type')") !== -1 &&
    chatPreloadSrc.indexOf('Content-Type 不是') !== -1,
    '改道核对 Content-Type（SPA 兜底会把 HTML 当脚本发回来）')
  // SRI 那类要求按原样对上哈希，blob 里的字节未必对得上（BOM / 非 UTF-8 都可能差一点）。
  check(chatPreloadSrc.indexOf("el.getAttribute('integrity')") !== -1,
    '带 integrity 的元素不换走法（换了只会把"校验没过"引出来）')
  // 边界钉在代码里：这一步只换"走哪条路"，不动"我们是谁"。
  // 伪 UA / 指纹 / 设备型号是另一回事，本文件里一处都不该有。
  check(!/navigator\.userAgent\s*=/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('Object.defineProperty(navigator') === -1 &&
    chatPreloadSrc.indexOf('webdriver') === -1,
    '改道不伪造身份（不碰 UA / navigator / webdriver）—— 只把被挡的那条路换掉')

  // 界面起来了只是第一步：登录、发消息走的是官网自己的 XHR / fetch，那些请求要是也被
  // 同一个东西挡掉，用户看到的只有官网那句"网络异常"，没地址没状态码，什么也判断不了。
  // 所以要在页面最早期把这两个包一层 —— 而且**只观察不改写**（原函数照常调用、
  // 返回值原样返回、异常照旧抛出去），这是别人家的页面。
  check(/function\s+recordNet\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('XMLHttpRequest.prototype.open') !== -1 &&
    chatPreloadSrc.indexOf('XMLHttpRequest.prototype.send') !== -1,
    'page/chat-preload.js 在 preload 阶段就记下 XHR 的请求地址')
  check(chatPreloadSrc.indexOf('xhrSend.apply(this, arguments)') !== -1 &&
    chatPreloadSrc.indexOf('nativeFetch.apply(this, arguments)') !== -1,
    'page/chat-preload.js 只是旁观 XHR / fetch，原样把它们调下去')
  check(chatPreloadSrc.indexOf('function netFailures()') !== -1 &&
    chatPreloadSrc.indexOf('!e.status || e.status >= 400') !== -1,
    'page/chat-preload.js 分得开"连接层面没成（status 0）"和"服务端不高兴（4xx/5xx）"')
  check(chatPreloadSrc.indexOf('这个窗口里失败的请求') !== -1,
    'page/chat-preload.js 把失败的请求列进报告（这才是登录失败时唯一的线索）')

  // 放行成功之后报告不能一收了之：真正会出故障的正是放行之后那一段（登录、发消息）。
  // 收成一条细横条，「复制」**现算**一份最新的（读的是此刻的记录，不是生成报告那一刻的快照）。
  check(chatPreloadSrc.indexOf('reportLines(currentReport)') !== -1,
    'page/chat-preload.js 复制的是"此刻现拼"的报告，不是生成那一刻的快照')
  check(/function\s+collapseDiag\s*\(/.test(chatPreloadSrc) &&
    /function\s+addSmallButton\s*\(/.test(chatPreloadSrc),
    'page/chat-preload.js 放行成功后把报告收成横条（留着入口，不是删掉）')
  check(chatPreloadSrc.indexOf('setTimeout(collapseDiag, 2500)') !== -1 &&
    chatPreloadSrc.indexOf('setTimeout(function () { removeDiag() }, 2500)') === -1 &&
    chatPreloadSrc.indexOf('setTimeout(removeDiag, 2500)') === -1,
    '两条放行成功的路都收成横条，没有哪条还在直接 removeDiag')
  check(chatPreloadSrc.indexOf("addSmallButton(box, '复制'") !== -1 &&
    chatPreloadSrc.indexOf("addSmallButton(box, '详情'") !== -1,
    'page/chat-preload.js 横条上留了「详情」和「复制」')

  // 记录要落 sessionStorage：登录那一步很可能触发一次导航，页面里那份数组跟着文档一起没了
  // （实测：用户回头想复制，报告框已经不在）。同源 sessionStorage 跨导航还在。
  check(chatPreloadSrc.indexOf('sessionStorage.getItem(NET_LOG_KEY)') !== -1 &&
    chatPreloadSrc.indexOf('sessionStorage.setItem(NET_LOG_KEY') !== -1 &&
    chatPreloadSrc.indexOf('var netLog = loadNetLog()') !== -1,
    'page/chat-preload.js 把失败记录落 sessionStorage，并在新文档起来时读回来')
  check(/function\s+netReportText\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('netReport: netReportText') !== -1,
    'page/chat-preload.js 挂出 netReport 让父窗来取（不经过 DOM，所以导航也不怕）')
  check(/function\s+netLines\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('netLines().forEach') !== -1,
    '报告里那一段和父窗取的是同一份排版（netLines），不会两处走样')
  // 登录到底走 XHR/fetch 还是 WebSocket，还没坐实 —— 官网的实时通道正是 WebSocket。
  // 包构造函数只在实例上挂监听、原对象原样返回，prototype 也指回原生的那个。
  check(chatPreloadSrc.indexOf('WrappedWS.prototype = NativeWS.prototype') !== -1 &&
    chatPreloadSrc.indexOf('window.WebSocket = WrappedWS') !== -1,
    'page/chat-preload.js 也看着 WebSocket（原对象原样返回，instanceof 仍然成立）')
  check(chatPreloadSrc.indexOf('CONNECTING') !== -1 && chatPreloadSrc.indexOf('CLOSED') !== -1,
    'page/chat-preload.js 把 WebSocket 的四个常量也跟过去（页面里会写 WebSocket.OPEN）')

  // 面板上那两颗排查按钮
  const panelSrc = fs.readFileSync(path.join(PLUGIN, 'page', 'panel.js'), 'utf8')
  const panelHtml = fs.readFileSync(path.join(PLUGIN, 'index.html'), 'utf8')
  check(panelHtml.indexOf('data-act="devtools"') !== -1 && panelHtml.indexOf('data-act="netlog"') !== -1,
    'index.html 上有「打开对话窗开发者工具」和「复制失败请求记录」两个按钮')
  // 第三颗：「复制排查日志」。页面上的报告看不到父窗那边的东西 ——
  // 浏览器自己说的 `Failed to load resource: net::ERR_…`（直接点名谁掐掉了请求）
  // 只落在 %TEMP% 那个日志文件里，让人自己去翻太费事。
  // （traceSrc 在下面才读进来，所以这组断言放在 trace.js 那一段里。）
  check(mainPreloadSrc.indexOf('openChatDevTools') !== -1 &&
    mainPreloadSrc.indexOf('copyChatDiagnostics') !== -1 &&
    panelSrc.indexOf('host.copyChatDiagnostics()') !== -1 &&
    panelSrc.indexOf('host.openChatDevTools()') !== -1,
    '面板 → preload → js/windows.js 这条线接上了')
  check(panelSrc.indexOf('debugHint.textContent = host.openChatDevTools()') !== -1,
    '这两个按钮的结果是一句话，不能拿去喂 render()（那边要的是窗口状态）')
  // uTools 给插件窗口挂了右键菜单，里面有「开发者工具」这一项（i18n key 是
  // menu.plugin.devTools，accelerator Control+Shift+I，在 app.asar 里能搜到）。
  // 拿不到 openDevTools 时要告诉用户这条路，不能在 GUI 里干瞪眼。
  const windowsSrc2 = fs.readFileSync(path.join(PLUGIN, 'js', 'windows.js'), 'utf8')
  check(windowsSrc2.indexOf('Ctrl+Shift+I') !== -1 && windowsSrc2.indexOf('menu.plugin.devTools') !== -1,
    '拿不到 openDevTools 时给出 GUI 里的等价入口（右键「开发者工具」/ Ctrl+Shift+I）')

  // 排查日志：不依赖任何界面操作，也不依赖页面还在不在
  const traceSrc = fs.readFileSync(path.join(PLUGIN, 'js', 'trace.js'), 'utf8')
  check(traceSrc.indexOf("utools.getPath('temp')") !== -1 &&
    traceSrc.indexOf('deepseek-hovering-net.log') !== -1,
    'js/trace.js 落在 uTools 给的临时目录里（路径固定，事后好找）')
  check(traceSrc.indexOf('fs.appendFileSync') !== -1 && traceSrc.indexOf('MAX_BYTES') !== -1,
    'js/trace.js 追加写，并且有上限（长了就从头来过）')
  check(panelHtml.indexOf('data-act="tracelog"') !== -1 &&
    panelSrc.indexOf('host.copyTraceLog()') !== -1 &&
    mainPreloadSrc.indexOf('copyTraceLog') !== -1 &&
    /function\s+read\s*\(/.test(traceSrc) &&
    traceSrc.indexOf('read,') !== -1,
    'index.html / panel.js / preload.js / trace.js 这条线接上了「复制排查日志」')
  check(traceSrc.indexOf('从中间截断会截坏一行') !== -1 &&
    traceSrc.indexOf('fs.readFileSync(target)') !== -1,
    '读日志是取尾巴，且从整行开头开始（半行日志比没有更误导人）')
  check(mainPreloadSrc.indexOf("ipcRenderer.on('chat:netfail'") !== -1 &&
    mainPreloadSrc.indexOf("ipcRenderer.on('chat:trace'") !== -1,
    '父窗接了页面报上来的失败请求与事件，转到日志文件')
  check(chatPreloadSrc.indexOf("sendQuiet('chat:netfail'") !== -1 &&
    chatPreloadSrc.indexOf('function sendQuiet') !== -1,
    '页面侧把失败的请求报给父窗（用不触发"没有 utools 全局"那条警告的通道）')
  // 上报只发失败的：成功的请求既没用又吵
  check(chatPreloadSrc.indexOf('function isFailure(entry)') !== -1 &&
    chatPreloadSrc.indexOf('if (isFailure(entry)) {') !== -1 &&
    chatPreloadSrc.indexOf("sendQuiet('chat:netfail', entry)") !== -1,
    '页面侧只上报失败的请求，成功的不发')
  check(chatPreloadSrc.indexOf("sendQuiet('chat:trace', '页面侧放行: ") !== -1 &&
    chatPreloadSrc.indexOf("sendQuiet('chat:trace', '父窗放行结果: ") !== -1,
    '两级放行各自的结果都会落到日志里（不靠用户回头去看那个会消失的报告框）')
  check(/require\('\.\/js\/trace'\)/.test(mainPreloadSrc),
    '主 preload 引了 js/trace.js')

  // 网络层观察（js/windows.js）：页面里看得见"谁失败了"，看不见"是谁拦的"。
  const netWatchSrc = fs.readFileSync(path.join(PLUGIN, 'js', 'windows.js'), 'utf8')
  check(/function\s+watchChatNetwork\s*\(/.test(netWatchSrc) &&
    netWatchSrc.indexOf('session.webRequest.onErrorOccurred') !== -1 &&
    netWatchSrc.indexOf('session.webRequest.onCompleted') !== -1,
    '父窗从网络层盯对话窗的请求（Electron 自己的错误码就是指认拦人那一层的证据）')
  check(netWatchSrc.indexOf("'*://chat.deepseek.com/*'") !== -1 && netWatchSrc.indexOf("'*://*.deepseek.com/*'") !== -1,
    '网络层过滤器把范围收在官网域名上（这个口子过的是整个 uTools 的请求流）')
  check(netWatchSrc.indexOf('if ((details.statusCode || 0) < 400) return') !== -1,
    '网络层只记出错的和 >= 400 的（200 的一条都不记）')
  check(netWatchSrc.indexOf('let netWatched = false') !== -1 &&
    netWatchSrc.indexOf('if (netWatched) return') !== -1,
    '网络层观察挂在共用的 session 上，只挂一次（挂两次每条请求记两遍）')
  check(/require\('\.\/trace'\)/.test(netWatchSrc),
    'js/windows.js 引了 trace（网络层那几行才写得到日志）')
  // 头一版失败时只打 console，结果日志里看不出到底挂没挂上 —— 静默过一次就够了
  check(netWatchSrc.indexOf("trace.append('网络层观察: ") !== -1 &&
    netWatchSrc.indexOf("trace.append('网络层观察已挂上: session.webRequest") !== -1 &&
    netWatchSrc.indexOf("trace.append('网络层观察已挂上: CDP") !== -1,
    '网络层挂上了挂不上都要在日志里留一句（不再静默）')
  check(/function\s+watchViaDebugger\s*\(/.test(netWatchSrc) &&
    netWatchSrc.indexOf('Network.loadingFailed') !== -1 &&
    netWatchSrc.indexOf('blockedReason') !== -1 &&
    netWatchSrc.indexOf('Network.requestWillBeSent') !== -1,
    'CDP 那条记下 blockedReason（直接说出是谁拦的）—— loadingFailed 只给 requestId，地址得自己记')
  check(netWatchSrc.indexOf('开发者工具开着的时候挂不上') !== -1,
    'CDP 和开发者工具互斥这件事写在日志和注释里（不然用户只会看到"没效果"）')
  // 第三条路：页面控制台。资源加载失败时浏览器自己往控制台写的那句
  // "Failed to load resource: net::ERR_…" 带着错误码 —— 而那句话**不经过页面的 console 对象**，
  // 在页面里包 console.error 也收不到，只有 webContents 这一侧听得见。
  // uTools 的窗口代理可能压根没给 on()，所以挂不上同样要留话。
  check(/function\s+watchChatConsole\s*\(/.test(netWatchSrc) &&
    netWatchSrc.indexOf("'console-message'") !== -1,
    'js/windows.js 从 webContents 这侧收页面控制台（那句 net::ERR_… 只有这儿听得见）')
  check(netWatchSrc.indexOf('args[0].message') !== -1 && netWatchSrc.indexOf('args[2]') !== -1,
    'console-message 新版（对象）和老版（(event, level, message, …)）两种形状都认')
  check(netWatchSrc.indexOf('CONSOLE_RE') !== -1 && netWatchSrc.indexOf('CONSOLE_MAX') !== -1,
    '控制台只留跟"没加载成"有关的那些，并且有上限（官网自己的日志很吵）')
  check(netWatchSrc.indexOf('webContents 上没有 on()') !== -1,
    '控制台这条路挂不上时留原因，不静默')

  // 422 这类状态码只有服务端自己说得清（官网的界面只会把它翻成"网络异常"）。
  // 但边界要守住：**只读失败的响应体、只留 400 字**，正常响应的正文一个字都不碰。
  check(chatPreloadSrc.indexOf('function clip(text)') !== -1 &&
    chatPreloadSrc.indexOf('s.slice(0, 400)') !== -1,
    'page/chat-preload.js 把服务端的错误说明截到 400 字留下')
  check(chatPreloadSrc.indexOf('body: readXhrBody(xhr)') !== -1 &&
    /function\s+readXhrBody\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf("type !== 'text' && type !== 'json'") !== -1,
    'XHR 失败时读响应体（responseType 不是文本就退开 —— 读了会抛）')
  check(chatPreloadSrc.indexOf('res.clone().text()') !== -1,
    'fetch 失败时 clone 一份读响应体（原件原样还给页面，不能被读掉）')
  check(/if \(res && res\.status >= 400\)/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('正常响应（尤其 SSE 那种长连接）一个字都不碰') !== -1,
    '只有失败的响应才去读正文（正常响应一个字都不碰）')
  check(mainPreloadSrc.indexOf("entry.body ? ' / 服务端说: '") !== -1,
    '服务端那句话会落到排查日志里')

  // 422 最常见的病因是"缺字段"。所以还要记下**我们发出去的字段名** ——
  // 但只有名字和值的长短，没有值：值里是手机号、邮箱、验证码，这份日志是要被贴来贴去的。
  check(/function\s+bodyKeys\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf("return 'str(' + v.length + ')'") !== -1,
    '记请求体的字段名，值只留类型和长度（手机号、验证码不进日志）')
  check(chatPreloadSrc.indexOf('bodyKeys(init && init.body)') !== -1 &&
    chatPreloadSrc.indexOf('sent = bodyKeys(arguments[0])') !== -1,
    'fetch 和 XHR 两条路都记下了发出去的字段')
  check(mainPreloadSrc.indexOf("entry.sent ? ' / 我们发的字段: '") !== -1,
    '发出去的字段名会落到排查日志里')
  check(chatPreloadSrc.indexOf("if (e.sent) lines.push('      我们发的：' + e.sent)") !== -1,
    '报告里也带上发出去的字段名')

  // 实测那颗子弹（服务端说 body.device_id）指向的是官网的设备指纹脚本 /static/fp.min.js ——
  // 登录请求里的 device_id 就是它给的，而它是**运行时由 JS 插进来**的一个 <script>，
  // 正好落在"元素发起的请求会被拦掉"那一类里。所以要认的是这一整类，不是 HTML 里写死的几个。
  check(/function\s+deviceState\s*\(/.test(chatPreloadSrc) &&
    chatPreloadSrc.indexOf('没有 window.SMSdk') !== -1 &&
    chatPreloadSrc.indexOf("querySelector('script[data-fp]')") !== -1,
    '报告里说得出设备指纹（数美 SMSdk）当时是什么状态')
  check(chatPreloadSrc.indexOf("return (id ? 'deviceId 长度 '") !== -1,
    '指纹的 deviceId 只报长度和开头几个字符，不报完整值')
  check(chatPreloadSrc.indexOf("window.addEventListener('error', function (ev)") !== -1 &&
    chatPreloadSrc.indexOf("tag !== 'script' && tag !== 'link' && tag !== 'img'") !== -1 &&
    chatPreloadSrc.indexOf('}, true)') !== -1,
    '捕获阶段监听资源错误（它们不冒泡，只在捕获阶段露面）')
  check(chatPreloadSrc.indexOf('资源没加载成: ') !== -1 &&
    chatPreloadSrc.indexOf("entry.fp ? '（官网的设备指纹脚本") !== -1,
    '元素没加载成的会单记一行，指纹那一只还额外标出来')
  check(mainPreloadSrc.indexOf("entry.device ? ' / 指纹: '") !== -1,
    '失败请求那一行会带上指纹当时的状态')

  // 存储键在 js/config.js 和 page/chat-preload.js 里各写了一份（渲染进程 require 不到主 preload 的模块）。
  // 两处对不上就是"记不住会话"这种最难查的静默故障，这里把字面量钉在一起。
  const configSrc = fs.readFileSync(path.join(PLUGIN, 'js', 'config.js'), 'utf8')
  const keyLiteral = chatPreloadSrc.match(/KEY_LAST_URL\s*=\s*'([^']+)'/)
  if (check(!!keyLiteral, 'page/chat-preload.js 里能找到 lastChatUrl 的键名')) {
    check(configSrc.indexOf("lastChatUrl: '" + keyLiteral[1] + "'") !== -1,
      '两处用的会话地址存储键一致: ' + keyLiteral[1])
  }

  checkOfficialIcon(files)
}

// ---------------------------------------------------------------- 2.7 快捷键接线

/**
 * 快捷键这条链路上有两个字面量必须跨文件对上，错了都是"按了没反应"级别的静默故障：
 *
 *   plugin.json                     preload.js
 *   features[].code  ←──配对──→     HOTKEY_FEATURE（进入插件时认出"这是快捷键来的"）
 *   features[].cmds[] ←──配对──→    HOTKEY_CMD（getCmdHotKey / redirectHotKeySetting 的入参）
 *
 * 对不上的表现：按快捷键进了插件却什么都没发生（code 不匹配，走了普通入口），
 * 或者面板上永远显示"未设置"、点「设置」跳到一个空的配置页（指令名不匹配）。
 */
function checkHotkeyWiring(manifest) {
  console.log('快捷键接线')
  if (!manifest) return

  const src = fs.readFileSync(path.join(PLUGIN, 'preload.js'), 'utf8')
  const feature = src.match(/HOTKEY_FEATURE\s*=\s*'([^']+)'/)
  const cmd = src.match(/HOTKEY_CMD\s*=\s*'([^']+)'/)
  if (!check(!!feature && !!cmd, 'preload.js 里声明了快捷键的 feature code 和指令名')) return

  const features = (manifest.features || []).filter((f) => f.code === feature[1])
  check(features.length === 1, 'plugin.json 里有 code 为 ' + feature[1] + ' 的功能',
    '找到 ' + features.length + ' 个')
  if (features.length !== 1) return

  const f = features[0]
  check((f.cmds || []).indexOf(cmd[1]) !== -1,
    '该功能的 cmds 里有指令「' + cmd[1] + '」（快捷键就是绑在它上面的）')
  // 走快捷键进来时 uTools 不显示主窗口，全靠这个开关；漏了就是"按快捷键弹出搜索框"
  check(f.mainHide === true, '该功能配了 mainHide（走快捷键进来时不闪 uTools 搜索框）')
  check(exists(f.icon), '快捷键功能也有图标: ' + f.icon)

  check(/redirectHotKeySetting\(\s*HOTKEY_CMD\s*\)/.test(src),
    'preload.js 用 redirectHotKeySetting 把用户送去配置页')
  check(/getCmdHotKey\(\s*HOTKEY_CMD\s*\)/.test(src),
    'preload.js 用 getCmdHotKey 读当前配的快捷键')

  // 这条最关键：插件没有注册系统级快捷键的 API，只能靠 uTools 的 from === 'hotkey' 分发。
  // 要是有人把 onPluginEnter 里的 code 分支删了，快捷键就会变成"只是打开一下面板"。
  const enterBlock = src.match(/onPluginEnter\(([\s\S]*?)\n\}\)/)
  check(!!enterBlock && enterBlock[1].indexOf('HOTKEY_FEATURE') !== -1,
    'onPluginEnter 里按 feature code 分发了快捷键那条路')

  // 面板上得有"当前快捷键 + 设置入口"，否则用户无从知道这个功能存在
  const html = fs.readFileSync(path.join(PLUGIN, 'index.html'), 'utf8')
  check(/id="hotkeyValue"/.test(html) && /id="hotkeyHint"/.test(html),
    'index.html 里有快捷键的显示元素')
}

// ---------------------------------------------------------------- 2.6 官网图标

/**
 * 图标必须来自官网的 favicon，而且 logo.png 得是照着当前那条路径画出来的。
 *
 * 这里最容易出的事故是"改了 assets/whale.svg 却忘了跑 npm run icons"：
 * logo.png 会一直是旧图，而文件本身完全合法，看代码、看日志都发现不了。
 * 所以 gen-icons.js 把源路径的 sha256 前 16 位写进了图片的 tEXt 里，这里拿来核对。
 */
function checkOfficialIcon(files) {
  console.log('官网图标')

  const svgPath = path.join(PLUGIN, 'assets', 'whale.svg')
  if (!check(fs.existsSync(svgPath), 'assets/whale.svg 存在（三个页面和图标生成器都用它）')) return
  const svg = fs.readFileSync(svgPath, 'utf8')

  const paths = svg.match(/<path\b[^>]*\sd="[^"]+"/g) || []
  check(paths.length === 1, 'whale.svg 里就一条路径（官网 favicon 的样子）', '当前 ' + paths.length + ' 条')

  const d = (svg.match(/<path[^>]*\sd="([^"]+)"/) || [])[1]
  if (!check(!!d, 'whale.svg 的路径能读出来')) return
  // gen-icons.js 的栅格化器只认 M/L/H/V/C/Z。换成一条带弧线(A/a)或二次曲线(Q/q)的路径，
  // 生成图标时会直接抛错 —— 与其等到那时候，不如在这里说清楚。
  const cmds = new Set((d.match(/[A-Za-z]/g) || []).map((c) => c.toUpperCase()))
  const unsupported = [...cmds].filter((c) => 'MLHVCZ'.indexOf(c) === -1)
  check(unsupported.length === 0, 'whale.svg 的路径只用 M/L/H/V/C/Z（栅格化器认得的命令）',
    '遇到了 ' + unsupported.join('/'))
  check((d.match(/[Cc]/g) || []).length > 0, 'whale.svg 的路径里有贝塞尔曲线（是官网那条鲸鱼）')

  // 页面里的标记必须是这张图，不能又缩回自绘的星芒
  const pages = ['index.html', 'page/ball.html', 'page/chat.html']
  pages.forEach((page) => {
    const html = fs.readFileSync(path.join(PLUGIN, page), 'utf8')
    check(/<img[^>]+assets\/whale\.svg/.test(html), page + ' 的图标用的是 assets/whale.svg')
    check(html.indexOf('M10.5 2.5 Q10.5') === -1, page + ' 里没有残留的自绘星芒路径')
  })

  const png = path.join(PLUGIN, 'assets', 'logo.png')
  if (!check(fs.existsSync(png), 'assets/logo.png 存在')) return

  const fingerprint = crypto.createHash('sha256').update(d).digest('hex').slice(0, 16)
  const embedded = pngText(fs.readFileSync(png), 'deepseek-whale')
  check(embedded === fingerprint,
    'logo.png 是照着当前的 whale.svg 生成的（指纹 ' + fingerprint + '）',
    embedded ? '图片里是 ' + embedded + ' —— 改过 whale.svg，跑一下 npm run icons' : '图片里没找到指纹')
}

/** 从 PNG 里读一个 tEXt 的值。只走 chunk 头，不碰像素。 */
function pngText(buf, keyword) {
  let offset = 8
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    if (type === 'tEXt') {
      const data = buf.subarray(offset + 8, offset + 8 + len)
      const sep = data.indexOf(0)
      if (sep > 0 && data.toString('latin1', 0, sep) === keyword) {
        return data.toString('latin1', sep + 1)
      }
    }
    if (type === 'IEND') break
    offset += 12 + len
  }
  return null
}

// ---------------------------------------------------------------- 2.5 面板契约

/**
 * 面板上的按钮和 page/panel.js 里的动作表必须一一对上，它 getElementById 的每个 id
 * 也得真的在 index.html 里。这两处对不上在 GUI 里就是"点了没反应"，而且控制台一声不吭。
 */
function checkPanelContract() {
  console.log('面板契约')
  const html = fs.readFileSync(path.join(PLUGIN, 'index.html'), 'utf8')
  const js = fs.readFileSync(path.join(PLUGIN, 'page', 'panel.js'), 'utf8')

  const inHtml = new Set()
  let m
  const actRe = /data-act\s*=\s*["']([^"']+)["']/g
  while ((m = actRe.exec(html))) inHtml.add(m[1])
  check(inHtml.size > 0, 'index.html 里声明了 ' + inHtml.size + ' 个 data-act 动作')

  const block = js.match(/var ACTIONS = \{([\s\S]*?)\n {2}\}/)
  if (!check(!!block, 'page/panel.js 里能找到 ACTIONS 表')) return

  // 只认行首的 `名字: ...`，注释和行内内容不会被算进来
  const handled = new Set()
  const keyRe = /^ {4}(\w+)\s*:/gm
  while ((m = keyRe.exec(block[1]))) handled.add(m[1])
  check(handled.size > 0, 'ACTIONS 表里解析出 ' + handled.size + ' 个动作')

  const dead = [...inHtml].filter((a) => !handled.has(a))
  check(dead.length === 0, '面板上每个按钮都有对应的处理函数',
    dead.length ? '没人管: ' + dead.join(', ') : '')

  const orphan = [...handled].filter((a) => !inHtml.has(a))
  check(orphan.length === 0, 'ACTIONS 表里每个动作都有对应的按钮',
    orphan.length ? '页面上没有: ' + orphan.join(', ') : '')

  const ids = new Set()
  const idRe = /getElementById\(\s*'([^']+)'\s*\)/g
  while ((m = idRe.exec(js))) ids.add(m[1])
  const missingIds = [...ids].filter((id) => html.indexOf('id="' + id + '"') === -1)
  check(missingIds.length === 0, 'panel.js 取的 ' + ids.size + ' 个元素在面板里都存在',
    missingIds.length ? '缺少 #' + missingIds.join(', #') : '')

  // 单选组的名字是硬编码在 panel.js 里查的，对不上就永远勾不上
  check(/name="openin"/.test(html), '面板里有 name="openin" 的单选组（panel.js 按这个名字查）')
}

// ---------------------------------------------------------------- 3. 冒烟测试

function createHarness(options) {
  const opts = options || {}
  const state = {
    created: [],
    pending: [],
    ipc: {},
    db: new Map(),
    external: [],
    listeners: {},
    mainWindowShown: 0,
    mainWindowHidden: 0,
    // uTools 自己存着全局快捷键，插件只能读、不能写
    hotkeys: {},
    hotkeySettingFor: null,
    // 父窗写进剪贴板的东西（面板上的「复制失败请求记录」）
    clipboard: [],
    // trace.js 要的目录、以及它写日志的动作（fs 是桩件，不落盘）
    paths: { temp: 'C:\\fake-temp' },
    logSize: 0,
    // 「复制排查日志」读回来的那份内容（桩件，磁盘上当然没有真文件）
    logText: '',
    logReadThrow: false,
    fsWrites: [],
    fsThrow: false,
    // 开发者工具开着时，webContents 上已经有一个调试器了 —— CDP 那条路会 attach 失败。
    // 这个开关就是用来测"失败时日志里有没有留话"的。
    devToolsOpen: false,
  }

  // 只记不写的 fs。statSync 永远报 logSize —— 那是为了让"日志超限就从头上重来"
  // 这条能测到（真去造一个 512KB 的文件既慢又脏）。
  const fakeFs = {
    statSync() { return { size: state.logSize } },
    writeFileSync(file, text) { state.fsWrites.push({ op: 'write', file, text }) },
    readFileSync() {
      if (state.logReadThrow) throw new Error('ENOENT: 没有这个文件')
      return Buffer.from(state.logText || '')
    },
    appendFileSync(file, text) {
      if (state.fsThrow) throw new Error('EACCES: 磁盘不让写')
      state.fsWrites.push({ op: 'append', file, text })
    },
  }

  function fakeWindow(id) {
    const win = {
      id,
      url: null,
      options: null,
      sent: [],
      destroyed: false,
      visible: false,
      // 焦点单独建模：快捷键的三态全靠 isFocused 分辨"窗口在眼前"还是"被盖住了"，
      // 一律返回 true 的话，测出来的就只是个纯开关。
      focused: false,
      minimized: false,
      bounds: { x: 0, y: 0, width: 60, height: 60 },
      resizable: true,
      onTop: null,
      webContents: {
        id: id,
        // 对话窗的"官网脚本没通过完整性校验 → 绕过缓存重载"这条路会调这两个方法
        // （见 js/windows.js 的 reloadChatIgnoringCache）。记下来，好在断言里数次数。
        reloads: 0,
        cachelessReloads: 0,
        reload() { win.webContents.reloads++ },
        reloadIgnoringCache() { win.webContents.cachelessReloads++ },
        // 修复兜底（js/windows.js 的 repairChat）会往页面里 executeJavaScript。
        // 记下灌进去了什么 —— 断言里要盯的就是"没验过的脚本一个字符都不许进去"。
        // 回读 #root 子节点数时返回 jsReturn。
        jsCalls: [],
        jsReturn: 0,
        // 父窗来问"这个窗口里失败的请求"时返回的文本（见 collectChatDiagnostics）
        netText: '对话窗：https://chat.deepseek.com/\n── 这个窗口里失败的请求（记了 0 条，其中失败 0 条）',
        devToolsMode: null,
        openDevTools(options) { win.webContents.devToolsMode = options || {} },
        executeJavaScript(code) {
          win.webContents.jsCalls.push(code)
          if (String(code).indexOf('netReport') !== -1) return Promise.resolve(win.webContents.netText)
          if (String(code).indexOf('#root') !== -1) return Promise.resolve(win.webContents.jsReturn)
          return Promise.resolve(undefined)
        },
        send(channel, payload) {
          win.sent.push({ channel, payload })
        },
        // 页面控制台（js/windows.js 的 watchChatConsole）：从 webContents 这一侧能听见
        // 浏览器自己写的那句 "Failed to load resource: net::ERR_…"。
        // emitConsole 是给断言用的 —— 喂一句进去，看日志里有没有留下它。
        onHandlers: {},
        on(event, cb) {
          const box = win.webContents.onHandlers
          box[event] = (box[event] || []).concat([cb])
        },
        emitConsole(message, level) {
          ;(win.webContents.onHandlers['console-message'] || []).forEach((cb) => {
            // 新版的形状：一个对象
            cb({ level: level || 'error', message })
          })
        },
        // 网络层观察（js/windows.js 的 watchChatNetwork）靠 session.webRequest 拿
        // Electron 自己的错误码。这里做个能触发的假的：断言里既能验证"挂上了"，
        // 也能验证"记的是错误码和状态码，不是流水账"。
        session: {
          webRequest: {
            filters: [],
            handlers: {},
            onErrorOccurred(filter, handler) {
              win.webContents.session.webRequest.filters.push(filter)
              win.webContents.session.webRequest.handlers.error = handler
            },
            onCompleted(filter, handler) {
              win.webContents.session.webRequest.filters.push(filter)
              win.webContents.session.webRequest.handlers.completed = handler
            },
          },
        },
        // CDP 那条路（js/windows.js 的 watchViaDebugger）：attach / on / sendCommand。
        // emit 是给断言用的 —— 往里喂一条 loadingFailed，看日志里有没有那句话。
        debugger: {
          version: null,
          commands: [],
          listeners: [],
          attach(version) {
            if (state.devToolsOpen) throw new Error('Another debugger is already attached to the webContents')
            win.webContents.debugger.version = version
          },
          on(event, cb) {
            win.webContents.debugger.listeners.push({ event, cb })
          },
          sendCommand(cmd) {
            win.webContents.debugger.commands.push(cmd)
            return Promise.resolve({})
          },
          emit(method, params) {
            win.webContents.debugger.listeners.forEach((l) => {
              if (l.event === 'message') l.cb({}, method, params)
            })
          },
        },
      },
      show() { win.visible = true; win.minimized = false; win.focused = true },
      hide() { win.visible = false; win.focused = false },
      focus() { win.focused = true },
      blur() { win.focused = false },
      minimize() { win.minimized = true; win.focused = false },
      restore() { win.minimized = false },
      isMinimized() { return win.minimized },
      close() { win.destroyed = true; win.focused = false },
      destroy() { win.destroyed = true; win.focused = false },
      isDestroyed() { return win.destroyed },
      isVisible() { return win.visible },
      isFocused() { return win.focused },
      getPosition() { return [win.bounds.x, win.bounds.y] },
      setPosition(x, y) { win.bounds.x = x; win.bounds.y = y },
      getBounds() { return { x: win.bounds.x, y: win.bounds.y, width: win.bounds.width, height: win.bounds.height } },
      setBounds(b) { Object.assign(win.bounds, b) },
      setResizable(v) { win.resizable = v },
      setAlwaysOnTop(v, level) { win.onTop = { v, level } },
      // 记下有没有人调过 loadURL。真实环境里 uTools 的窗口实例根本没这个方法
      // （实测 8.0.0 抛 "win.loadURL is not a function"），谁加回来这里就红。
      loadURLs: [],
      loadURL(url) { win.loadURLs.push(url); return Promise.resolve() },
      // 真实 BrowserWindow 会按 options 初始化尺寸/位置/可缩放/是否可见，
      // 桩件也得照做，否则拖拽这类基于初始位置的断言全是假的。
      applyOptions(o) {
        win.options = o
        win.bounds = {
          x: typeof o.x === 'number' ? o.x : 0,
          y: typeof o.y === 'number' ? o.y : 0,
          width: typeof o.width === 'number' ? o.width : 800,
          height: typeof o.height === 'number' ? o.height : 600,
        }
        win.resizable = o.resizable !== false
        win.visible = o.show !== false
        // 真实窗口显示出来的同时就拿到焦点（我们的两个窗口都是用户主动开的）
        win.focused = win.visible
        win.minimized = false
      },
      sentChannels() { return win.sent.map((s) => s.channel) },
      lastSent(channel) {
        const hit = win.sent.filter((s) => s.channel === channel)
        return hit.length ? hit[hit.length - 1].payload : undefined
      },
    }
    return win
  }

  const electron = {
    ipcRenderer: {
      on(channel, handler) {
        ;(state.ipc[channel] = state.ipc[channel] || []).push(handler)
      },
      send() {},
    },
    shell: {
      openExternal(url) { state.external.push(url); return Promise.resolve() },
    },
    // 面板上的「复制失败请求记录」在父窗里写剪贴板 —— 走 Node 侧就没必要
    // 依赖页面还在不在（报告框挂在官网 DOM 上，导航一下就没了）。
    clipboard: {
      writeText(text) { state.clipboard.push(text) },
    },
  }

  const utools = {
    onPluginReady(cb) { state.listeners.ready = cb },
    onPluginEnter(cb) { state.listeners.enter = cb },
    onPluginOut(cb) { state.listeners.out = cb },
    onScheduleTrigger(cb) { state.listeners.schedule = cb },

    createBrowserWindow(url, options, callback) {
      const win = fakeWindow(state.created.length + 1)
      win.url = url
      win.applyOptions(options || {})
      state.created.push(win)
      if (typeof callback === 'function') {
        // 真实 uTools 是在页面加载完成后才回调的（官方示例里回调闭包引用了
        // createBrowserWindow 的返回值，说明它必然晚于返回）。
        // 两种时序都跑一遍：异步是真实行为，同步用来确认代码没依赖那个时序。
        if (opts.callbackMode === 'sync') callback(win)
        else state.pending.push(() => callback(win))
      }
      return win
    },

    dbStorage: {
      setItem(k, v) { state.db.set(k, v) },
      getItem(k) { return state.db.has(k) ? state.db.get(k) : null },
      removeItem(k) { state.db.delete(k) },
    },

    getPrimaryDisplay() { return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } } },
    getDisplayNearestPoint() { return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } } },
    getCursorScreenPoint() { return { x: 0, y: 0 } },
    getPath(name) { return state.paths[name] || null },
    shellOpenExternal(url) { state.external.push(url); return Promise.resolve() },
    hideMainWindow() { state.mainWindowHidden++ },
    showMainWindow() { state.mainWindowShown++ ; return true },
    setExpandHeight() { return true },
    isDarkColors() { return false },
    // 快捷键：读用户配的键、跳到设置页。两个都是"只读/只跳转"的接口
    getCmdHotKey(label) { return state.hotkeys[label] || null },
    redirectHotKeySetting(label) { state.hotkeySettingFor = label },
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Buffer,
    process,
    window: {},
    utools,
  }
  sandbox.globalThis = sandbox
  const context = vm.createContext(sandbox)

  const cache = new Map()
  function resolveModule(fromDir, spec) {
    const base = path.resolve(fromDir, spec)
    const candidates = [base, base + '.js', path.join(base, 'index.js')]
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    }
    return null
  }

  function loadModule(file) {
    const resolved = path.resolve(file)
    if (cache.has(resolved)) return cache.get(resolved).exports
    const mod = { exports: {} }
    cache.set(resolved, mod)
    const code = fs.readFileSync(resolved, 'utf8')
    const dir = path.dirname(resolved)
    const fn = vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], {
      filename: resolved,
      parsingContext: context,
    })
    const localRequire = (spec) => {
      if (spec === 'electron') return electron
      // fs 换成个"只记不写"的桩：js/trace.js（排查日志）是唯一用它的模块，
      // 自检不该在磁盘上留文件 —— 更不该往真实的临时目录里写日志。
      if (spec === 'fs') return fakeFs
      if (spec === 'path' || spec === 'zlib' || spec === 'https' || spec === 'crypto') {
        return require(spec)
      }
      if (spec.startsWith('.')) {
        const target = resolveModule(dir, spec)
        if (!target) throw new Error('找不到模块 ' + spec + '（来自 ' + rel(resolved) + '）')
        return loadModule(target)
      }
      throw new Error('插件不该依赖外部包，但 ' + rel(resolved) + ' 要求了 ' + spec)
    }
    fn(mod.exports, localRequire, mod, resolved, dir)
    return mod.exports
  }

  state.load = (relPath) => loadModule(path.join(PLUGIN, relPath))
  state.sandbox = sandbox
  state.flush = () => {
    const jobs = state.pending.splice(0)
    jobs.forEach((job) => job())
  }
  return state
}

function fireIpc(state, channel, payload) {
  const handlers = state.ipc[channel]
  if (!handlers || !handlers.length) {
    fail('主 preload 没有监听 ' + channel)
    return
  }
  handlers.forEach((h) => h({}, payload))
}

async function runScenario(state) {
  const flush = () => state.flush()

  try {
    state.load('preload.js')
  } catch (e) {
    fail('加载 preload.js 失败: ' + e.message)
    return
  }
  ok('preload.js 可以在桩件环境里加载')

  const host = state.sandbox.window.deepseekHost
  if (!check(host && typeof host === 'object', 'preload 挂了 window.deepseekHost（主面板靠它通信）')) return

  const expected = ['state', 'onChange', 'showBall', 'hideBall', 'toggleBall', 'resetBallPos',
    'openChat', 'closeChat', 'toggleChat', 'summonChat', 'openHotkeySetting',
    'openInBrowser', 'setOpenIn', 'setChatSize', 'resetChatSize', 'setPanelHeight', 'hidePanel']
  const missing = expected.filter((k) => typeof host[k] !== 'function')
  check(missing.length === 0, 'deepseekHost 暴露了面板需要的全部方法', missing.length ? '缺少 ' + missing.join(', ') : '')

  check(typeof state.listeners.enter === 'function', '注册了 onPluginEnter')
  check(typeof state.listeners.out === 'function', '注册了 onPluginOut')
  check(!!state.ipc['chat:url'], '主 preload 监听对话窗上报的地址')

  // --- 进入插件 ---
  const before = state.created.length
  state.listeners.enter({ code: 'deepseek', type: 'text' })
  await flush()
  check(state.created.length === before + 1, '进入插件后创建了悬浮球窗口')

  const ball = state.created[0]
  if (!check(!!ball, '拿到了悬浮球窗口')) return
  check(ball.url === 'page/ball.html', '悬浮球窗口加载 page/ball.html', ball.url)
  check(exists(ball.url), '悬浮球页面文件存在')
  check(ball.options.transparent === true, '悬浮球窗口是透明的')
  check(ball.options.frame === false, '悬浮球窗口无边框')
  check(ball.options.alwaysOnTop === true, '悬浮球窗口置顶')
  check(ball.options.skipTaskbar === true, '悬浮球窗口不进任务栏')
  check(ball.options.resizable === false, '悬浮球窗口不可缩放')
  check(ball.options.width === 60 && ball.options.height === 60, '悬浮球窗口是 60×60')
  check(!!ball.options.backgroundColor && ball.options.backgroundColor !== '#00000000',
    '透明窗口设了非全透明的 backgroundColor（否则收不到鼠标事件）', String(ball.options.backgroundColor))
  const ballPreload = ball.options.webPreferences && ball.options.webPreferences.preload
  check(!!ballPreload && exists(ballPreload), '悬浮球 preload 存在: ' + ballPreload)
  check(ball.visible === true, '悬浮球窗口已显示')
  check(ball.sentChannels().indexOf('ball:shown') !== -1, '通知球页可以播入场动画了')

  // --- 点球开对话 ---
  const beforeChat = state.created.length
  fireIpc(state, 'ball:click')
  await flush()
  check(state.created.length === beforeChat + 1, '单击悬浮球打开了对话窗')
  check(state.mainWindowHidden >= 1, '打开对话时顺手收起了 uTools 搜索框（有的话）')

  const chat = state.created[1]
  if (!check(!!chat, '拿到了对话窗')) return
  check(chat.url === 'page/chat.html', '对话窗先加载本地落地页', chat.url)
  check(exists(chat.url), '对话落地页文件存在')
  // uTools 返回的窗口实例没有 loadURL（实测 8.0.0），跳转必须由页面自己做。
  // 谁要是又加回 loadURL，这里会立刻红。
  check(chat.loadURLs.length === 0, '父窗不调用 win.loadURL（uTools 的实例上没有这个方法）')
  check(chat.visible === true, '对话窗开出来就是可见的')
  check(host.state().chatOpen === true, 'state() 反映对话窗是开着的')

  // 默认尺寸按手机比例，比真机略大一圈
  check(chat.options.width === 460 && chat.options.height === 900,
    '对话窗默认是手机尺寸 460×900', chat.options.width + '×' + chat.options.height)
  check(chat.options.minWidth === 320 && chat.options.minHeight === 400,
    '对话窗有最小尺寸，拖不小到看不见', chat.options.minWidth + '×' + chat.options.minHeight)
  check(chat.options.center === true, '对话窗居中打开')
  const chatPreload = chat.options.webPreferences && chat.options.webPreferences.preload
  check(chatPreload === 'page/chat-preload.js' && exists(chatPreload),
    '对话窗挂上了 chat-preload（要靠它上报会话地址）: ' + chatPreload)

  // --- 再点球：开着就该关掉 ---
  const beforeToggle = state.created.length
  fireIpc(state, 'ball:click')
  await flush()
  check(state.created.length === beforeToggle, '窗口开着时点球不会再开一个新窗')
  check(chat.destroyed === true, '窗口开着时点球把窗口关掉了')
  check(host.state().chatOpen === false, '关掉之后 state().chatOpen 跟着变 false')

  fireIpc(state, 'ball:requestMenu')
  check(ball.lastSent('ball:menu').items[0].label === '打开对话',
    '窗口关着时菜单首项是「打开对话」', ball.lastSent('ball:menu').items[0].label)
  fireIpc(state, 'ball:menuClose')

  // --- 再点球：关着就该开回来 ---
  const beforeReopen = state.created.length
  fireIpc(state, 'ball:click')
  await flush()
  check(state.created.length === beforeReopen + 1, '窗口关着时点球重新开窗')
  const chat2 = state.created[state.created.length - 1]
  check(chat2.visible === true && chat2.bounds.width === 460, '重开的对话窗正常显示')

  fireIpc(state, 'ball:requestMenu')
  check(ball.lastSent('ball:menu').items[0].label === '关闭对话',
    '窗口开着时菜单首项是「关闭对话」', ball.lastSent('ball:menu').items[0].label)
  fireIpc(state, 'ball:menuClose')

  // 已经开着时 openChat() 只前置不重开（面板上的按钮与球走的是同一条路）
  const beforeReuse = state.created.length
  host.openChat()
  await flush()
  check(state.created.length === beforeReuse, 'openChat() 对已存在的窗口只做复用')
  check(chat2.focused === true, '复用时会聚焦已存在的对话窗')

  // isVisible 在 uTools 各版本上不保证存在（loadURL 就是这么没的）。没有它时点球
  // 必须仍然能关窗 —— 判据降级为"窗口还在就算开着"，开开关关依然成立。
  delete chat2.isVisible
  check(host.toggleChat().chatOpen === false, 'isVisible 缺失时点球仍然能关掉窗口')
  check(chat2.destroyed === true, 'isVisible 缺失时窗口确实被关掉了')
  check(host.toggleChat().chatOpen === true, 'isVisible 缺失时再点一次又能开回来')

  // --- 记住上次打开的会话 ---
  //
  // 对话窗跑在官网页面上时会一直报当前地址回来（chat:url）。判定规则只有三种结果：
  // 会话地址→记住，回到对话首页→忘掉，其它（登录页、跳转页）→不碰。
  const CONV = 'https://chat.deepseek.com/a/chat/s/75e63fe1-08bc-4e0b-a957-270557e00482'
  fireIpc(state, 'chat:url', CONV + '#ignored-hash')
  check(state.db.get('deepseek:lastChatUrl') === CONV,
    '会话地址被记住（hash 被剥掉）', String(state.db.get('deepseek:lastChatUrl')))

  fireIpc(state, 'chat:url', 'https://chat.deepseek.com/sign_in')
  check(state.db.get('deepseek:lastChatUrl') === CONV,
    '登录页之类的中转地址不会冲掉记住的会话', String(state.db.get('deepseek:lastChatUrl')))

  fireIpc(state, 'chat:url', 'https://example.com/whatever')
  check(state.db.get('deepseek:lastChatUrl') === CONV, '站外地址不会被记住')

  fireIpc(state, 'chat:url', '')
  check(state.db.get('deepseek:lastChatUrl') === CONV, '空地址被忽略，不会清掉记录')

  // 官网的 JS 带 integrity（SRI），校验没过时官网会把自己的 body 换成一张
  // "页面资源加载异常，请刷新重试"的图。页面侧认出来后求父窗绕过缓存重载
  // —— 坏副本往往同时在缓存里，页内 location.reload() 会把它原样捞回来。
  const sriWin = state.created[state.created.length - 1]
  const cachelessBefore = sriWin.webContents.cachelessReloads
  fireIpc(state, 'chat:sri', { url: 'https://chat.deepseek.com/' })
  check(sriWin.webContents.cachelessReloads === cachelessBefore + 1,
    '官网脚本没通过完整性校验时，父窗绕过缓存重载对话窗')
  check(sriWin.destroyed === false, '重载不会顺手把窗口销毁')
  check(sriWin.webContents.reloads === 0,
    '能绕过缓存时不该退化成普通 reload', String(sriWin.webContents.reloads))

  const chatUrlWin = state.load('js/windows.js')
  check(chatUrlWin.chatTargetUrl() === CONV, '下次开窗的目标就是记住的会话',
    chatUrlWin.chatTargetUrl())

  // 第二条兜底：页面连这个请求都发不出去时（实测就是如此），改由父窗在 Node 侧取回官网脚本、
  // 按 HTML 里写的 integrity 验过哈希，再 executeJavaScript 灌进对话窗。这里只验接线是通的、
  // 清单为空时立刻收手、"没验过的脚本一个字符都不许进去"；取回→校验→注入的完整流水线
  // 在 checkRepair() 里用假件跑（真去取官网的字节会让自检依赖网络）。
  const emptyRepair = await chatUrlWin.repairChat({ scripts: [] })
  check(emptyRepair && emptyRepair.ok === false && emptyRepair.reason === 'noscripts',
    '没有脚本清单时 Node 侧修复立刻收手（不空跑一次网络）', JSON.stringify(emptyRepair))
  check(sriWin.webContents.jsCalls.every((code) => code.indexOf('showRepairResult') !== -1),
    '没验过的脚本一个字符都不会灌进页面',
    JSON.stringify(sriWin.webContents.jsCalls.map((c) => String(c).slice(0, 40))))

  // --- 排查日志落文件（js/trace.js）---
  // 这一条是被现实逼出来的：前面两版取证手段都要求用户在 GUI 里配合，而它们一个比一个脆 ——
  // 页面上的报告框挂在官网 DOM 上（导航一次就没）、面板按钮要先重新打包、
  // 开发者工具在 uTools 的窗口上不一定打得开。写文件这条路不需要任何界面操作：
  // 照着复现一次，事后直接看文件。
  const trace = state.load('js/trace.js')
  check(trace.logPath() === path.join('C:\\fake-temp', 'deepseek-hovering-net.log'),
    '排查日志落在 uTools 给的临时目录里（路径确定，事后好找）', trace.logPath())

  state.fsWrites.length = 0
  trace.append('请求失败: POST /api/v0/users/login → 失败（连接层面没成）')
  check(state.fsWrites.length === 1 && state.fsWrites[0].op === 'append',
    'trace.append 是追加写，不是覆盖写')
  check(/^\[\d\d:\d\d:\d\d\.\d\d\d\] 请求失败: POST/.test(state.fsWrites[0].text),
    '每行都带时间戳（好几件事挤在一起时，先后顺序是唯一的分辨依据）',
    JSON.stringify(state.fsWrites[0].text))

  // 超限就从头上重来：排查要的是"刚刚那一次"，无上限地长下去反而是隐患
  state.logSize = trace.MAX_BYTES + 1
  state.fsWrites.length = 0
  trace.append('又一条')
  check(state.fsWrites.length === 2 && state.fsWrites[0].op === 'write' &&
    state.fsWrites[1].op === 'append',
    '日志超过上限时先截断再写（不是无限增长）')
  state.logSize = 0

  // 从页面报上来的失败请求，要一字不差地落到文件里 —— 这是整条排查链的终点
  state.fsWrites.length = 0
  fireIpc(state, 'chat:netfail', {
    method: 'POST', url: 'https://chat.deepseek.com/api/v0/users/login',
    result: '失败（连接层面没成）', status: 0, error: 'net::ERR_FAILED',
  })
  const netWrite = state.fsWrites.map((w) => w.text).join('')
  check(netWrite.indexOf('POST https://chat.deepseek.com/api/v0/users/login') !== -1 &&
    netWrite.indexOf('失败（连接层面没成）') !== -1 && netWrite.indexOf('net::ERR_FAILED') !== -1,
    '对话窗报上来的失败请求会落到日志里（登录失败时唯一说得清的一句话）', netWrite)

  state.fsWrites.length = 0
  fireIpc(state, 'chat:url', 'https://chat.deepseek.com/a/chat/s/abc')
  check(state.fsWrites.map((w) => w.text).join('').indexOf('导航: https://chat.deepseek.com') !== -1,
    '地址变化也记一笔（登录那一下要是换过文档，这行能证实）')

  state.fsWrites.length = 0
  fireIpc(state, 'chat:trace', '页面侧放行: ok / 已放行')
  check(state.fsWrites.map((w) => w.text).join('').indexOf('页面侧放行: ok') !== -1,
    '页面侧自己的事件也能落进同一份日志（两级放行各自的结果）')

  // 磁盘不让写的时候，记日志失败不能变成功能失败 —— 这个模块跑在插件的正常路径上
  state.fsThrow = true
  let threw = false
  try {
    trace.append('磁盘满了')
  } catch (e) {
    threw = true
  }
  state.fsThrow = false
  check(!threw, '写日志失败不会往外抛（记日志不该变成新的故障源）')

  // 「复制排查日志」：这一段里有浏览器自己说的错误码，是唯一能点名"谁掐掉了请求"的东西，
  // 所以它得真能把文件尾巴读出来、真写进剪贴板。
  state.logText = '[10:00:01] 控制台观察: net::ERR_FAILED\n[10:00:02] 请求失败: GET /x → 失败\n'
  state.clipboard.length = 0
  const logMsg = host.copyTraceLog()
  check(state.clipboard.length === 1 && state.clipboard[0].indexOf('net::ERR_FAILED') !== -1,
    '「复制排查日志」把日志内容写进剪贴板')
  check(logMsg.indexOf('字节') !== -1 && logMsg.indexOf('deepseek-hovering-net.log') !== -1,
    '复制完回一句可读的结果（含字节数和文件路径）', logMsg)
  // 日志读不出来时返回人话，不抛 —— 和"写日志失败不往外抛"一个道理。
  // （trace.read 自己把错误兜成一段说明，所以"人话"是在剪贴板里，而不是返回值里。）
  state.logReadThrow = true
  let logThrew = false
  try { host.copyTraceLog() } catch (e) { logThrew = true }
  state.logReadThrow = false
  check(!logThrew && state.clipboard[state.clipboard.length - 1].indexOf('读日志失败') !== -1 &&
    state.clipboard[state.clipboard.length - 1].indexOf('deepseek-hovering-net.log') !== -1,
    '日志读不出来时给一句人话（含路径），不抛出去')

  // 读尾巴要从整行开头开始：半行日志比没有更误导人。
  state.logText = 'A'.repeat(100) + '\nfirst-line\nsecond-line\n'
  const tailed = trace.read(20)
  check(tailed.indexOf('只取最后 20 字节') !== -1 && tailed.indexOf('second-line') !== -1 &&
    tailed.indexOf('first-line') === -1,
    '日志超长时只取尾巴，且从整行开头开始', tailed)

  fireIpc(state, 'chat:url', 'https://chat.deepseek.com/')
  check(state.db.has('deepseek:lastChatUrl') === false, '回到对话首页会把记住的会话清掉')
  check(chatUrlWin.chatTargetUrl() === 'https://chat.deepseek.com/',
    '没有会话时目标退回官网首页', chatUrlWin.chatTargetUrl())

  // --- 排查用的两个入口：开对话窗的 DevTools、把"失败的请求"捞出来复制 ---
  // 为什么要有它们：报告框挂在官网的 DOM 上，登录那一步要是触发一次导航，框就跟着
  // 文档一起没了（实测撞见过 —— 用户回头想复制，左上角那条横条已经不在了）。
  // 这两条路都由父窗发起，不依赖页面上还在不在。
  const devToolsMsg = host.openChatDevTools()
  check(sriWin.webContents.devToolsMode && sriWin.webContents.devToolsMode.mode === 'detach',
    '面板能开对话窗的开发者工具，而且是拆成独立窗口（对话窗只有 460 宽，停靠进去页面没法看）',
    JSON.stringify(sriWin.webContents.devToolsMode))
  check(typeof devToolsMsg === 'string' && devToolsMsg.indexOf('Network') !== -1,
    '开完 DevTools 会告诉用户该看哪儿', devToolsMsg)

  const diagText = await host.copyChatDiagnostics()
  // 从这之后看「刚写进去的那一条」而不是"只有一条" —— 后面还有一颗按钮也往剪贴板写。
  const clip = () => state.clipboard[state.clipboard.length - 1]
  check(state.clipboard.length > 0 && clip() === diagText,
    '「复制失败请求记录」把取回来的那段文本写进了剪贴板')
  check(diagText === sriWin.webContents.netText,
    '复制的内容就是页面报上来的那段（父窗不去猜、不去拼）', diagText)
  check(sriWin.webContents.jsCalls.some((code) => String(code).indexOf('netReport') !== -1),
    '父窗是问页面要的 netReport，不经过页面上的报告框（那个会随导航消失）')

  // 页面侧没挂上入口（改版、preload 没跑）时要返回一句人话，不能抛
  sriWin.webContents.netText = '这个页面上没有记录入口（preload 没跑起来，或者官网改版了）'
  const noHelper = await host.copyChatDiagnostics()
  check(noHelper.indexOf('没有记录入口') !== -1,
    '页面上没有记录入口时，复制回来的是一句能看懂的话', noHelper)
  sriWin.webContents.netText = '对话窗：https://chat.deepseek.com/\n── 这个窗口里失败的请求（记了 0 条，其中失败 0 条）'

  // --- 网络层观察：页面里看得见"谁失败了"，看不见"是谁拦的" ---
  // Electron 自己的错误码（net::ERR_BLOCKED_BY_CLIENT 这种）往往直接把拦人的那一层点出来。
  const hooked = state.created.filter((w) => w.webContents.session.webRequest.handlers.error)
  check(hooked.length === 1,
    '网络层观察只挂一次（session 是所有窗口共用的，挂两次每条请求就会被记两遍）',
    String(hooked.length))
  const wreq = hooked[0].webContents.session.webRequest
  check(!!wreq.handlers.completed, 'HTTP >= 400 那条也挂上了')
  const netFilter = (wreq.filters[0] && wreq.filters[0].urls) || []
  check(netFilter.length === 2 && netFilter[0] === '*://chat.deepseek.com/*',
    '过滤器把范围收在官网域名上（这个口子过的是整个 uTools 的请求流）',
    JSON.stringify(netFilter))

  const writesBefore = state.fsWrites.length
  wreq.handlers.completed({
    method: 'POST', url: 'https://chat.deepseek.com/api/v0/users/login',
    statusCode: 200, resourceType: 'xhr',
  })
  check(state.fsWrites.length === writesBefore,
    '200 的一条都不记（一次页面加载几十条，记了就把有用的淹了）',
    String(state.fsWrites.length - writesBefore))

  wreq.handlers.error({
    method: 'GET', url: 'https://fe-static.deepseek.com/chat/static/main.js',
    error: 'net::ERR_BLOCKED_BY_CLIENT', resourceType: 'script',
  })
  const netErrWrite = state.fsWrites[state.fsWrites.length - 1].text
  check(state.fsWrites.length === writesBefore + 1 &&
    netErrWrite.indexOf('net::ERR_BLOCKED_BY_CLIENT') !== -1 && netErrWrite.indexOf('（script）') !== -1,
    '出错那条记下了 Electron 自己的错误码和资源类型 —— 那个名字指的就是拦人的那一层',
    JSON.stringify(netErrWrite))

  wreq.handlers.completed({
    method: 'POST', url: 'https://chat.deepseek.com/api/v0/users/login',
    statusCode: 422, resourceType: 'xhr',
  })
  check(state.fsWrites.length === writesBefore + 2 &&
    state.fsWrites[state.fsWrites.length - 1].text.indexOf('HTTP 422') !== -1,
    'HTTP >= 400 的会记一条，和页面侧那份相互印证',
    state.fsWrites[state.fsWrites.length - 1].text)

  // --- 第二条路：CDP（session.webRequest 拿不到时的那条）---
  // 它比 webRequest 多给一个 blockedReason（csp / mixed-content / inspector…），
  // 那个字段直接说出"是谁拦的"。代价写在明处：**和开发者工具互斥**。
  const windowsMod = state.load('js/windows.js')
  const cdpWc = state.created[0].webContents

  let mark = state.fsWrites.length
  state.devToolsOpen = true
  check(windowsMod.watchViaDebugger(cdpWc) === false,
    'CDP 挂不上时返回 false（不假装成功）')
  check(state.fsWrites.slice(mark).some((w) => w.text.indexOf('CDP 也没挂上') !== -1 &&
    w.text.indexOf('开发者工具') !== -1),
    'CDP 挂不上时日志里留下原因 —— 尤其"开发者工具开着挂不上"这条，不然会一头雾水',
    JSON.stringify(state.fsWrites.slice(mark).map((w) => w.text)))
  state.devToolsOpen = false

  mark = state.fsWrites.length
  check(windowsMod.watchViaDebugger(cdpWc) === true, 'CDP 这条路能挂上')
  check(cdpWc.debugger.version === '1.3' && cdpWc.debugger.commands.indexOf('Network.enable') !== -1,
    'CDP 挂的是 1.3，并且开了 Network 域', JSON.stringify(cdpWc.debugger.commands))

  cdpWc.debugger.emit('Network.requestWillBeSent', {
    requestId: 'r1', request: { url: 'https://chat.deepseek.com/static/fp.min.js' },
  })
  cdpWc.debugger.emit('Network.loadingFailed', {
    requestId: 'r1', type: 'Script', errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'csp',
  })
  cdpWc.debugger.emit('Network.responseReceived', {
    type: 'XHR', response: { url: 'https://chat.deepseek.com/api/v0/users/login', status: 422 },
  })
  cdpWc.debugger.emit('Network.responseReceived', {
    type: 'XHR', response: { url: 'https://chat.deepseek.com/api/v0/chat/completion', status: 200 },
  })
  const cdpLog = state.fsWrites.slice(mark).map((w) => w.text).join('')
  check(cdpLog.indexOf('/static/fp.min.js') !== -1 &&
    cdpLog.indexOf('net::ERR_BLOCKED_BY_CLIENT') !== -1 &&
    cdpLog.indexOf('blockedReason=csp') !== -1,
    'CDP 记下了地址、错误码和 blockedReason —— blockedReason 直接说出"是谁拦的"', cdpLog)
  check(cdpLog.indexOf('HTTP 422') !== -1 && cdpLog.indexOf('HTTP 200') === -1,
    'CDP 那条也只记 >= 400 的', cdpLog)

  // --- 第三条路：页面控制台（webContents 的 console-message）---
  // 这一条求的是**唯一一句能直接说清楚的话**：浏览器在资源加载失败时自己往控制台写的
  // "Failed to load resource: net::ERR_BLOCKED_BY_CLIENT"。它不经过页面里的 console 对象，
  // 页面侧包 console.error 收不到 —— 只有从 webContents 这侧听得见。
  mark = state.fsWrites.length
  windowsMod.watchChatConsole(cdpWc)
  check(state.fsWrites.slice(mark).some((w) => w.text.indexOf('控制台观察已挂上') !== -1),
    '控制台这条路挂上了会留一行（不然"没效果"和"没挂上"分不清）',
    JSON.stringify(state.fsWrites.slice(mark).map((w) => w.text)))
  check((cdpWc.onHandlers['console-message'] || []).length === 1,
    '监听挂在 console-message 上，而且只挂一次',
    String((cdpWc.onHandlers['console-message'] || []).length))

  mark = state.fsWrites.length
  cdpWc.emitConsole('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT')
  const consoleWrite = state.fsWrites[state.fsWrites.length - 1].text
  check(state.fsWrites.length === mark + 1 &&
    consoleWrite.indexOf('net::ERR_BLOCKED_BY_CLIENT') !== -1,
    '浏览器自己那句错误码进了日志 —— 那句话就是"是谁拦的"的证据',
    JSON.stringify(consoleWrite))

  mark = state.fsWrites.length
  cdpWc.emitConsole('数美设备识别 script 加载成功', 'info')
  check(state.fsWrites.length === mark,
    '官网自己的日常日志不记（不然排查日志会被淹掉）',
    JSON.stringify(state.fsWrites.slice(mark).map((w) => w.text)))

  // 老版 Electron 的形状：(event, level, message, line, sourceId)。两种都得认，
  // 否则换个 Electron 版本这条路就静默地瞎了。
  mark = state.fsWrites.length
  ;(cdpWc.onHandlers['console-message'] || []).forEach((cb) => {
    cb({}, 3, 'Failed to load resource: net::ERR_FAILED', 12, 'https://chat.deepseek.com/')
  })
  check(state.fsWrites.length === mark + 1 &&
    state.fsWrites[state.fsWrites.length - 1].text.indexOf('net::ERR_FAILED') !== -1,
    '老版的 (event, level, message, line, sourceId) 形状也认',
    JSON.stringify(state.fsWrites.slice(mark).map((w) => w.text)))

  // 挂不上（uTools 的窗口代理可能压根没给 on）时，必须留下原因
  mark = state.fsWrites.length
  windowsMod.watchChatConsole({ webContents: { executeJavaScript() {} } })
  check(state.fsWrites.slice(mark).some((w) => w.text.indexOf('控制台观察') !== -1 &&
    w.text.indexOf('这一层看不成') !== -1),
    '挂不上控制台时日志里留原因，不静默',
    JSON.stringify(state.fsWrites.slice(mark).map((w) => w.text)))

  // --- 对话窗大小设置 ---
  let sized = host.setChatSize(520, 1000)
  check(sized.chatSize.width === 520 && sized.chatSize.height === 1000,
    '设置面板能改对话窗尺寸', JSON.stringify(sized.chatSize))
  check(JSON.parse(state.db.get('deepseek:chatSize')).width === 520, '尺寸落库')

  sized = host.setChatSize(99999, 99999)
  check(sized.chatSize.width === 1600 && sized.chatSize.height === 1080,
    '离谱的大尺寸被夹到上限与屏幕可用区域内', JSON.stringify(sized.chatSize))

  sized = host.setChatSize(10, 10)
  check(sized.chatSize.width === 320 && sized.chatSize.height === 400,
    '过小的尺寸被夹到下限', JSON.stringify(sized.chatSize))

  sized = host.resetChatSize()
  check(sized.chatSize.width === 460 && sized.chatSize.height === 900, '恢复默认回到手机尺寸')
  check(state.db.has('deepseek:chatSize') === false, '恢复默认会清掉存储')

  // 存过的尺寸必须真的用在下一次开窗上
  host.setChatSize(400, 700)
  host.closeChat()
  const beforeSized = state.created.length
  host.openChat()
  await flush()
  check(state.created.length === beforeSized + 1, '关掉之后能重新开窗')
  const sizedWin = state.created[state.created.length - 1]
  check(sizedWin.options.width === 400 && sizedWin.options.height === 700,
    '保存过的尺寸用在了新开的窗口上',
    sizedWin.options.width + '×' + sizedWin.options.height)

  // --- 拖拽 ---
  fireIpc(state, 'ball:dragStart')
  const origin = ball.getBounds()
  fireIpc(state, 'ball:drag', { dx: 12, dy: -20 })
  check(ball.bounds.x === origin.x + 12 && ball.bounds.y === origin.y - 20,
    '拖拽把球移动到了新位置', JSON.stringify(ball.bounds))
  fireIpc(state, 'ball:drag', { dx: 99999, dy: 99999 })
  check(ball.bounds.x === 1920 - 60 && ball.bounds.y === 1080 - 60, '拖出屏幕会被夹在可用区域内',
    JSON.stringify(ball.bounds))
  fireIpc(state, 'ball:dragEnd')
  const saved = state.db.get('deepseek:ballPos')
  check(typeof saved === 'string' && JSON.parse(saved).x === ball.bounds.x, '拖拽结束后位置落库', String(saved))

  // --- 右键菜单 ---
  const ballBeforeMenu = ball.getBounds()
  fireIpc(state, 'ball:requestMenu')
  const menuPayload = ball.lastSent('ball:menu')
  check(!!menuPayload, '右键后父窗下发了菜单数据')
  if (menuPayload) {
    check(Array.isArray(menuPayload.items) && menuPayload.items.length > 0,
      '菜单有 ' + (menuPayload.items ? menuPayload.items.length : 0) + ' 项')
    const g = menuPayload.geom
    check(!!g && g.menu.width > 0 && g.menu.height > 0, '菜单有明确的尺寸')
    check(ball.bounds.width >= 60 && ball.bounds.height >= 60, '窗口被撑大以容纳菜单',
      JSON.stringify(ball.bounds))
    check(g.menu.x >= 0 && g.menu.y >= 0 &&
      g.menu.x + g.menu.width <= ball.bounds.width &&
      g.menu.y + g.menu.height <= ball.bounds.height,
      '菜单落在撑开后的窗口内', JSON.stringify(g.menu))
    check(g.ball.x >= 0 && g.ball.y >= 0 &&
      g.ball.x + 60 <= ball.bounds.width && g.ball.y + 60 <= ball.bounds.height,
      '球落在撑开后的窗口内', JSON.stringify(g.ball))
  }
  fireIpc(state, 'ball:menuClose')
  check(ball.bounds.width === 60 && ball.bounds.height === 60 &&
    ball.bounds.x === ballBeforeMenu.x && ball.bounds.y === ballBeforeMenu.y,
    '菜单关闭后窗口缩回原位', JSON.stringify(ball.bounds))
  check(ball.resizable === false, '撑开/缩回的临时改尺寸没有把 resizable 漏成 true')

  // --- 菜单项 ---
  state.external.length = 0
  fireIpc(state, 'ball:menuPick', 'browser')
  check(state.external.indexOf('https://chat.deepseek.com/') !== -1, '菜单里的"在浏览器中打开"生效')

  // --- 面板动作 ---
  const snapshot = host.state()
  check(snapshot.site === 'https://chat.deepseek.com/', 'state() 带出官网地址')
  check(snapshot.ballVisible === true && snapshot.ballRunning === true, 'state() 反映悬浮球状态')
  check(snapshot.chatOpen === true, 'state() 反映对话窗状态')
  check(!!snapshot.chatSize && !!snapshot.chatSizeDefault,
    'state() 带出对话窗尺寸与默认值，面板不用自己硬编码')

  host.hideBall()
  check(ball.destroyed === true, '隐藏悬浮球会销毁球窗')
  check(ball.isDestroyed() && host.state().ballVisible === false, '隐藏后状态同步为"不显示"')

  const beforeShow = state.created.length
  host.showBall()
  await flush()
  check(state.created.length === beforeShow + 1, '重新显示会重开球窗')
  const rebuilt = state.created[state.created.length - 1]
  check(rebuilt.visible === true && rebuilt.bounds.width === 60, '重开的球窗正常显示')
  check(rebuilt.resizable === false, '重开的球窗仍然不可缩放')

  host.resetBallPos()
  check(rebuilt.bounds.x === 1920 - 60 - 32 && rebuilt.bounds.y === 1080 - 60 - 64,
    '重置位置回到主屏右下角', JSON.stringify(rebuilt.bounds))

  host.setOpenIn('browser')
  check(host.state().openIn === 'browser', '切换打开方式被记住')
  state.external.length = 0
  fireIpc(state, 'ball:click')
  await flush()
  check(state.external.length === 1, '切到浏览器打开后，点球走 shellOpenExternal')
  host.setOpenIn('window')
  host.setOpenIn('莫名其妙的值')
  check(host.state().openIn === 'window', '非法打开方式会被纠正回独立窗口')

  // --- 全局快捷键 ---
  //
  // 语义和点悬浮球刻意不一样：点球是"开着就关"，快捷键是"把窗口叫到跟前"。
  // 三种状态都得走一遍，不然很容易退化成又一个纯开关。
  const HOTKEY_ENTER = { code: 'deepseek-window', from: 'hotkey', type: 'text' }

  // 1) 窗口开着且就在眼前 → 关掉（用户看着它，再按一下就是要收起来）
  check(host.state().chatOpen === true, '（前置）此刻对话窗是开着的')
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(sizedWin.destroyed === true, '快捷键：窗口就在眼前时按一下是关掉')
  check(host.state().chatOpen === false, '快捷键关窗后 state() 跟着变')

  // 2) 窗口没开 → 开出来，并且直接在最前面
  const beforeHot = state.created.length
  const hiddenBeforeOpen = state.mainWindowHidden
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(state.created.length === beforeHot + 1, '快捷键：窗口没开时按一下会开窗')
  const hotWin = state.created[state.created.length - 1]
  check(hotWin.visible === true && hotWin.focused === true, '快捷键开出来的窗口直接在最前面')
  check(state.mainWindowHidden > hiddenBeforeOpen, '要开窗时顺手收起 uTools 搜索框')
  check(rebuilt.destroyed === false, '（前置）悬浮球不受快捷键影响')

  // 3) 开着但被别的窗口盖住 → 只调到最前面，**不能关**（这就是和点球的关键区别）
  hotWin.blur()
  let hiddenBefore = state.mainWindowHidden
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(hotWin.destroyed === false, '快捷键：窗口被盖住时不会把它关掉')
  check(hotWin.visible === true && hotWin.focused === true, '快捷键把被盖住的窗口调到最前')
  check(state.mainWindowHidden > hiddenBefore, '调到前台时也顺手收起搜索框')

  // 4) 最小化 = "开着但不在眼前"，同样该还原而不是关掉
  hotWin.minimize()
  check(hotWin.isMinimized() === true, '（前置）窗口已最小化')
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(hotWin.destroyed === false && hotWin.isMinimized() === false,
    '快捷键：最小化的窗口被还原，而不是当成"开着"关掉')

  // 5) 已经在最前面了 → 这一下才是关
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(hotWin.destroyed === true, '快捷键：窗口回到眼前后再按一下才关掉')
  check(host.state().chatOpen === false, '（后置）快捷键把窗口关上了')

  // 6) 关窗那一下不该收搜索框 —— 用户可能正站在面板上，收走像"点了没反应"
  hiddenBefore = state.mainWindowHidden
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  const reopened = state.created[state.created.length - 1]
  check(reopened.visible === true, '（前置）又开了一个窗口')
  state.listeners.enter(HOTKEY_ENTER)   // 这次窗口在最前面 → 关
  await flush()
  check(reopened.destroyed === true && state.mainWindowHidden === hiddenBefore + 1,
    '收 uTools 搜索框只发生在"开窗"那一下，关窗时不收',
    'hideMainWindow 次数 ' + (state.mainWindowHidden - hiddenBefore))

  // 7) isFocused 在 uTools 各版本上不保证存在。没有它时降级为"只调到前台、永不关窗"：
  //    宁可白按一下，也不能把用户正想看的窗口关掉。
  state.listeners.enter(HOTKEY_ENTER)   // 上一步刚关掉，先开一个出来
  await flush()
  const hot2 = state.created[state.created.length - 1]
  delete hot2.isFocused
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(hot2.destroyed === false, 'isFocused 缺失时快捷键不会误关窗口')
  state.listeners.enter(HOTKEY_ENTER)
  await flush()
  check(hot2.destroyed === false, 'isFocused 缺失时连按也不会关掉窗口（降级方向是安全的）')
  check(hot2.focused === true, 'isFocused 缺失时仍然把窗口调到最前')

  // 8) 点悬浮球那条路仍然按 isVisible 判，不受 isFocused 缺失影响
  check(host.toggleChat().chatOpen === false, 'isFocused 缺失不影响点球的开关')

  // 9) 面板上读得出"用户配的是哪个键"，而且点「设置」跳的是同一条指令
  state.hotkeys['DeepSeek窗口'] = 'Ctrl+Shift+D'
  check(host.state().hotkey === 'Ctrl+Shift+D', 'state() 带出 uTools 里配好的快捷键',
    String(host.state().hotkey))
  check(host.state().hotkeyCmd === 'DeepSeek窗口', 'state() 带出要绑定的指令名')
  host.openHotkeySetting()
  check(state.hotkeySettingFor === 'DeepSeek窗口',
    '面板点「设置」会跳到 uTools 快捷键设置页，且指令名和 plugin.json 一致',
    String(state.hotkeySettingFor))
  state.hotkeys = {}
  check(host.state().hotkey === null, '没配快捷键时 state().hotkey 是 null（面板显示"未设置"）')

  // 10) 给后面"退出后台"那一步留一个开着的对话窗
  const beforeLive = state.created.length
  host.openChat()
  await flush()
  const liveWin = state.created[state.created.length - 1]
  check(state.created.length === beforeLive + 1 && liveWin.visible === true,
    '（前置）退出后台前开着的对话窗')

  // --- 退出后台：不能顺手清理窗口 ---
  // 这一条要盯的是"当前活着的窗口"。上面的快捷键场景故意把 sizedWin 等窗口关掉了
  // （那正是它的考点），所以这里必须指向此刻还开着的球窗和对话窗。
  state.listeners.out(false)
  check(rebuilt.destroyed === false && liveWin.destroyed === false,
    'onPluginOut(false) 不销毁任何窗口（悬浮球靠这个活着）')
}

// ---------------------------------------------------------------- 2.9 Node 侧取回并注入

/**
 * 兜底修复那条路的自检。
 *
 * 它干的事是"取代浏览器去发那个请求"，所以最要紧的两条性质是：
 *   1. **验在前、注入在后** —— 任何一只脚本的哈希和官网 HTML 里写的对不上，就一个字符都不注入
 *      （这是这段代码全部的安全性所在：校验没被跳过，只是从浏览器验换成我们验完再交出去）；
 *   2. **顺序** —— 先还原 body（官网那张错误图把 #root 一起删了），再按 HTML 里的先后灌脚本
 *      （default-vendors 里有 main 依赖的运行时），最后回读 #root 看界面到底起来没有。
 *
 * 真正的"取"和"灌"是注入进来的（见 js/windows.js 的 repairChat），所以这里能用假件
 * 把它跑几遍；真去取官网字节会让自检依赖网络，那不是自检该干的事。
 */
async function checkRepair() {
  console.log('Node 侧修复兜底（假件跑流水线）')
  const file = path.join(PLUGIN, 'js', 'repair.js')
  if (!check(fs.existsSync(file), '存在 js/repair.js（页面侧发不出请求时的兜底）')) return
  const src = fs.readFileSync(file, 'utf8')
  const repair = require(file)

  // --- 静态：几处一松就出事的地方 ---
  check(repair.BROWSER_UA.indexOf('Chrome/') !== -1 && repair.BROWSER_UA.indexOf('Electron') === -1,
    '取脚本时带的是浏览器 UA（那台 CDN 会按 UA 挑响应）')
  check(repair.integrityHash('sha256-abc') === null,
    '只认 sha384 的 integrity，别的算法不去猜')
  check(repair.integrityHash('sha384-abc=') === 'abc=',
    '正常的 integrity 能解出哈希值')
  const verifyAt = src.indexOf('if (!verify(buf, item.integrity))')
  const injectAt = src.indexOf('await options.executeJavaScript(item.source)')
  check(verifyAt !== -1 && injectAt !== -1 && verifyAt < injectAt,
    '校验在注入之前（顺序反了就等于把没验过的代码放进去跑）')
  check(src.indexOf("parsed.protocol !== 'https:'") !== -1,
    '只走 https（脚本清单是从页面上拿的，不能跟着它去别的地方取东西）')
  check(src.indexOf('Restore') === -1 && src.indexOf('eval(') === -1,
    '注入走的是调用方给的 executeJavaScript，不在这个模块里自己拼字符串执行')

  // --- 行为：拿假件把整条流水线跑几遍 ---
  const sha = (text) => 'sha384-' + repair.sha384Base64(Buffer.from(text, 'utf8'))
  const VENDORS = 'window.__vendors = 1'
  const MAIN = 'window.__main = 1'
  const CSS = 'body{margin:0}'
  const sheet = { href: 'https://fe-static.deepseek.com/chat/static/main.1d00a4d01e.css' }
  const scripts = [
    { src: 'https://fe-static.deepseek.com/chat/static/default-vendors.df13be609e.js', integrity: sha(VENDORS) },
    { src: 'https://fe-static.deepseek.com/chat/static/main.19cce7bd22.js', integrity: sha(MAIN) },
  ]

  async function pipeline(opts) {
    const calls = []
    const styles = []
    const result = await repair.run({
      scripts: opts.scripts || scripts,
      styles: opts.styles,
      fetchScript(url) {
        if (opts.fetchFails) return Promise.reject(new Error('连接被重置'))
        if (opts.styleFails && url.indexOf('.css') !== -1) return Promise.reject(new Error('HTTP 404'))
        if (url.indexOf('.css') !== -1) return Promise.resolve(Buffer.from(CSS, 'utf8'))
        const body = url.indexOf('vendors') !== -1 ? VENDORS : MAIN
        return Promise.resolve(Buffer.from(opts.corrupt ? body + '/*被塞了东西*/' : body, 'utf8'))
      },
      // insertCSS 有和没有各跑一遍（uTools 的窗口代理给不给这些方法一向没保证）
      insertCSS: opts.noInsertCSS ? null : (css) => { styles.push(css); return Promise.resolve('key') },
      executeJavaScript(code) {
        calls.push(code)
        if (String(code).indexOf('#root') !== -1) return Promise.resolve(opts.root === undefined ? 3 : opts.root)
        return Promise.resolve(undefined)
      },
    })
    return { result, calls, styles }
  }

  const happy = await pipeline({ styles: [sheet] })
  check(happy.result.ok === true && happy.result.reason === 'ok',
    '两条都验过时注入成功，并回读 #root 确认界面起来了', JSON.stringify(happy.result))
  check(happy.calls.length === 4 && happy.calls[0].indexOf('restoreBody') !== -1 &&
    happy.calls[1] === VENDORS && happy.calls[2] === MAIN &&
    happy.calls[3].indexOf('#root') !== -1,
    '顺序对：先还原 body → vendors → main → 回读 #root',
    JSON.stringify(happy.calls.map((c) => String(c).slice(0, 24))))
  check(happy.styles.length === 1 && happy.styles[0] === CSS,
    '样式在脚本之前灌进去（不然界面先裸奔一下再变好看）')

  // 没有 insertCSS 时必须退到页内插 <style>，而且这条退路也得能灌进真实内容
  const noInsert = await pipeline({ styles: [sheet], noInsertCSS: true })
  check(noInsert.result.ok === true &&
    noInsert.calls.some((c) => c.indexOf('createElement("style")') !== -1 && c.indexOf('body{margin:0}') !== -1),
    '拿不到 insertCSS 时退到页内 <style>，CSS 内容照样灌得进去')

  // 样式地址的可信度没法用哈希验（官网那只 <link> 上没写 integrity），所以只认 deepseek.com
  const foreign = await pipeline({ styles: [{ href: 'https://evil.example.com/x.css' }] })
  check(foreign.result.ok === false && foreign.result.reason === 'style' &&
    foreign.styles.length === 0 && foreign.calls.length === 0,
    '不在 deepseek.com 下的样式一概不注入（没有哈希可验，只能守住来源）',
    JSON.stringify(foreign.result))

  const styleDead = await pipeline({ styles: [sheet], styleFails: true })
  check(styleDead.result.ok === false && styleDead.result.reason === 'style' && styleDead.calls.length === 0,
    '样式取不到就整体收手（宁可一样都不做，也不给一个"没样式的官网"）',
    JSON.stringify(styleDead.result))

  const corrupt = await pipeline({ corrupt: true })
  check(corrupt.result.ok === false && corrupt.result.reason === 'integrity',
    '第二只的哈希对不上时放弃', JSON.stringify(corrupt.result))
  check(corrupt.calls.length === 0,
    '有一只没验过就一个字符都不注入（先全验完，再开始灌）',
    JSON.stringify(corrupt.calls.map((c) => String(c).slice(0, 24))))

  const dead = await pipeline({ fetchFails: true })
  check(dead.result.ok === false && dead.result.reason === 'fetch' && dead.calls.length === 0,
    '取不回来就收手，且留下原因（不是默默什么都不做）', JSON.stringify(dead.result))

  const empty = await pipeline({ root: 0 })
  check(empty.result.ok === false && empty.result.reason === 'empty' && empty.result.rootChildren === 0,
    '脚本灌进去了但界面没起来，照样算失败（别把"没报错"当成功）', JSON.stringify(empty.result))

  const nothing = await repair.run({ scripts: [], fetchScript: () => Promise.reject(new Error('不该被调到')),
    executeJavaScript: () => Promise.reject(new Error('不该被调到')) })
  check(nothing.reason === 'noscripts', '清单为空时立刻收手')
}

async function checkRuntime() {
  console.log('运行链路（桩件模拟）')
  const modes = [
    { mode: 'async', label: '窗口加载完成后回调（真实时序）' },
    { mode: 'sync', label: '创建时同步回调（防御性覆盖）' },
  ]
  for (const item of modes) {
    console.log('  · ' + item.label)
    await runScenario(createHarness({ callbackMode: item.mode }))
  }
}

// ---------------------------------------------------------------- main

;(async function main() {
  console.log('检查插件目录: ' + rel(PLUGIN) + '\n')
  const manifest = checkManifest()
  console.log('')
  checkSources()
  console.log('')
  checkHotkeyWiring(manifest)
  console.log('')
  checkPanelContract()
  console.log('')
  await checkRepair()
  console.log('')
  await checkRuntime()

  console.log('\n' + (failures === 0
    ? '全部通过（' + checks + ' 项）'
    : failures + ' / ' + checks + ' 项未通过'))

  process.exit(failures === 0 ? 0 : 1)
})()

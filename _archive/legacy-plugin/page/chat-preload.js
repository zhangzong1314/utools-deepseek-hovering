// DeepSeek 悬浮助手 —— 对话窗的 preload
//
// 这个 preload 有个不常见的点：**它会跟着窗口跑到别人的网站上去执行**。
// 窗口先加载本地 page/chat.html，再由那页 location.replace 到官网；
// 每次导航 Chromium 都会重新跑一遍 preload，于是这段代码在官网页面上也会执行一次。
//
// 它一共干两件事：
//   1. 在本地落地页上：把"这次该打开哪个地址"（上次的会话 / 官网首页）告诉页面；
//   2. 在官网页面上：把当前地址回报给父窗，让父窗记住这是哪个会话。
//
// 两条硬约束：
//   - **不 require 任何东西。** 跑到官网那种普通网页上时，Node 环境未必还在，
//     一句 require('electron') 就可能让整个 preload 抛异常。这里只用 DOM 和 uTools 全局。
//   - **不能抛。** preload 抛异常会连累它所在的那个页面。全程 try/catch。

;(function () {
  'use strict'

  var SITE = 'https://chat.deepseek.com/'

  // 与 js/config.js 的 KEYS.lastChatUrl 是同一个键。preload 跑在渲染进程里，
  // 没法 require 主 preload 的模块，只能各写一份 —— tools/check.js 里有断言盯着这两处别走偏。
  var KEY_LAST_URL = 'deepseek:lastChatUrl'
  var CONVERSATION_PREFIX = 'https://chat.deepseek.com/a/chat/s/'

  // uTools 是否往这个窗口注入了 utools 全局。窗口跑到外站之后这一点没有文档保证，
  // 所以每处都先问一句 typeof，取不到就闭嘴降级（拿不到就只是"记不住会话"，功能仍然可用）。
  var hasUtools = false
  try {
    hasUtools = typeof utools !== 'undefined' && utools !== null
  } catch (e) {
    hasUtools = false
  }

  var warned = false

  function warnOnce() {
    if (warned) return
    warned = true
    console.warn('[chat] 这个页面上没有 utools 全局，无法上报地址（会话将不会被记住）。' +
      '若当前已登录并打开了某个会话，请把这条日志反馈一下。URL: ' + location.href)
  }

  function send(channel, payload) {
    if (!hasUtools) {
      warnOnce()
      return
    }
    try {
      utools.sendToParent(channel, payload)
    } catch (e) {
      console.error('[chat] 上报失败:', channel, e)
    }
  }

  // 页面若被谁施加了 CSP，被拦下来的东西会在这里留痕。本机实测官网的 HTML 上只有
  // frame-ancestors（拦不住脚本），留着是为了万一哪天 uTools 或某个环节开始往这个窗口
  // 注入资源级 CSP —— 那种情况下报告里能直接看到"是哪条指令拦的、拦的是谁"。
  var violations = []
  try {
    document.addEventListener('securitypolicyviolation', function (ev) {
      try {
        violations.push((ev && ev.violatedDirective || '?') + ' ← ' + (ev && ev.blockedURI || '?'))
      } catch (e) {}
    })
  } catch (e) {
    console.error('[chat] 注册 securitypolicyviolation 监听出错:', e)
  }

  // 同一个问题的第二只探针：浏览器的 Reporting API。它会主动上报两类"被拦下来了"的事，
  // 而且**说得比 error 事件清楚**：
  //   - integrity-violation ← 完整性校验没过（SRI）。这是"我算出来的哈希和你写的不一样"，
  //     只有在**真拿到字节**之后才可能出现 —— 反过来说，一次都没报，就说明压根不是 SRI 的问题；
  //   - csp-violation       ← 哪条 CSP 指令拦的、拦的是谁，report 里全写着。
  // 这两条都是"浏览器自己下的判断"，比我们从现象上猜可靠得多。buffered 让它在注册前
  // 已经发生的那些也补送过来（页面脚本跑之前的那几只脚本就属于这种）。
  var browserReports = []
  try {
    if (typeof ReportingObserver === 'function') {
      var ro = new ReportingObserver(function (list) {
        try {
          list.forEach(function (r) {
            var b = (r && r.body) || {}
            var what = b.blockedURL || b.documentURL || b.sourceFile || '?'
            var hash = b.computedHash ? '／实算 ' + String(b.computedHash).slice(0, 22) + '…' : ''
            browserReports.push((r && r.type || '?') + ': ' + what + hash)
          })
        } catch (e) {}
      }, { types: ['csp-violation', 'integrity-violation', 'intervention'], buffered: true })
      ro.observe()
    }
  } catch (e) {
    console.error('[chat] 注册 ReportingObserver 出错:', e)
  }

  // ---- 会话里的请求失败记录 ----
  //
  // 放行脚本只是第一步：界面起来了，真正的活儿（登录、拉会话列表、发消息）全走官网自己的
  // XHR / SSE。那些请求如果再被同一个东西挡掉，用户看到的就只有官网那句
  // "网络异常，请检查你的网络状况" —— 没地址、没状态码，什么也判断不了。
  //
  // 所以这里在页面**最早期**（preload 比页面脚本先跑）把 XHR 和 fetch 包一层，
  // **只观察不改写**：原函数照常调用、返回值原样返回、异常照旧抛出去。
  // 不加 WebSocket / EventSource —— 包构造函数的代价（instanceof、原型链）比这点收益大，
  // 而登录这一步走的必然是 XHR 或 fetch。
  var NET_LOG_MAX = 60
  // 记录落 sessionStorage（同源、同窗口，跨导航还在，窗口一关就没）。
  // 必须落盘的理由是实测出来的：放行成功、进了登录页，再点登录 —— 那一下要是触发了
  // 一次导航/刷新，页面里这份数组就跟着文档一起没了，报告框也没了，用户回头想复制
  // 什么都找不到（"无法左上角横条复制"就是这么来的）。存在同源 sessionStorage 里，
  // 新文档起来时能把这些记录读回来。
  var NET_LOG_KEY = 'deepseek:netLog'

  function loadNetLog() {
    try {
      var raw = sessionStorage.getItem(NET_LOG_KEY)
      var arr = raw ? JSON.parse(raw) : []
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : []
    } catch (e) {
      // 隐私设置、配额、被别的页面清过 —— 拿不到就从空的开始，不值得打断页面
      return []
    }
  }

  function saveNetLog() {
    try {
      sessionStorage.setItem(NET_LOG_KEY, JSON.stringify(netLog))
    } catch (e) {}
  }

  var netLog = loadNetLog()

  // ── 元素发起的请求（<script> / <link> / <img>）没加载成的记录 ────────────────
  //
  // 为什么单记这一类：实测这个窗口里**元素发起的请求会被拦掉**（HTML 里那两只脚本和
  // 那只样式表都是 0 字节、几毫秒就结束，而页面自己发的 fetch 拿到 200）。挡的不止
  // HTML 里写死的那几个 —— 官网的设备指纹脚本 /static/fp.min.js 是**运行时由 JS 插进来的**，
  // 它要是也挂在这一层上，登录请求里就会少 device_id（服务端回 422 body.device_id）。
  // 所以要认的是**这一整类**，而不是"HTML 里写了哪几个"。
  //
  // 只认得出"没加载成"（error 事件），不碰内容 —— 元素加载成功与否是浏览器自己说的。
  var EL_FAIL_MAX = 20
  var EL_FAIL_KEY = 'deepseek:elFails'
  var elFails = loadElFails()

  function loadElFails() {
    try {
      var raw = sessionStorage.getItem(EL_FAIL_KEY)
      var arr = raw ? JSON.parse(raw) : []
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : []
    } catch (e) { return [] }
  }

  function recordElFail(tag, url) {
    try {
      if (!url) return
      var short = shortUrl(url)
      // 同一条只记一次（官网的重试会把同一个地址再挂一遍）
      for (var i = 0; i < elFails.length; i++) if (elFails[i].tag === tag && elFails[i].url === short) return
      var entry = { tag: tag, url: short }
      if (tag === 'script') {
        // 数美那份设备指纹单独标一下：登录要用它的 deviceId，值得一眼看见
        try { if (url.indexOf('/static/fp.min.js') !== -1) entry.fp = true } catch (e) {}
      }
      if (elFails.length >= EL_FAIL_MAX) elFails.shift()
      elFails.push(entry)
      try { sessionStorage.setItem(EL_FAIL_KEY, JSON.stringify(elFails)) } catch (e) {}
      sendQuiet('chat:trace', '资源没加载成: ' + tag + ' ' + short +
        (entry.fp ? '（官网的设备指纹脚本 —— 登录要的 device_id 就是它给的）' : ''))
    } catch (e) {}
  }

  try {
    // capture 阶段才收得到资源错误（它们不冒泡，只在捕获阶段露面）
    window.addEventListener('error', function (ev) {
      try {
        var t = ev && ev.target
        if (!t || t === window || !t.tagName) return
        var tag = String(t.tagName).toLowerCase()
        if (tag !== 'script' && tag !== 'link' && tag !== 'img') return
        recordElFail(tag, t.src || t.href || '')
      } catch (e) {}
    }, true)
  } catch (e) {
    console.error('[chat] 挂资源错误监听失败:', e)
  }

  // ── 元素加载探针 ──────────────────────────────────────────────────────────
  //
  // 记录只说得清"没加载成"，说不出"为什么"。而"为什么"决定了还有没有路：
  //   - 若是"这个地址我们拿不到"（网络不通 / 服务端不收）→ 换谁来发都一样，到此为止；
  //   - 若是"元素这条路在你这个窗口里不通"（而 fetch 通）→ 就有路：取回来换个方式交给页面。
  // 所以拿**同一个地址**换几种发法各试一次（fetch / 元素 / data: / blob: / 非脚本元素），
  // 谁成谁不成，一眼分开。
  //
  // 只读、不修：不碰页面已有的东西，试完的元素都摘掉，结论只写进日志和 sessionStorage。
  // 唯一副作用是②和⑥会把官网页面上本来就该加载的那两只脚本再挂一次 —— 它们要是成了，
  // 反而是好事（数美那份指纹就此起来，登录缺的 device_id 就有了）。
  var PROBE_KEY = 'deepseek:probe'
  var probeRan = false

  function probeLoad() {
    try {
      var arr = JSON.parse(sessionStorage.getItem(PROBE_KEY) || '[]')
      return Object.prototype.toString.call(arr) === '[object Array]' ? arr : []
    } catch (e) { return [] }
  }

  function probeStore(text) {
    try {
      var arr = probeLoad()
      arr.push(text)
      while (arr.length > 20) arr.shift()
      sessionStorage.setItem(PROBE_KEY, JSON.stringify(arr))
    } catch (e) {}
  }

  /** 这一条结论同时进三个地方：日志文件、sessionStorage、当前这轮的数组 */
  function probeSay(out, line) {
    try { out.push(line) } catch (e) {}
    probeStore('   ' + line)
    sendQuiet('chat:trace', '探针: ' + line)
  }

  /** 拿 fetch 取一次（页面自己发的请求，不经过任何元素） */
  function probeFetch(out, label, url) {
    if (typeof fetch !== 'function') { probeSay(out, label + ' : 这个页面没有 fetch'); return }
    var t0 = Date.now()
    try {
      fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then(function (res) {
        return res.text().then(function (text) {
          probeSay(out, label + ' : HTTP ' + res.status + ' / ' + text.length + ' 字节 / ' +
            (res.headers.get('content-type') || '?') + ' / ' + (Date.now() - t0) + 'ms')
        })
      }).catch(function (e) {
        probeSay(out, label + ' : fetch 抛错 ' + ((e && e.name) || '') + ' ' + ((e && e.message) || e))
      })
    } catch (e) {
      probeSay(out, label + ' : fetch 调用就抛错 ' + ((e && e.message) || e))
    }
  }

  /**
   * 造一个元素、挂上地址、等 load/error。
   * 装进 head 而不是拿在手上不挂 —— 有些拦截只对"真的发出去过"的请求生效，不挂就测不到。
   * 打上 data-ds-probe 标记：下面那个"改走 blob"的放行器见到这个标记就绕开，
   * 否则探针测到的就是被它换过的那条路，量不出问题本身。
   */
  function probeElement(out, label, tag, url, timeoutMs) {
    var el = null
    var finished = false
    function finish(text) {
      if (finished) return
      finished = true
      try { if (el && el.parentNode) el.parentNode.removeChild(el) } catch (e) {}
      var extra = ''
      try {
        var list = performance.getEntriesByName(url)
        var last = list && list.length ? list[list.length - 1] : null
        if (last) extra = '（耗时 ' + Math.round(last.duration) + 'ms，HTTP ' + (last.responseStatus || 0) + '）'
      } catch (e) {}
      probeSay(out, label + ' : ' + text + extra)
    }
    try {
      el = document.createElement(tag)
      el.setAttribute('data-ds-probe', '1')
      if (tag === 'link') { el.rel = 'stylesheet'; el.href = url } else { el.src = url }
      el.onload = function () { finish('加载成功') }
      el.onerror = function () { finish('没加载成（error）') }
      ;(document.head || document.documentElement).appendChild(el)
      setTimeout(function () { finish('超时，没回话') }, timeoutMs || 1500)
    } catch (e) {
      finish('建元素就抛错：' + ((e && e.message) || e))
    }
  }

  function runProbe() {
    if (probeRan) return
    probeRan = true
    var out = []
    var same = location.origin + '/static/fp.min.js'
    var dataUrl = 'data:text/javascript;charset=utf-8,window.__dsProbeData=1'
    var blobUrl = ''
    try {
      blobUrl = URL.createObjectURL(new Blob(['window.__dsProbeBlob=1'], { type: 'text/javascript' }))
    } catch (e) {}
    // 跨域那只：优先用这次真的没加载成的那只官网脚本，它最能代表"出问题的那个"。
    // elFails 里存的是 shortUrl 的结果 —— 跨域那条形如 `host/path`（不带协议），
    // 同源那条以 `/` 开头，正好用来分辨。
    var cross = ''
    for (var i = elFails.length - 1; i >= 0; i--) {
      var u = String(elFails[i].url || '')
      if (elFails[i].tag === 'script' && u.charAt(0) !== '/') {
        cross = 'https://' + u.replace(/\?…$/, '')
        break
      }
    }

    probeStore('— ' + location.pathname + ' 上的探针（' + new Date().toISOString().slice(11, 19) + '）—')
    probeFetch(out, '① fetch 取同源真实地址', same)
    probeElement(out, '② <script src=同源真实地址>', 'script', same, 1500)
    probeElement(out, '③ <script src=data:…>', 'script', dataUrl, 1500)
    if (blobUrl) probeElement(out, '④ <script src=blob:…>', 'script', blobUrl, 1500)
    else probeSay(out, '④ <script src=blob:…> : 这个窗口造不出 blob 地址')
    probeElement(out, '⑤ <img src=官网图标（跨域、非脚本）>', 'img',
      'https://fe-static.deepseek.com/chat/favicon.svg', 1500)
    if (cross) probeElement(out, '⑥ <script src=跨域真实脚本>', 'script', cross, 1500)
    else probeSay(out, '⑥ <script src=跨域真实脚本> : 这次没有可用的跨域样本')
    // ⑦：跨域那条走"元素改道"能不能成，取决于**这个地址的 CDN 给不给 CORS**
    // （元素被挡是另一回事）。所以单独量一次跨域的 fetch —— 它成，跨域改道就成。
    // 放在最后，免得跟前面几只抢带宽把耗时读歪。
    if (cross) probeFetch(out, '⑦ fetch 取跨域脚本地址（成＝跨域改道可行）', cross)
    // ⑧：登录最后那步是 AWS WAF 的验证码控件，而这类控件通常渲染在**跨域 iframe** 里。
    // 子框架要是也被挡，控件内部的脚本我们根本够不着（preload 不进子框架）——
    // 那就不是"再改改就好"，得如实说。判据和脚本那条一样：看耗时，0–1ms 就是没发出去。
    // 这个地址是从官网自己的 bundle 里读出来的（AwsWafCaptcha 那一段），只当样本使。
    probeElement(out, '⑧ <iframe src=官网验证码地址>', 'iframe',
      'https://a0fea896111e.edge.sdk.awswaf.com/a0fea896111e/3a8b889b892b/challenge.js', 2000)
  }

  // ── 被挡住的元素换个走法加载（<script> / <link rel=stylesheet>）──────────────
  //
  // 探针在同一个文档里、对同一个地址量出来的六条：
  //   ① fetch 取同源真实地址 → HTTP 200 / 343703 字节 / application/javascript
  //   ② <script src=同源真实地址> → 没加载成（0ms，HTTP 0）
  //   ③ <script src=data:…> → 加载成功
  //   ④ <script src=blob:…> → 加载成功
  //   ⑤ <img src=跨域官网图标> → 加载成功（136ms）
  //   ⑥ <script src=跨域真实脚本> → 没加载成
  // 读法：网络是通的、服务端给得出来、元素这条路本身也没坏（③④⑤都成），
  // 挡的就只是"元素自己去取一个 http(s) 地址"这一类。
  //
  // 所以这里换掉的正是这一步，别的一律不动：
  //   自己 fetch 回文本 → 包成 blob → 用 blob: 地址挂上去。
  // 地址没换、源没换、字节没换 —— 取回来的就是浏览器本来会取的那一份。
  // 它也够不上"绕过服务端的拒绝"：服务端给的是 200（实测就是这么回的），
  // 是这扇窗户不让元素直接去拿而已。
  //
  // 同源、跨域都做，但跨域能不能成是**fetch 说了算**（CORS），所以先量过：
  // 数美的风控云 `castatic.fengkongcloud.cn/.../smcp.min.js` 回的是
  // `access-control-allow-origin: *`；回不了的（没这个头、或只回固定源）直接 fetch 抛错，
  // 那时按原样插回去 —— 退化成今天的样子，不会更差。
  //
  // 有一条**踩过的坑**记在这里：头一版只认"同源"，判据是 `new URL(el.src, location.href)`。
  // 而 `el.src` 是空字符串时（官网插的**内联** <script>，或者 src 还没写上的占位元素），
  // 它会解析成**当前页面地址** —— 于是同源判定为真，我们把一只内联脚本劫走了：
  // 报告里那两行 `元素换走 blob: /undefined / 8301 字节` 就是它（8301 字节正是 index.html 本身），
  // 而给 <script> 设 src 会让它原有的内联代码**作废**，那段代码就再也不会跑了。
  // 所以现在第一步就是看**原始属性**：src / href 没有、或者不像个地址，一概不碰。
  var SHIM_KEY = 'deepseek:shimLog'
  // 封顶分两层，因为要防的是**转圈**（换失败 → 官网重试 → 又换），不是"量大"：
  //   SHIM_MAX：一份文档换这么多只就到头（保险丝，正常页面到不了）
  //   SHIM_PER_URL：同一个地址最多试两回（真正掐掉转圈的那一层）
  // 为什么要分开：登录页那份报告里，一屏就有 **12** 只被挡的元素。
  // 头一版只按总数封顶 12 —— 那正好把后面的全放掉了，等于帮到一半就停手。
  var SHIM_MAX = 24
  var SHIM_PER_URL = 2
  var shimCount = 0
  var shimTried = {}
  var shimLog = loadShimLog()

  function loadShimLog() {
    try {
      var raw = sessionStorage.getItem(SHIM_KEY)
      var v = raw ? JSON.parse(raw) : null
      return v && v.length ? v : []
    } catch (e) { return [] }
  }

  function recordShim(text) {
    try {
      sendQuiet('chat:trace', text)
      shimLog.push(text)
      if (shimLog.length > 12) shimLog.shift()
      try { sessionStorage.setItem(SHIM_KEY, JSON.stringify(shimLog)) } catch (e) {}
    } catch (e) {}
  }

  /**
   * 这个地址算"同源"还是"跨域"，不能走这条路就返回空串。
   * 只认 https：页面自己是 https，http 的子资源本来就会被混合内容规则挡掉，
   * 换过去也是白搭；其它协议（data: / blob: / file:）更不该经我们的手。
   */
  function shimUrlKind(u) {
    try {
      var p = new URL(u, location.href)
      if (p.protocol !== 'https:') return ''
      return p.host === location.host ? 'same' : 'cross'
    } catch (e) { return '' }
  }

  /**
   * 元素写着的原始地址（属性值，不是解析后的）。空串/null/undefined 一律没有。
   * 只收"看着像个地址"的：`//host/x.js`、`https://host/x.js`、`/static/x.js`。
   * 这一步是上面那个坑的闸门 —— 官网插的内联 <script> 拿到的就是空串，
   * 而空串喂给 URL 会解析成"当前页面"，看起来完全合法。
   */
  function rawTarget(el, tag) {
    try {
      var raw = el.getAttribute(tag === 'LINK' ? 'href' : 'src')
      if (!raw) return ''
      if (raw.charAt(0) === '/' || /^https?:\/\//i.test(raw)) return raw
      return ''
    } catch (e) { return '' }
  }

  /**
   * 这只元素要不要换走法。
   *
   * 这个函数会被**每一次** appendChild / insertBefore 调到 —— 官网上是个 React 应用，
   * 一天要插成千上万个节点。所以判断顺序是"先拿最便宜的一票否决"：
   * tagName 一次属性读取就否掉绝大多数（文本节点连 tagName 都没有），
   * getAttribute 和 URL 解析只留给真可能是 <script>/<link> 的那几个。
   *
   * 探针自己造的那些带 data-ds-probe 标记，一律原样走 —— 否则探针量到的
   * 就是被这里换过的那条路，量不出问题本身。
   *
   * 带 integrity 的也不碰：那类元素要过 SRI，而 blob 里的字节未必能按原样对上
   * （BOM、非 UTF-8、换行这些都可能让哈希差一点），换过去只会把"校验没过"引出来。
   */
  function shimWants(el) {
    var tag = el && el.tagName
    // HTML 元素上 tagName 是大写。别的（文本节点、SVG）一律不动。
    if (tag !== 'SCRIPT' && tag !== 'LINK') return false
    try {
      if (el.getAttribute('data-ds-probe')) return false
      if (el.getAttribute('integrity')) return false
      var raw = rawTarget(el, tag)
      if (!raw) return false
      if (tag === 'LINK') {
        var rel = String(el.getAttribute('rel') || '').toLowerCase()
        return rel.indexOf('stylesheet') !== -1 && !!shimUrlKind(el.href)
      }
      return !!shimUrlKind(el.src)
    } catch (e) { return false }
  }

  /**
   * 要换的话用哪个地址 —— 解析后的绝对地址（同源跨域都算）。返回空串就是"这次不动它"。
   *
   * 顺手带上第二层封顶：同一个地址试过两回还不行就放手。要防的是**转圈**
   * （换失败 → 官网重试 → 又换），不是"量大"，所以门槛按地址算，不按总数算。
   */
  function shimUrlFor(node) {
    try {
      var url = node.tagName === 'LINK' ? node.href : node.src
      if (!url) return ''
      if ((shimTried[url] || 0) >= SHIM_PER_URL) return ''
      return url
    } catch (e) { return '' }
  }

  /**
   * 取回文本 → 改成 blob 地址 → 才挂上去。
   *
   * 顺序要紧：元素还在手上（没进文档）时就把 src 换成 blob:，然后才插进去。
   * 一只是"已经加载失败过"的 script 元素，带上了"启动过了"的标记，
   * 插进文档之后再改 src 是**不会重来**的。
   * 而官网那段代码是先 appendChild、后写 e.onload —— 把插入推迟到自己 fetch 完，
   * 正好让它的 onload 落在加载之前（不然它会一直收不到回调，空等到超时）。
   */
  function shimLoad(el, url, kind, insert) {
    shimCount++
    var isCss = el.tagName === 'LINK'
    var short = shortUrl(url)
    var what = kind === 'cross' ? '（跨域）' : ''
    // 同一只地址试过几回。换失败过的地址再换一次还可能失败，试两回就放手 ——
    // 不然"官网重试 → 我们再换 → 又失败"能一直转下去。
    shimTried[url] = (shimTried[url] || 0) + 1
    fetch(url, { credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      // 万一这个地址回的是一张 HTML（SPA 兜底、WAF 页），拿它当脚本灌进去只会炸；
      // 类型不对就退回去，让浏览器按原样去试。
      var type = String(res.headers.get('content-type') || '')
      var want = isCss ? 'css' : 'javascript'
      if (type.indexOf(want) === -1) throw new Error('Content-Type 不是 ' + want + '（' + (type || '没给') + '）')
      return res.text()
    }).then(function (text) {
      var blobUrl = ''
      try {
        blobUrl = URL.createObjectURL(new Blob([text], { type: isCss ? 'text/css' : 'text/javascript' }))
      } catch (e) {}
      if (!blobUrl) throw new Error('造不出 blob 地址')
      try { if (isCss) el.href = blobUrl; else el.src = blobUrl } catch (e) {}
      // 挂上去之后撤掉地址：内容已经进内存了，留着只是白占一份。
      setTimeout(function () { try { URL.revokeObjectURL(blobUrl) } catch (e) {} }, 60000)
      recordShim('元素换走 blob' + what + ': ' + short + ' / ' + text.length + ' 字节' +
        (isCss ? '（样式）' : ''))
      insert(el)
    }).catch(function (e) {
      recordShim('元素换走 blob 没成' + what + ': ' + short + ' / ' + ((e && e.message) || e) +
        ' —— 按原样插回去，让浏览器自己去试')
      insert(el)
    })
  }

  /**
   * 在 appendChild / insertBefore 上装一个"改道"的口子。
   * 挑这两个是因为官网注入脚本就一句 `document.head.appendChild(e)`（源码实测如此），
   * 而所有插入动作最后也都落到这两个方法上。
   *
   * 没包 append / prepend / insertAdjacentElement —— 那几条要自己处理"参数里混着字符串"的
   * 语义，多包一处就多一处能弄坏别人页面的地方，而实测见到的那条路根本不走它们。
   * 每一处都包 try/catch：这是别人家的页面，装不上就当没这回事。
   */
  function installShim() {
    try {
      var proto = Node.prototype
      var origAppend = proto.appendChild
      var origInsert = proto.insertBefore
      if (typeof origAppend !== 'function' || typeof origInsert !== 'function') return false
      proto.appendChild = function (node) {
        try {
          // shimCount 的判断放前面：到顶之后这里就是一次整数比较，连 tagName 都不用读。
          if (shimCount < SHIM_MAX && shimWants(node)) {
            var url = shimUrlFor(node)
            if (url) {
              var parent = this
              shimLoad(node, url, shimUrlKind(rawTarget(node, node.tagName)), function (el) {
                try { origAppend.call(parent, el) } catch (e) {}
              })
              return node
            }
          }
        } catch (e) {}
        return origAppend.call(this, node)
      }
      proto.insertBefore = function (node, ref) {
        try {
          if (shimCount < SHIM_MAX && shimWants(node)) {
            var url = shimUrlFor(node)
            if (url) {
              var parent = this
              shimLoad(node, url, shimUrlKind(rawTarget(node, node.tagName)), function (el) {
                try { origInsert.call(parent, el, ref) } catch (e) {}
              })
              return node
            }
          }
        } catch (e) {}
        return origInsert.call(this, node, ref)
      }
      recordShim('元素改道已挂上: <script> / <link rel=stylesheet> 改走 blob' +
        '（同源、跨域都试；成不成看 fetch 说了算，探针 ①③④ 证明这条路通）')
      return true
    } catch (e) {
      console.error('[chat] 挂元素改道失败:', e)
      return false
    }
  }

  /**
   * 官网的设备指纹（数美 SMSdk，脚本在 /static/fp.min.js）此刻是什么状态。
   *
   * 为什么盯着这一样东西：登录请求里的 device_id 就是它给的。官网源码里那句是
   * `device_id: e.deviceId` —— deviceId 是 undefined 时，JSON.stringify 会把这个键
   * **整个省掉**，服务端于是回 422 body.device_id（实测就是这么一条）。
   * 也就是说：这份指纹没起来，登录一个都不会成，而且报错看起来像"网络异常"。
   *
   * 只报长度和开头几个字符，不报完整 id —— 那是个能用来追踪设备的标识，
   * 没必要整串落进日志。
   */
  function deviceState() {
    var tag = null
    try { tag = document.querySelector('script[data-fp]') } catch (e) {}
    var tagState = tag ? '页面插了 <script data-fp>' : '页面没插 <script data-fp>'
    var sdk = null
    try { sdk = window.SMSdk } catch (e) {}
    if (!sdk) return '没有 window.SMSdk（' + tagState + '）'
    if (typeof sdk.getDeviceId !== 'function') return 'window.SMSdk 没有 getDeviceId（' + tagState + '）'
    try {
      var id = String(sdk.getDeviceId() || '')
      return (id ? 'deviceId 长度 ' + id.length + '，开头 ' + id.slice(0, 6) : 'deviceId 是空的') +
        '（' + tagState + '）'
    } catch (e) {
      return 'getDeviceId 抛错: ' + ((e && e.message) || e) + '（' + tagState + '）'
    }
  }

  function recordNet(entry) {
    try {
      if (netLog.length >= NET_LOG_MAX) netLog.shift()
      netLog.push(entry)
      saveNetLog()
    } catch (e) {}
    // 同时报给父窗，由它追加写到一个文件里（见 plugin/js/trace.js）。
    // 为什么要多这一步：页面上那些取证手段全挂在**文档**上 —— 登录那一步只要触发一次
    // 导航，数组、报告框、横条一起没。写文件那条路不依赖文档还在不在，也不要求用户在
    // GUI 里点任何东西：照着复现一次，事后直接看文件。
    // 用 sendQuiet：这里的失败跟"utools 全局有没有注入"无关，不该借用地址上报那条警告。
    if (isFailure(entry)) {
      // 失败的那一条顺手带上指纹状态 —— "422 缺 device_id"和"指纹没起来"要能一眼对上
      if (!entry.device) {
        try { entry.device = deviceState() } catch (e) {}
      }
      sendQuiet('chat:netfail', entry)
    }
  }

  /** 只上报失败的那些 —— 成功的请求既没用又吵 */
  function isFailure(entry) {
    return !entry.status || entry.status >= 400
  }

  /** 和 send() 一样，只是不触发"拿不到 utools 全局"那条警告（那条说的是会话地址） */
  function sendQuiet(channel, payload) {
    if (!hasUtools) return
    try {
      utools.sendToParent(channel, payload)
    } catch (e) {}
  }

  /** 失败的那些（状态码 0 = 连接层面就没成；4xx/5xx = 服务端不高兴） */
  function netFailures() {
    return netLog.filter(function (e) { return !e.status || e.status >= 400 })
  }

  /**
   * 把服务端在失败响应里说的话截一段留着。
   *
   * 这条边界是**为 422 这类状态码开的**：status 0 一眼就知道是"请求没发出去"，
   * 而 422 / 403 这类是"发出去了、服务端不收"，不收的理由只有服务端自己知道 ——
   * 官网的界面只会把它翻译成一句"网络异常"，那句话什么也说明不了。
   *
   * 代价要说清楚：之前这里"不碰任何响应体"，现在**只碰失败的、而且截到 400 字**。
   * 正常请求的响应体（包括登录成功后的令牌、对话内容）一个字都不读 ——
   * 那才是不该碰的部分。失败的登录响应里只会有服务端的错误说明。
   */
  function clip(text) {
    var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
    return s.length > 400 ? s.slice(0, 400) + '…' : s
  }

  function shortUrl(url) {
    try {
      var u = new URL(String(url), location.href)
      return (u.host === location.host ? '' : u.host) + u.pathname + (u.search ? '?…' : '')
    } catch (e) {
      return String(url).slice(0, 120)
    }
  }

  /**
   * 我们这次**发出去**的字段名（没有值）。
   *
   * 422 的意思就是"服务端收到的东西不合它的意"，而最常见的两种不合意是**缺字段**和
   * 字段值空着 —— 光看字段名就能对上号，不必看值。值里是手机号、邮箱、验证码，
   * 这些**不进日志**：这份日志是要被人贴来贴去的。所以只留名字，
   * 顺带标一下每个值的类型和长度（"发出去了但其实是空的"也是常见病因）。
   *
   * 认不出来的体（Blob、流、ArrayBuffer）只报个类型就退开 —— 猜比不报更坏事。
   */
  function valueKind(v) {
    if (v === undefined) return 'undefined'
    if (v === null) return 'null'
    if (typeof v === 'number' || typeof v === 'boolean') return String(v)
    if (typeof v === 'string') return 'str(' + v.length + ')'
    try {
      if (Object.prototype.toString.call(v) === '[object Array]') return 'array(' + v.length + ')'
    } catch (e) {}
    return typeof v
  }

  function bodyKeys(body) {
    if (body === undefined || body === null || body === '') return ''
    try {
      var pairs = null
      if (typeof body === 'string') {
        var s = body.trim()
        if (s.charAt(0) === '{') {
          var obj = JSON.parse(s)
          pairs = []
          for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
            pairs.push(k + ':' + valueKind(obj[k]))
          }
        } else if (s.indexOf('=') !== -1) {
          pairs = s.split('&').map(function (kv) { return String(kv).split('=')[0] })
        }
      } else if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        pairs = []
        body.forEach(function (v, k) { pairs.push(k + ':' + valueKind(v)) })
      } else if (typeof FormData !== 'undefined' && body instanceof FormData) {
        pairs = []
        body.forEach(function (v, k) { pairs.push(k) })
      } else if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return 'Blob(' + body.size + 'B)'
      } else {
        return typeof body
      }
      return pairs && pairs.length ? '{' + pairs.join(' ') + '}' : ''
    } catch (e) {
      return '(' + typeof body + '，字段读不出来)'
    }
  }

  /** 从 XHR 上读服务端那句错误说明。responseType 不是文本时读了会抛，所以包起来。 */
  function readXhrBody(xhr) {
    try {
      var type = xhr.responseType
      if (type && type !== 'text' && type !== 'json') return ''
      if (type === 'json') return clip(JSON.stringify(xhr.response))
      return clip(xhr.responseText)
    } catch (e) {
      return ''
    }
  }

  try {
    if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
      var xhrOpen = XMLHttpRequest.prototype.open
      var xhrSend = XMLHttpRequest.prototype.send
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__dsReq = { method: String(method || 'GET').toUpperCase(), url: String(url) }
        } catch (e) {}
        return xhrOpen.apply(this, arguments)
      }
      XMLHttpRequest.prototype.send = function () {
        var req = { method: '?', url: '?' }
        var sent = ''
        try {
          req = this.__dsReq || req
          // 只在失败时才用得上，所以先只算个字段名（不读值）
          sent = bodyKeys(arguments[0])
          var xhr = this
          xhr.addEventListener('error', function () {
            recordNet({ method: req.method, url: req.url, result: '失败（连接层面没成）', status: 0, sent: sent })
          })
          xhr.addEventListener('timeout', function () {
            recordNet({ method: req.method, url: req.url, result: '超时', status: 0, sent: sent })
          })
          xhr.addEventListener('loadend', function () {
            // status 0 的那两种上面已经记过了
            if (xhr.status >= 400) {
              recordNet({
                method: req.method, url: req.url, result: 'HTTP ' + xhr.status, status: xhr.status,
                body: readXhrBody(xhr), sent: sent,
              })
            }
          })
        } catch (e) {}
        return xhrSend.apply(this, arguments)
      }
    }
  } catch (e) {
    console.error('[chat] 包装 XMLHttpRequest 出错:', e)
  }

  try {
    if (typeof window.fetch === 'function') {
      var nativeFetch = window.fetch
      window.fetch = function (input, init) {
        var method = 'GET'
        var url = ''
        try {
          method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
          url = typeof input === 'string' ? input : String((input && input.url) || input)
        } catch (e) {}
        return nativeFetch.apply(this, arguments).then(function (res) {
          try {
            if (res && res.status >= 400) {
              var entry = { method: method, url: url, result: 'HTTP ' + res.status, status: res.status,
                sent: bodyKeys(init && init.body) }
              // clone 一份去读正文：原件要原样还给页面，不能把它读掉。
              // 读正文是异步的，所以这一条等读到了再记（记两次会重复计数）。
              // 只有失败的响应才 clone —— 正常响应（尤其 SSE 那种长连接）一个字都不碰。
              res.clone().text().then(function (text) {
                entry.body = clip(text)
                recordNet(entry)
              }, function () { recordNet(entry) })
              return res
            }
          } catch (e) {
            // clone 不了也要留下这条失败记录，别因为读正文失败就丢了它
            try {
              recordNet({ method: method, url: url, result: 'HTTP ' + res.status, status: res.status,
                sent: bodyKeys(init && init.body) })
            } catch (e2) {}
          }
          return res
        }, function (err) {
          try {
            recordNet({
              method: method, url: url, status: 0,
              result: '失败（连接层面没成）',
              error: String((err && err.message) || err),
              sent: bodyKeys(init && init.body),
            })
          } catch (e) {}
          throw err
        })
      }
    }
  } catch (e) {
    console.error('[chat] 包装 fetch 出错:', e)
  }

  // WebSocket 也看着点。登录这一步走的应该是 XHR / fetch，但"网络异常"那句话是哪来的
  // 我们还没坐实 —— 官网的实时通道正是 WebSocket，它连不上时页面同样只会说"网络异常"。
  // 包构造函数的代价比 fetch 大，所以只在**实例上**挂 error/close 两个监听，
  // 原对象原样返回（`new` 里返回对象就是它，instanceof 仍然成立），也不碰任何原型方法。
  try {
    if (typeof window.WebSocket === 'function') {
      var NativeWS = window.WebSocket
      var WrappedWS = function (url, protocols) {
        var ws = (arguments.length > 1) ? new NativeWS(url, protocols) : new NativeWS(url)
        try {
          ws.addEventListener('error', function () {
            recordNet({ method: 'WS', url: String(url), result: '失败（连接层面没成）', status: 0 })
          })
          ws.addEventListener('close', function (ev) {
            // 正常关闭（wasClean）不记 —— 那不是故障
            if (ev && ev.wasClean) return
            recordNet({
              method: 'WS', url: String(url), status: 0,
              result: '连接断了' + (ev && ev.code ? '（code ' + ev.code + '）' : ''),
            })
          })
        } catch (e) {}
        return ws
      }
      WrappedWS.prototype = NativeWS.prototype
      // 常量得跟过去：页面里写 WebSocket.OPEN 的地方不少
      ;['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (name) {
        try {
          WrappedWS[name] = NativeWS[name]
        } catch (e) {}
      })
      window.WebSocket = WrappedWS
    }
  } catch (e) {
    console.error('[chat] 包装 WebSocket 出错:', e)
  }

  /** 官网的界面现在挂上没有（脚本跑了不等于界面起来了，这是两件事） */
  function rootState() {
    try {
      var root = document.querySelector('#root')
      if (!root) return '#root 不存在'
      return '#root 有 ' + root.childElementCount + ' 个子节点'
    } catch (e) {
      return '#root 读不出来: ' + e
    }
  }

  /** 上次的会话地址（校验过前缀才认，存储被写脏时退回首页） */
  function readTarget() {
    if (!hasUtools) return SITE
    try {
      var saved = utools.dbStorage.getItem(KEY_LAST_URL)
      if (typeof saved === 'string' && saved.indexOf(CONVERSATION_PREFIX) === 0) return saved
    } catch (e) {
      console.error('[chat] 读取上次会话失败，改用首页:', e)
    }
    return SITE
  }

  // 把目标交给本地落地页。它在同一进程的主世界里，直接挂全局就行。
  // （uTools 的窗口没开 contextIsolation —— 主 preload 的 window.deepseekHost
  //   就是这么给 index.html 用的。万一哪天开了，页面读不到就退回首页，不会白屏。）
  window.chatHost = {
    site: SITE,
    target: readTarget(),
  }

  // ---- 地址上报 ----
  //
  // 官网是 SPA：切换会话走的是 history.pushState，既不发 load 也不发 popstate，
  // 光靠事件会漏。所以三手都上：
  //   1. 改写 pushState/replaceState（主世界同源，改得到）；
  //   2. 监听 load/hashchange/popstate；
  //   3. 兜一个 2 秒心跳。
  // 上报前比对上一次的值，重复的地址不会反复打扰父窗。

  var lastReported = ''

  function report() {
    var url = location.href
    if (!url || url === lastReported) return
    lastReported = url
    send('chat:url', url)
  }

  try {
    ;['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name]
      if (typeof original !== 'function') return
      history[name] = function () {
        var result = original.apply(this, arguments)
        // 页面自己可能紧接着再读 location，等一拍再报，拿到的就是新地址了
        setTimeout(report, 0)
        return result
      }
    })
  } catch (e) {
    console.error('[chat] 改写 history 失败（改用心跳上报）:', e)
  }

  try {
    window.addEventListener('load', report)
    window.addEventListener('DOMContentLoaded', report)
    window.addEventListener('hashchange', report)
    window.addEventListener('popstate', report)
  } catch (e) {
    console.error('[chat] 注册地址监听失败:', e)
  }

  try {
    setInterval(function () { report(); rescue() }, 2000)
  } catch (e) {
    console.error('[chat] 启动地址心跳失败:', e)
  }

  report()

  // ---- 官网脚本没通过完整性校验时的救一次 ----
  //
  // 官网的两个 <script src="fe-static.deepseek.com/..."> 带 integrity（SRI）：
  // 拿到的字节和 HTML 里写的哈希对不上，浏览器就拒绝执行，触发它们内联的 onerror
  // —— 那个函数会把 body 整个换成一张"页面资源加载异常，请刷新重试"的图
  //（class 是 _sri-ck，按钮 onclick="location.reload()"）。
  //
  // 诱因基本在网络链路上（代理/加速器/中间缓存把 fe-static 的响应换掉了）：
  // 那一刻取到的是坏副本，重取一次往往就对了。所以这里让父窗带缓存绕过重载一次；
  // 父窗没接住（1.2 秒还没把页面导航走）就自己 location.reload() 收尾。
  //
  // 只救一次：标记写进 sessionStorage，刷新之后还在 —— 网络真坏了的时候
  // 反复自动刷新比停在这张图更糟，第二次就把页面交给官网自己的「重新加载」按钮。
  var SRI_RETRY_KEY = 'deepseek:sriRetried'
  var sriHandled = false

  function sriRetried() {
    // 读不到存储就当作"已经救过"：宁可不救，也不能刷成死循环
    try {
      return sessionStorage.getItem(SRI_RETRY_KEY) === '1'
    } catch (e) {
      return true
    }
  }

  function looksLikeSric() {
    try {
      if (document.querySelector('._sri-ck')) return true
      var body = document.body
      if (!body) return false
      // 兜底：认文案。官网按 navigator.languages 出中/英文两套
      var text = body.innerText || body.textContent || ''
      return text.indexOf('资源加载异常') !== -1 || text.indexOf('Failed to load') !== -1
    } catch (e) {
      return false
    }
  }

  function rescue() {
    if (sriHandled) return
    if (location.hostname.indexOf('deepseek.com') === -1) return
    if (!looksLikeSric()) return
    sriHandled = true
    sendQuiet('chat:trace', '页面侧认出官网的「资源加载异常」页: ' + location.href +
      '（这次是第' + (sriRetried() ? '二' : '一') + '次）')
    // 趁页面还在，把探针跑掉：大多数发法都是几毫秒就失败，赶得上下面的重载；
    // 结论另存 sessionStorage，就算这份文档马上被导航走也还在。
    runProbe()

    if (!sriRetried()) {
      // 第一次：当成"缓存里有坏副本"，绕过缓存重载一次
      console.warn('[chat] 官网脚本没通过完整性校验（页面被换成"资源加载异常"提示），自动重载一次')
      markRetried()
      requestCachelessReload()
      return
    }

    // 第二次：自动重载救不回来，就别再刷新了 —— 把现场侦察的结果直接摆在页面上。
    // 这一步是为了让人（而不是控制台）能看到到底哪一步对不上。
    // 实测能分出四种：缓存里那份是坏的 / 链路上一直在换字节 / 拿回来的是张错误页 /
    // 字节其实是对的、只是这只跨域脚本没走成 CORS 校验（最后这种与网络无关）。
    console.warn('[chat] 官网脚本又一次没通过完整性校验。正在生成诊断信息… URL: ' + location.href)
    diagnose(function (report) { showDiag(report) })
  }

  function markRetried() {
    try {
      sessionStorage.setItem(SRI_RETRY_KEY, '1')
    } catch (e) {
      // 写不进去也无所谓：sriRetried() 会因此一直返回 true —— 救一次就够，不会再刷
    }
  }

  /** 让父窗绕过缓存重载；父窗没接住（1.2 秒还没把页面导航走）就自己 reload 收尾 */
  function requestCachelessReload() {
    send('chat:sri', { url: location.href })
    setTimeout(function () {
      // 父窗要是已经重载过，这个页面连同定时器早就没了
      try {
        location.reload()
      } catch (e) {
        // 重载都失败就停在这张图上，用户还能自己点官网的「重新加载」
      }
    }, 1200)
    // 兜底：5 秒后这个页面居然还活着，说明两次重载都没真的发生 ——
    // 那就别再指望刷新了，直接把侦察结果摆出来。
    setTimeout(function () { diagnose(showDiag) }, 5000)
  }

  // ---- 现场侦察：把"到底哪一步对不上"查出来 ----

  // 官网那张错误图是 `document.body.replaceChildren(...)` —— 它把整个 body 换掉，
  // 连 `<div id="root">` 一起没了。所以要在它动手之前把原来的 body 存一份，
  // 万一后面要"自己验一遍再把脚本放行"（见 patchAndRun），得先把舞台搭回去。
  var bodySnapshot = ''

  function snapshotBody() {
    try {
      if (bodySnapshot) return
      var body = document.body
      if (!body || body.querySelector('._sri-ck')) return
      bodySnapshot = body.innerHTML
    } catch (e) {
      // 存不到就存不到，patchAndRun 会退化成"只注入、不还原"
    }
  }

  /**
   * 浏览器自己记的这条请求的结果。这是唯一能回答"那次加载到底拿到了什么"的东西 ——
   * 我们的 fetch 是事后重取的，跟当时那次不是同一个请求。
   * 官网这台 CDN 回了 `timing-allow-origin: *`，所以连状态码都拿得到。
   */
  function timingFor(url) {
    try {
      var list = performance.getEntriesByType('resource')
      for (var i = 0; i < list.length; i++) {
        if (list[i].name !== url) continue
        var e = list[i]
        return {
          status: e.responseStatus,
          bytes: e.decodedBodySize,
          transfer: e.transferSize,
          duration: Math.round(e.duration),
        }
      }
    } catch (e) {
      // 拿不到就不显示这一行
    }
    return null
  }

  function toBase64(bytes) {
    var s = ''
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
  }

  /**
   * 挨个重新取一遍官网那两个带 integrity 的脚本，自己算 sha384 跟 HTML 里写的比。
   * 这是唯一能把"字节不对"和"请求被拒"分开的办法（浏览器不会告诉你 SRI 为什么失败）。
   *
   * 每只脚本取**两遍**，这是关键：
   *   - `cache: 'no-store'` —— 绕过缓存，拿到"此刻网络上那份"；
   *   - 默认 cache 模式     —— 走缓存，拿到"浏览器刚才真的用的那份"。
   * 两遍一比就能分开两种都表现为"哈希对不上"的情况：
   *   没人换字节、只是缓存里那副本坏了（两遍不一致）；
   *   或者链路一直在换字节（两遍一致，但都跟 integrity 对不上）。
   * @param {(report: object) => void} done 全部取完（或超时）后回调
   */
  function diagnose(done) {
    var report = {
      url: location.href,
      agent: navigator.userAgent,
      root: rootState(),
      violations: violations.slice(),
      scripts: [],
      styles: [],
      note: '',
    }
    var targets = []
    try {
      var list = document.querySelectorAll('script[src][integrity]')
      for (var i = 0; i < list.length; i++) {
        targets.push({ src: list[i].src, integrity: list[i].getAttribute('integrity') || '' })
      }
    } catch (e) {
      report.note = '找不到带 integrity 的 script 标签: ' + e
    }
    // 样式也要点名：`<link rel=stylesheet>` 走的是和 <script> 一样的"元素发请求"那条路，
    // 那条路在我们这个窗口里是被挡掉的（实测：脚本请求 HTTP 0、0 字节、2ms）。
    // 只放行脚本不放行样式，结果就是"界面出来了，一个样式都没有"。
    try {
      var links = document.querySelectorAll('link[rel~="stylesheet"]')
      for (var j = 0; j < links.length; j++) {
        if (!links[j].href) continue
        report.styles.push({ href: links[j].href, timing: timingFor(links[j].href) })
      }
    } catch (e) {
      report.note = (report.note ? report.note + '；' : '') + '找不到样式表: ' + e
    }
    if (!targets.length) {
      done(report)
      return
    }

    var pending = targets.length * 2
    var finished = false
    function finish() {
      if (finished) return
      finished = true
      done(report)
    }
    // 网络卡住时也得给人看结果，不能一直转
    setTimeout(finish, 8000)

    targets.forEach(function (target) {
      var item = { src: target.src, integrity: target.integrity, expected: '',
        net: fresh(), cache: fresh(), timing: timingFor(target.src) }
      item.expected = (target.integrity.split(/\s+/)[0] || '')
      report.scripts.push(item)

      // 不带 credentials，这样看到的就是"没有登录态时网络上那份"，
      // 也避免拿别人的 cookie 去验一遍（这条链路本来就该是匿名的）
      probe(target.src, { cache: 'no-store', credentials: 'omit' }, item.net)
      probe(target.src, { credentials: 'omit' }, item.cache)
    })

    function fresh() {
      return { status: null, type: null, acao: null, bytes: null, head: null, hash: null, error: null }
    }

    /** 取一次并算出哈希，结果写进 slot。任何一步失败都落到 slot.error，绝不往外抛 */
    function probe(src, init, slot) {
      fetch(src, init)
        .then(function (res) {
          slot.status = res.status
          // 这两个响应头是这段侦察里信息量最大的两项：
          //   content-type 不是 javascript → 拿回来的是张错误页（WAF/网关插的）
          //   access-control-allow-origin 不合法 → 浏览器必然拒这只跨域脚本（SRI 要求它走 CORS）
          try {
            slot.type = res.headers.get('content-type')
            slot.acao = res.headers.get('access-control-allow-origin')
          } catch (e) {
            // 拿响应头失败就算了，不影响下面的哈希比对
          }
          return res.arrayBuffer()
        })
        .then(function (buf) {
          slot.bytes = buf.byteLength
          // 开头几十个字节够认出"这是不是一张 HTML 错误页"了
          slot.head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(48, buf.byteLength)))
            .replace(/\s+/g, ' ')
          return crypto.subtle.digest('SHA-384', buf)
        })
        .then(function (digest) {
          slot.hash = 'sha384-' + toBase64(new Uint8Array(digest))
        })
        .catch(function (e) {
          // 这里抛得最多的是 CORS 被拒（fetch 的 TypeError 对"被拒"和"网络不通"不区分）
          slot.error = String((e && e.message) || e)
        })
        .then(function () {
          pending--
          if (pending === 0) finish()
        })
    }
  }

  function shortName(url) {
    var parts = String(url).split('/')
    return parts[parts.length - 1] || url
  }

  function reportLines(report) {
    var lines = []
    lines.push('对话窗没能跑起官网的脚本：官网的 <script> 带 integrity（SRI 完整性校验），浏览器把它们拒了，')
    lines.push('官网于是弹了"页面资源加载异常，请刷新重试"。自动重载没能救回来，下面是现场侦察的结果。')
    lines.push('')
    lines.push('页面 : ' + report.url)
    lines.push('UA   : ' + report.agent)
    lines.push('界面 : ' + (report.root || '（没读）'))
    if (report.violations && report.violations.length) {
      lines.push('拦截 : ' + report.violations.join(' / '))
    }
    if (report.note) lines.push('备注 : ' + report.note)
    lines.push('')

    if (!report.scripts.length) {
      lines.push('（没找到带 integrity 的脚本标签，可能官网改版了）')
    }
    report.scripts.forEach(function (item, idx) {
      lines.push('── 脚本 ' + (idx + 1) + '：' + shortName(item.src))
      lines.push('   地址       : ' + item.src)
      lines.push('   这次加载   : ' + describeTiming(item))
      lines.push('   绕过缓存取 : ' + describe(item.net))
      lines.push('   走缓存取   : ' + describe(item.cache))
      lines.push('   官网 HTML  : ' + item.expected)
      verdict(item).forEach(function (line) { lines.push(line) })
      lines.push('')
    })

    // 样式单独列一段：它没有哈希可验，但同样会"一个字节都没拿到"，而它的缺失
    // 表现得最直白 —— 界面出来了、一个样式都没有。
    if (report.styles && report.styles.length) {
      lines.push('── 样式表')
      report.styles.forEach(function (item) {
        lines.push('   ' + shortName(item.href) + ' : ' + describeTiming(item) +
          (needStyle(item) ? ' ← 需要重取' : ''))
      })
      lines.push('')
    }

    // 这一段是每次点「复制」时**现算**的（读的是此刻的记录，不是生成报告那一刻的），
    // 因为要抓的故障恰恰发生在放行之后 —— 登录、拉会话这些。
    netLines().forEach(function (line) { lines.push(line) })
    return lines
  }

  /**
   * "这个窗口里失败的请求"那一段（报告和父窗来取的两处共用同一份排版）。
   * 刻意**不依赖 currentReport** —— 导航之后报告可能压根还没生成，记录却还在
   * （它落在 sessionStorage 里）。
   */
  function netLines() {
    var lines = []
    var failed = netFailures()
    lines.push('── 这个窗口里失败的请求（记了 ' + netLog.length + ' 条，其中失败 ' + failed.length + ' 条）')
    if (!failed.length) {
      lines.push('   （还没有失败的记录）')
    } else {
      failed.slice(-12).forEach(function (e) {
        lines.push('   ' + e.method + ' ' + shortUrl(e.url) + ' → ' + e.result +
          (e.error ? '：' + e.error : ''))
        // 服务端在失败响应里说的那句话 —— 4xx/5xx 时这是唯一说得清"为什么"的东西
        // （官网的界面会把它翻成一句"网络异常"，那句什么也说明不了）
        if (e.body) lines.push('      服务端说：' + e.body)
        // 我们这次发出去的字段名（只有名字和值的长短，没有值）。
        // "缺字段"是 422 最常见的病因，看名字就能对上号。
        if (e.sent) lines.push('      我们发的：' + e.sent)
        // 设备指纹当时的状态 —— 登录请求缺 device_id 就是这么来的
        if (e.device) lines.push('      指纹：' + e.device)
      })
      if (failed.length > 12) lines.push('   （只列了最后 12 条）')
    }
    // 元素发起的请求没加载成的那些（<script>/<link>/<img>）。这一类和上面的 XHR/fetch
    // 是两种病：上面是"请求发出去了服务端不收"，这里多半是"请求压根没发出去"。
    // 官网的设备指纹脚本就在这里面 —— 它没起来，登录就一定缺 device_id。
    lines.push('')
    lines.push('── 没加载成的资源（元素发起的，记了 ' + elFails.length + ' 条）')
    if (!elFails.length) {
      lines.push('   （没有）')
    } else {
      elFails.slice(-8).forEach(function (f) {
        lines.push('   <' + f.tag + '> ' + f.url + (f.fp ? '   ← 设备指纹脚本' : ''))
      })
    }
    lines.push('设备指纹：' + deviceState())
    // 浏览器自己下的判断。"一条都没有"本身就是结论：不是 SRI 拦的，也不是 CSP 拦的。
    lines.push('浏览器报告：' + (browserReports.length
      ? browserReports.join(' / ')
      : '（一条都没有 —— 说明既不是 SRI 校验没过，也不是 CSP 拦的）'))
    if (violations.length) lines.push('CSP 违规：' + violations.join(' / '))
    // 探针：把"为什么加载不成"这件事换几种发法试出来
    var probe = probeLoad()
    lines.push('')
    lines.push('── 探针：同一个地址，换几种发法各试一次')
    if (!probe.length) lines.push('   （还没跑 —— 只有这次真的出现过"没加载成"才会跑）')
    else probe.forEach(function (line) { lines.push(line) })
    // 改道记录。有这几行，就能一眼看出"挡住的脚本到底有没有被换走、换成功没有"。
    lines.push('')
    lines.push('── 元素改道（<script> / <link> 换走 blob，次数 ' + shimCount + '）')
    if (!shimLog.length) lines.push('   （没换过）')
    else shimLog.slice(-6).forEach(function (line) { lines.push('   ' + line) })
    return lines
  }

  /**
   * 供父窗来取的一段独立文本。为什么要有它：页面里那份报告是挂在 DOM 上的，
   * 导航一下（登录那一步很可能就是）就跟着文档一起没了 —— 实测用户回头想复制时
   * "左上角横条"已经不在了。父窗拿这一段不经过 DOM，也就没有这个毛病。
   */
  function netReportText() {
    var lines = [
      '对话窗：' + location.href,
      'UA   : ' + navigator.userAgent,
      '界面 : ' + rootState(),
      '记录 : sessionStorage 里那份（' + netLog.length + ' 条，跨页面导航保留）',
      '',
    ]
    netLines().forEach(function (line) { lines.push(line) })
    return lines.join('\n')
  }

  /** 这只样式表需不需要重取：浏览器自己记的那次加载没拿到字节（连记录都没有的也算） */
  function needStyle(item) {
    return !(item.timing && item.timing.bytes > 0)
  }

  /** 要交给修复那一步重取的样式（按文档里的先后顺序） */
  function stylesToLoad(report) {
    var out = []
    ;(report.styles || []).forEach(function (item) {
      if (needStyle(item)) out.push({ href: item.href })
    })
    return out
  }

  /** 浏览器自己记的那次加载（性能时间线），事后重取看不到的东西就在这儿 */
  function describeTiming(item) {
    var t = item.timing
    if (!t) return '（浏览器没留下这条记录）'
    var line = 'HTTP ' + (t.status === undefined ? '?' : t.status) + '，' +
      t.bytes + ' 字节（传输 ' + t.transfer + '），耗时 ' + t.duration + 'ms'
    if (t.bytes === 0) line += ' —— 一个字节都没拿到，是请求本身没成'
    else if (t.bytes === item.net.bytes) line += ' —— 拿到的字节数和网络上那份一样'
    return line
  }

  /** 把一次取回结果的摘要压成一行 */
  function describe(slot) {
    if (slot.error) return '取不到 —— ' + slot.error
    return 'HTTP ' + slot.status + '，' + slot.bytes + ' 字节，' + (slot.type || '未知类型') +
      '，' + (slot.hash || '未算出哈希')
  }

  /**
   * 下结论。两遍取回的组合是有含义的，逐条对上：
   *   - 两遍都取不到             → 请求在 CORS / 网络这一层就被拒了
   *   - 新请求取不到、缓存能取到  → 新请求被链路拦了
   *   - 网络那份对、缓存那份不对  → 缓存里躺着坏副本，清缓存即可
   *   - 两遍都一样但对不上        → 链路上有人一直在换字节（代理 / 加速器 / 网关）
   *   - 两遍都对却还是被拒        → 字节没问题，是这只跨域脚本没走成 CORS 校验
   * @returns {string[]} 要输出的几行（自带缩进）
   */
  function verdict(item) {
    var out = []
    var net = item.net
    var cached = item.cache
    var netOk = !!(net.hash && net.hash === item.expected)
    var cachedOk = !!(cached.hash && cached.hash === item.expected)

    // 先看浏览器自己记的那次加载。这是唯一能回答"当时到底怎么了"的一行：
    // 拿回 0 字节、耗时 1ms，说明请求还没发出去就被挡了，跟网络、缓存、字节都没关系。
    if (item.timing && item.timing.bytes === 0) {
      out.push('   → 浏览器自己记的那次加载是 HTTP ' + item.timing.status + '、0 字节：')
      out.push('     请求根本没发出去就被挡了，不是网络也不是缓存的问题（事后重取两遍都是好的，')
      out.push('     正说明"网络此刻没问题"——被挡的是"让页面去发这个跨域脚本请求"这件事本身）。')
      out.push('     再重取一遍、再插一只 <script>，照样会被挡在同一处。得换成"父窗去取、')
      out.push('     自己验完哈希再灌进页面"那条路 —— 点上面的「自己验一遍后放行（试一次）」，')
      out.push('     页面侧不成的话它会自动改走父窗那条。')
      return out
    }

    if (net.error && cached.error) {
      out.push('   → 两次都没取到：请求在 CORS 或网络这一层就被拒了（代理、加速器、公司网关，')
      out.push('     或者这只脚本跨域时没拿到合法的 Access-Control-Allow-Origin）')
      return out
    }
    if (!net.error && /html/i.test(net.type || '')) {
      out.push('   → 拿回来的 Content-Type 是 ' + net.type + '，不是 javascript ——')
      out.push('     大概率是网关/WAF 插了一张错误页当脚本发下来了')
      if (net.head) out.push('     它的开头是：' + net.head)
      return out
    }
    if (net.error) {
      out.push('   → 绕过缓存那次取不到（' + net.error + '），缓存里那份反倒取得到：')
      out.push('     新发出去的请求被链路拦了（代理 / 加速器 / 网关），缓存成了唯一还能用的来源')
      if (!cachedOk) out.push('     可缓存里那份的哈希也对不上官网 HTML 里写的，所以它同样不能用')
      return out
    }
    if (netOk && cached.hash && !cachedOk) {
      out.push('   → 查到了：网络上那份是**对的**，缓存里那份**是坏的**（两者哈希不一样）。')
      out.push('     浏览器这次用的正是缓存里那份，所以校验没过。清掉缓存（见 README 的「已知限制」），')
      out.push('     或者点下面的「重新加载（绕过缓存）」再看一眼。')
      return out
    }
    if (!netOk) {
      out.push('   → 字节对不上：取回来的内容和官网 HTML 里写的哈希不是一对，')
      out.push('     是坏副本（代理 / 加速器 / 中间缓存，或者网关插了东西）')
      return out
    }
    if (cachedOk) {
      out.push('   → 两遍取回来都和官网 HTML 里写的一致 —— 网络是干净的，')
      out.push('     问题在"这只跨域脚本没能通过校验"这一侧')
    } else {
      out.push('   → 网络上那份是对的（和官网 HTML 里写的一致）；缓存那份这次取不到，没得比')
    }
    // 这行多半会是空的，而且**空不代表服务器没发**：跨域取回来的响应里只有
    // Cache-Control、Content-Language、Content-Type 这几个"安全名单"内的头对 JS 可见，
    // Access-Control-Allow-Origin 不在名单里 —— 读不到就是浏览器不告诉我们。
    // 留着只是万一哪天变成可见的（或者谁改成了同源），别把"读不到"当成证据用。
    out.push('     本轮这条响应里的 Access-Control-Allow-Origin = ' + (net.acao || '(读不到)'))
    return out
  }

  // 最近一次生成的报告。留着它只为了一件事：**报告的正文要能现算**。
  // 「这次加载」那几行是死的（那是当时的事后侦察），但"失败的请求"那一段是活的 ——
  // 要抓的故障恰恰发生在放行之后（登录、发消息）。所以「复制」不能复制生成报告那一刻的
  // 快照，得拿这份 report 重新拼一遍（见 copyCurrentText）。
  var currentReport = null

  /** 把诊断结果渲染到页面上（官网那张错误图保留在下面，不覆盖） */
  function showDiag(report) {
    try {
      currentReport = report
      var text = reportLines(report).join('\n')

      // 已经有一份就先撤掉：报告可能被生成两次（心跳那条路 + 「重新加载」按钮那条路）
      removeDiag()

      var box = document.createElement('div')
      box.setAttribute('data-deepseek-helper', 'diag')
      // 全部内联样式：官网的 CSS 这会儿是加载了还是没加载都不好说
      box.style.cssText = [
        'position:fixed', 'left:12px', 'right:12px', 'top:12px', 'z-index:2147483647',
        'background:#111827', 'color:#e5e7eb', 'border:1px solid #374151', 'border-radius:10px',
        'box-shadow:0 10px 30px rgba(0,0,0,.45)', 'padding:12px 14px',
        'font:12px/1.6 Consolas,Menlo,monospace', 'text-align:left',
      ].join(';')

      var pre = document.createElement('pre')
      pre.textContent = text
      pre.style.cssText = 'margin:0;max-height:52vh;overflow:auto;white-space:pre-wrap;word-break:break-all'

      var bar = document.createElement('div')
      bar.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap'

      function addButton(label, onClick) {
        var btn = document.createElement('button')
        btn.textContent = label
        btn.style.cssText = 'padding:6px 10px;border-radius:6px;border:1px solid #4b5563;' +
          'background:#1f2937;color:#e5e7eb;font:12px/1 inherit;cursor:pointer'
        btn.addEventListener('click', function () {
          try {
            onClick()
          } catch (e) {
            console.error('[chat] 诊断按钮失败:', e)
          }
        })
        bar.appendChild(btn)
        return btn
      }

      // 放在第一个：这是唯一可能"当场把窗口救活"的按钮。
      // 两条路依次试：先在页面里自己取、自己验、重新插 <script>（不经过浏览器的 SRI）；
      // 页面侧不成（实测就是不成 —— 请求压根发不出去），再交给父窗去取（Node 没有 CORS 这一层），
      // 验完哈希用 executeJavaScript 灌进来。两条路的校验都是"和官网 HTML 里写的逐字比"。
      var patchBtn = addButton('自己验一遍后放行（试一次）', function () {
        patchBtn.textContent = '正在核对哈希…'
        patchBtn.disabled = true
        patchAndRun(report.scripts, stylesToLoad(report), function (result) {
          console.warn('[chat] 放行的结果:', result.reason || '', result.short, result.long || '')
          sendQuiet('chat:trace', '页面侧放行: ' + (result.reason || '?') + ' / ' + result.short +
            (result.long ? ' / ' + result.long : ''))
          if (result.ok) {
            patchBtn.disabled = false
            patchBtn.textContent = '已放行 ✓'
            // 放行成功就少在人家界面上晃：等官网的界面画出来之后换成一条细横条。
            // **不是直接收掉** —— 放行只解决"界面起不来"，接下来要登录、要发消息，
            // 那些请求要是也被挡，官网只会回一句"网络异常"，什么线索都不给。
            // 横条上留着「复制」，随时能把这份活记录捞出来。
            setTimeout(collapseDiag, 2500)
            return
          }
          if (fallbackReason(result.reason) && hasUtools) {
            patchBtn.textContent = '页面侧没成，改由父窗取…'
            send('chat:nodeRepair', {
              url: location.href,
              scripts: report.scripts,
              styles: stylesToLoad(report),
            })
            // 父窗也可能一直不吭声（窗口没了、IPC 断了）。不能让人对着一个永远禁用的按钮。
            setTimeout(function () {
              if (patchBtn.disabled) {
                patchBtn.disabled = false
                patchBtn.textContent = '父窗没有回音，可以再试一次'
              }
            }, 15000)
          } else if (fallbackReason(result.reason)) {
            patchBtn.disabled = false
            patchBtn.textContent = result.short + '（窗口里没有 utools 全局，父窗那条路也走不了）'
          } else {
            patchBtn.disabled = false
            patchBtn.textContent = result.short
          }
        })
      })
      addButton('重新加载（绕过缓存）', function () {
        // 交给父窗 reloadIgnoringCache；接不住就自己 reload
        requestCachelessReload()
      })
      addButton('在系统浏览器打开', function () {
        if (hasUtools && utools.shellOpenExternal) utools.shellOpenExternal(location.href)
        else window.open(location.href, '_blank')
      })
      var copyBtn = addButton('复制这些信息', function () {
        copyCurrentText(copyBtn)
      })

      box.appendChild(pre)
      box.appendChild(bar)
      document.body.insertBefore(box, document.body.firstChild)
    } catch (e) {
      console.error('[chat] 渲染诊断信息失败:', e)
    }
  }

  /** 撤掉页面上那份报告 */
  function removeDiag() {
    try {
      var box = document.querySelector('[data-deepseek-helper="diag"]')
      if (box && box.parentNode) box.parentNode.removeChild(box)
    } catch (e) {
      console.error('[chat] 收起诊断信息失败:', e)
    }
  }

  /**
   * 复制一段文字，反馈写在按钮上。
   * 优先走 navigator.clipboard（要安全上下文 + 可能要权限），拿不到就退回
   * textarea + execCommand('copy') —— 后者在 Electron 里从来都管用，所以两条都留着。
   * 两条都失败也不能让人对着一个没反应的按钮，直接把话写在按钮上说清楚。
   */
  function copyText(text, btn) {
    function done(ok) {
      try {
        btn.textContent = ok ? '已复制' : '复制失败，手动选一下'
      } catch (e) {}
    }
    function fallback() {
      try {
        var ta = document.createElement('textarea')
        ta.value = text
        ta.style.cssText = 'position:fixed;top:-1000px'
        document.body.appendChild(ta)
        ta.select()
        var ok = false
        try {
          ok = document.execCommand('copy')
        } catch (e) {
          ok = false
        }
        document.body.removeChild(ta)
        done(ok)
      } catch (e) {
        done(false)
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { done(true) }, fallback)
        return
      }
    } catch (e) {
      // 再退到下面那条
    }
    fallback()
  }

  /**
   * 复制报告全文 —— **此刻现拼**，不是生成报告那一刻的快照。
   * 这一点是这个按钮的全部意义：放行成功之后才是真正会出故障的时候（登录、发消息），
   * 而那时候"失败的请求"那一段才长出来。
   */
  function copyCurrentText(btn) {
    if (!currentReport) {
      try {
        btn.textContent = '报告已经不在了'
      } catch (e) {}
      return
    }
    copyText(reportLines(currentReport).join('\n'), btn)
  }

  /**
   * 把整份报告收成一条细横条。
   *
   * 放行成功之后**不把报告删掉**：这条横条是后面唯一还能拿到线索的入口 ——
   * 登录要是失败，官网只回"网络异常，请检查你的网络状况"，没地址、没状态码。
   * 所以留一个不起眼的条，「详情」能把报告重新拉出来，「复制」能现取一份最新的。
   */
  function collapseDiag() {
    if (!currentReport) {
      removeDiag()
      return
    }
    try {
      var box = document.querySelector('[data-deepseek-helper="diag"]')
      if (!box) return
      while (box.firstChild) box.removeChild(box.firstChild)

      box.style.cssText = 'position:fixed;left:12px;top:12px;z-index:2147483647;' +
        'background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:8px;' +
        'box-shadow:0 6px 18px rgba(0,0,0,.35);padding:6px 8px;' +
        'font:12px/1.6 Consolas,Menlo,monospace;display:flex;gap:8px;align-items:center'

      var failed = netFailures().length
      // 父窗那条路的结果（「已放行」/「父窗侧也没成：…」）是这轮最要紧的一句话，
      // 收成横条时不能跟着正文一起被清掉 —— 它本来就该一直留在那儿。
      var tail = repairNote ? ' · ' + repairNote : ''
      var label = document.createElement('span')
      label.textContent = 'DeepSeek 助手：已放行 ✓' + (failed ? ' · 失败请求 ' + failed : '') + tail
      box.appendChild(label)

      addSmallButton(box, '详情', function () { diagnose(showDiag) })
      addSmallButton(box, '复制', function () { copyCurrentText(this) })
      addSmallButton(box, '收掉', removeDiag)
    } catch (e) {
      console.error('[chat] 收起报告为横条失败:', e)
    }
  }

  /** 横条上的小按钮（和报告框里那排是两套：这里窄，字号和留白都得收一档） */
  function addSmallButton(parent, label, onClick) {
    var btn = document.createElement('button')
    btn.textContent = label
    btn.style.cssText = 'padding:2px 8px;border-radius:5px;border:1px solid #4b5563;' +
      'background:#1f2937;color:#e5e7eb;font:11px/1.4 inherit;cursor:pointer'
    btn.addEventListener('click', function () {
      try {
        onClick.call(btn)
      } catch (e) {
        console.error('[chat] 横条按钮失败:', e)
      }
    })
    parent.appendChild(btn)
    return btn
  }

  // ---- 自己验一遍，再把官网的脚本放行 ----
  //
  // 官网这两只脚本是「跨域 + crossorigin + integrity」：浏览器要先过一道 CORS 校验才肯执行，
  // 而校验没过时它除了"拒绝执行"什么都不告诉你。这里把浏览器那一步换成自己做：
  //   1. 逐只重取字节、自己算 sha384，和 HTML 里写的一字不差才继续 —— 有一只对不上就整体放弃；
  //   2. 把 body 还原成 `_sriCk` 动手之前的样子（它连 `<div id="root">` 一起删了，不还原的话
  //      官网的界面没有地方可挂）；
  //   3. **以内联方式注入**脚本本体，不插 `<script src>`。
  //
  // 第 3 条是 2026-10-14 实测之后改的，也是这版最要紧的一处：原先插的是 `<script src>`，
  // 结果和官网原来那两只一样，请求在 2 毫秒内被挡掉（HTTP 0、0 字节）。
  // **被挡的是"这个页面去发起一次子元素资源请求"这件事本身**，而同一个页面自己发 `fetch`
  // 拿得到 200 和正确的字节（诊断里那两遍重取就是证据）。所以绕开的办法不是换个人来发请求，
  // 是**别请求**：fetch 回文本 → 自己验哈希 → 塞进 `<script>` 的 textContent 注进去。
  // 内联脚本不发任何请求，也就没有"被挡"这回事。
  //
  // 样式同理（`<link rel=stylesheet>` 也是元素请求，同样一个字节都没拿到 —— 实测撞见过一次
  // "脚本灌进去了、界面也出来了，但一个样式都没有"）。所以样式也 fetch 回文本、插成 `<style>`，
  // 并且排在脚本前面，免得界面先裸奔一下再变好看。
  //
  // 顺序还是那个顺序：default-vendors 里有 main 依赖的运行时，所以严格按 HTML 里的先后注入。
  // 内联脚本按 appendChild 的次序当场同步执行，比原来靠 `async = false` 更靠得住。
  //
  // 这不是"绕过校验直接跑"：校验由我们自己做，而且只在**完全一致**时才注入；
  // 不一致就一个字都不放行。代价是这只脚本不再由浏览器的 SRI 把关，改为由这段代码把关。
  /**
   * 页面侧失败之后，还值不值得改走父窗那条路（js/repair.js）。
   * 不值得的两种：哈希对不上 —— 父窗取回来的是同样的字节，照样会拒，白跑一趟；
   * 以及压根没有脚本清单。其余失败恰恰都是"页面发不出这个请求"造成的，
   * 换父窗去发就绕开了那一层，值得再试。
   */
  function fallbackReason(reason) {
    return reason !== 'integrity' && reason !== 'noscripts'
  }

  /** 取一份文本（脚本或样式） */
  function fetchText(url) {
    return fetch(url, { cache: 'no-store', credentials: 'omit' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.arrayBuffer()
    })
  }

  function patchAndRun(scripts, styles, done) {
    if (!scripts || !scripts.length) {
      done({ ok: false, reason: 'noscripts', short: '没有可放行的脚本' })
      return
    }
    // 先把东西全取回来、全验过，再动 DOM —— 半截的官网比不动更难收拾。
    Promise.all(scripts.map(function (item) {
      return fetchText(item.src)
        .then(function (buf) {
          return crypto.subtle.digest('SHA-384', buf).then(function (digest) {
            return {
              src: item.src,
              source: new TextDecoder('utf-8').decode(buf),
              ok: 'sha384-' + toBase64(new Uint8Array(digest)) === item.expected,
              error: '',
            }
          })
        })
        .catch(function (e) {
          return { src: item.src, source: '', ok: false, error: String((e && e.message) || e) }
        })
    })).then(function (assets) {
      var bad = assets.filter(function (a) { return !a.ok })
      if (bad.length) {
        var unreachable = bad.filter(function (a) { return a.error })
        if (unreachable.length) {
          console.warn('[chat] 有脚本取不回来，改走父窗那条路:', unreachable[0].error)
          done({ ok: false, reason: 'fetch', short: '取不回来', long: unreachable[0].error })
          return
        }
        console.warn('[chat] 有脚本的哈希和官网 HTML 里写的不一致，放弃放行')
        done({ ok: false, reason: 'integrity', short: '哈希对不上，已放弃',
          long: '内容对不上就不能放行 —— 那才是真的降级。' })
        return
      }
      loadStyles(styles)
        .then(injectInline.bind(null, assets))
        .then(function (result) { done(result) })
        .catch(function (e) {
          console.warn('[chat] 取样式失败，改走父窗那条路:', e)
          done({ ok: false, reason: 'fetch', short: '取样式失败',
            long: String((e && e.message) || e) })
        })
    })
  }

  /** 把需要重取的样式取回来（按文档里的先后），取不到就整体交给父窗 */
  function loadStyles(styles) {
    var list = styles || []
    if (!list.length) return Promise.resolve([])
    return Promise.all(list.map(function (item) {
      return fetchText(item.href).then(function (buf) {
        return new TextDecoder('utf-8').decode(buf)
      })
    }))
  }

  /**
   * 注入：先样式、后脚本（按顺序，内联执行）。样式在 `injected` 里带进来是为了让
   * 上面那条"取不到就整体放弃"的规矩成立 —— 这里只管往页面里放。
   */
  function injectInline(assets, styles) {
    var restored = restoreBody()
    var sheets = 0
    ;(styles || []).forEach(function (text) {
      try {
        var style = document.createElement('style')
        style.textContent = text
        document.head.appendChild(style)
        sheets++
      } catch (e) {
        console.error('[chat] 注入样式失败:', e)
      }
    })

    var failed = 0
    assets.forEach(function (asset) {
      try {
        var el = document.createElement('script')
        // 不给 src：内联脚本不发请求，被挡的正是"发请求"那一步
        el.textContent = asset.source
        document.head.appendChild(el)
      } catch (e) {
        failed++
        console.error('[chat] 注入脚本失败:', e)
      }
    })

    return new Promise(function (resolve) {
      if (failed) {
        resolve({ ok: false, reason: 'load', short: '注入失败', long: failed + ' 只没能注入进去' })
        return
      }
      // 内联注入是同步的，没有 load 事件可等 —— 但"执行了"和"官网界面起来了"还是两件事
      // （脚本可能自己抛错，也可能要挂的那个 #root 早没了）。盯一眼再宣布成功。
      setTimeout(function () {
        var root = document.querySelector('#root')
        if (root && root.childElementCount > 0) {
          resolve({ ok: true, reason: 'ok', short: '已放行',
            long: (restored ? '（页面结构已还原' : '（没有需要还原的结构') +
              '，样式 ' + sheets + ' 份）' })
        } else {
          resolve({ ok: false, reason: 'empty', short: '放行了但界面没起来',
            long: '脚本执行了，官网界面却没挂上来（' + rootState() + '）；样式 ' + sheets + ' 份' })
        }
      }, 2500)
    })
  }

  /** 把 body 还原成官网那张错误图动手之前的样子 */
  function restoreBody() {
    try {
      var body = document.body
      if (!bodySnapshot || !body || !body.querySelector('._sri-ck')) return false
      body.innerHTML = bodySnapshot
      return true
    } catch (e) {
      console.error('[chat] 还原页面结构失败:', e)
      return false
    }
  }

  /** 把父窗那条路的结果写到报告框里（报告框不在了就只在控制台说话） */
  var repairNote = ''

  function setRepairNote(text) {
    repairNote = text
    try {
      var box = document.querySelector('[data-deepseek-helper="diag"]')
      if (!box) return
      // 报告已经被收成横条了（里面没有正文那个 <pre>）：这句话归那行标签去说
      // （见 collapseDiag），别往一条 flex 横条里再塞一个长 div。
      if (!box.querySelector('pre')) return
      var note = box.querySelector('[data-deepseek-helper="repair"]')
      if (!note) {
        note = document.createElement('div')
        note.setAttribute('data-deepseek-helper', 'repair')
        note.style.cssText = 'margin-top:8px;padding:6px 8px;border-radius:6px;' +
          'background:#1e3a5f;color:#dbeafe;white-space:pre-wrap'
        box.appendChild(note)
      }
      note.textContent = text
    } catch (e) {
      console.error('[chat] 写入修复结果失败:', e)
    }
  }

  // 父窗那条路（js/repair.js）要用的两个钩子。父窗手上没有 body 快照 ——
  // 那东西只有这里存过；它也没法"开口说话"，只能 executeJavaScript，
  // 所以入口得挂在 window 上等它来敲。挂的时候包 try/catch：
  // 这是别人家的页面，挂得上就挂，挂不上不能连累它。
  try {
    window.__dsHelper = {
      restoreBody: restoreBody,
      rootState: rootState,
      // 父窗来取现场记录用（面板上那个「复制对话窗现场记录」按钮）。
      // 走这条路是为了不依赖页面上的 DOM —— 报告框会随导航一起消失，这个接口不会。
      netReport: netReportText,
      showRepairResult: function (json) {
        var result
        try {
          result = typeof json === 'string' ? JSON.parse(json) : json
        } catch (e) {
          result = { ok: false, message: String(json) }
        }
        console.warn('[chat] 父窗侧的修复结果:', result && result.reason, result && result.message)
        sendQuiet('chat:trace', '父窗放行结果: ' + ((result && result.reason) || '?') + ' / ' +
          ((result && result.message) || '') + ' / #root 子节点 ' +
          ((result && result.rootChildren === undefined) ? '?' : result.rootChildren))
        if (result && result.ok) {
          setRepairNote('父窗侧已放行，官网界面挂上来了 ✓')
          setTimeout(collapseDiag, 2500)
          return
        }
        setRepairNote('父窗侧也没成：' +
          ((result && result.message) || (result && result.reason) || '未知原因'))
      },
    }
  } catch (e) {
    console.error('[chat] 挂 window.__dsHelper 失败（父窗那条路会走不通）:', e)
  }

  // 元素改道要**尽早**挂上：官网的脚本是运行中才注进去的，
  // 挂晚了就漏掉最早那几只（`/static/fp.min.js` 正是最早的那只）。
  // preload 跑在页面脚本之前，放在这里已经是最早的时机了。
  // 只在官网上挂：这层是"替官网把它自己想要的脚本取回来"，落地页、错误页那些地方
  // 没有这回事；而 shimUrlKind 只管 https，本来也够不着本地落地页。
  try {
    if (/^https:\/\/([a-z0-9-]+\.)*deepseek\.com$/i.test(location.origin)) installShim()
  } catch (e) {
    console.error('[chat] 判断要不要挂元素改道出错:', e)
  }

  // 官网那张错误图一上来就把 body 整个换掉，所以"body 原来长什么样"得在**它动手之前**存下来：
  // 挂在捕获阶段上，抢在同一只 script 自己的 onerror（也就是 _sriCk）前面跑。
  try {
    document.addEventListener('error', function (ev) {
      var el = ev && ev.target
      if (el && el.tagName === 'SCRIPT' && el.getAttribute('integrity')) snapshotBody()
    }, true)
  } catch (e) {
    console.error('[chat] 注册脚本加载失败监听出错:', e)
  }

  try {
    window.addEventListener('DOMContentLoaded', rescue)
    window.addEventListener('load', rescue)
  } catch (e) {
    console.error('[chat] 注册资源校验监听失败:', e)
  }

  // 探针的第二个触发点：登录页那种"界面正常、只是个别脚本没加载成"的情况不会走到 rescue，
  // 但元素失败的记录已经在了 —— 等页面安静下来再跑，别跟官网自己的重试抢时间。
  // （runProbe 自己带"一份文档只跑一次"的闩，两条触发路径撞上也不会跑两遍。）
  try {
    window.addEventListener('DOMContentLoaded', function () {
      setTimeout(function () {
        try { if (elFails.length) runProbe() } catch (e) {}
      }, 1800)
    })
  } catch (e) {
    console.error('[chat] 注册探针定时器失败:', e)
  }
})()

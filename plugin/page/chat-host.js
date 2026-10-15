// DeepSeek 悬浮助手 —— 对话窗宿主页的逻辑
//
// 官网活在 chat.html 的 <webview> 里，这个文件是它的操作台。一共四件事：
//   1. 把 webview 送到官网去（UA 去掉 Electron 标记；地址优先用上次那个会话）
//   2. 每次导航完，把当前地址报回父窗 —— 父窗决定"这个地址值不值得记"
//   3. 窗口被缩放时把尺寸报回父窗 —— 父窗落库，下次开窗按它开
//   4. 接住父窗发来的提问（选中文字 → 提问/翻译/总结…）：粘进官网输入框，该发送就发送
//
// 跟 uTools 打交道的部分一件都不在这里：这个页面用的是 page/chat-preload.js 挂出来的
// window.chatHost（跟球页用 window.ballHost 是同一个路子），页面上不直接碰 utools 全局。
//
// 反过来，父窗找这个页面只用一条路：win.webContents.executeJavaScript()。为了让那条路
// 一定敲得着，对外入口挂在 window.dsChat 上（页面自己的全局，不走 preload）。

(function () {
  'use strict'

  // 官网首页。"没有记住的会话时去哪儿"只有宿主页知道（父窗那边只管判断哪个地址值得记），
  // 所以这个常量就落在这一处；tools/check.js 里有一条断言盯着它别和父窗认可会话的域名走偏。
  var SITE = 'https://chat.deepseek.com/'
  var SIGN_IN_PATH = '/sign_in'

  // 官网的 DOM 钩子。这几条是从参考插件（JinkoWu 的 DeepSeek）那儿原样搬来的实测可用值，
  // 官网改版会让它们失效 —— 那时表现是"文字粘不进去"或"点了不发送"，先看这里。
  var SEL_INPUT = 'textarea'
  var SEL_SEND = 'input[type=file][multiple] + div[role=button]'

  // 选中文字那几条指令，注入前给文字加的引子（参考插件的措辞）。
  var PREFIX = {
    translate: '请翻译下面内容: ',
    genvarname: '变量取名: ',
    summarize: '总结下面内容: ',
    summarizeUrl: '总结这个网页的内容: ',
  }

  // 这个窗口会话里"已经进到应用里过"的标记。用来区分两种回到登录页的原因：
  //   重启 uTools（sessionStorage 空）→ 该把令牌写回去、自动登录；
  //   刚点了登出（标记在）→ 什么都不做，否则用户永远登不出去。
  var SESSION_FLAG = 'dsChatSeenApp'

  var host = window.chatHost
  var webview = document.querySelector('webview')
  var fallback = document.getElementById('fallback')
  var fbTitle = document.getElementById('fbTitle')
  var fbMsg = document.getElementById('fbMsg')

  var pageReady = false     // 官网界面已经画出来、可以操作了
  var pendingAsk = null     // 还没送出去的提问（父窗来得比页面早就先记在这儿）
  var readyTimer = null
  var restoreTried = false  // "写回令牌并重载"在这个窗口里只试一次，防刷新循环

  function showFallback(title, message) {
    fbTitle.textContent = title
    fbMsg.textContent = message
    fallback.classList.add('show')
  }

  if (!host) {
    showFallback('插件没加载起来', '对话窗的 preload 没跑起来，重新进一次插件试试。')
    return
  }

  // 这一条是防"静默白屏"的：uTools 各版本对 webPreferences 的透传没有文档保证，
  // 万一 webviewTag 没给，页面上就只是一个空元素 —— 那种白屏最难查。
  if (!webview || typeof webview.executeJavaScript !== 'function') {
    showFallback('这个环境里开不了内置网页',
      '对话窗依赖 <webview>，当前 uTools 版本没把它给出来。')
    return
  }

  // ------------------------------------------------------------ 跟官网说话

  /**
   * 在官网页面里执行一段表达式，返回它的值。
   *
   * 一律用 try 包住：官网改版、元素还没出来这些情况都会抛，
   * 而 preload / executeJavaScript 抛出去只会污染别人家页面的控制台。
   * （try 语句的完成值就是它最后一条语句的值，所以表达式照常带得回来。）
   */
  function run(js) {
    try {
      return webview.executeJavaScript('try {' + js + '} catch (e) { console.error(e) }')
    } catch (e) {
      return Promise.resolve(undefined)
    }
  }

  function sleep(ms) {
    return new Promise(function (ok) { setTimeout(ok, ms) })
  }

  /** 官网界面出来了没有：认发送按钮在不在（输入框和它一起渲染出来） */
  function isPageReady() {
    return run('!!document.querySelector(' + JSON.stringify(SEL_SEND) + ')')
      .then(function (v) { return v === true })
      .catch(function () { return false })
  }

  /**
   * 官网正在生成回答吗。
   *
   * 判据是"输入框空着 + 发送按钮却可点"：生成期间那个按钮会变成"停止"，一直是可点的；
   * 而空闲时它只有输入框里**有字**才可点。只认"按钮可点"会误判 —— 用户打着草稿时
   * 我们一上来就点一下，等于替他把草稿发出去了。（这个更严的条件是参考插件的作者
   * 在早先那版 ubrowser 实现里用的。）
   */
  function isGenerating() {
    return run('(function () {' +
      ' var i = document.querySelector(' + JSON.stringify(SEL_INPUT) + ');' +
      ' var b = document.querySelector(' + JSON.stringify(SEL_SEND) + ');' +
      ' return !!(b && !(i && i.value && i.value.length) &&' +
      ' b.getAttribute("aria-disabled") === "false") })()')
      .then(function (v) { return v === true })
      .catch(function () { return false })
  }

  function focusInput() {
    return run('(function () { var i = document.querySelector(' + JSON.stringify(SEL_INPUT) + ');' +
      ' if (!i) return false; i.focus(); i.select(); return true })()')
  }

  function clickSend() {
    return run('(function () { var b = document.querySelector(' + JSON.stringify(SEL_SEND) + ');' +
      ' if (!b) return false; b.click(); return true })()')
  }

  /**
   * 把一段文字送进官网的输入框。
   *
   * 用"复制 + Ctrl/Cmd+V"而不是直接给输入框赋值：官网的输入框是受控组件，
   * 直接改 value 不会触发它自己的状态更新 —— 字看着在里面，发送按钮还是灰的。
   * 这一招也是参考插件试出来的。
   */
  function setInputValue(text) {
    host.copyText(text)
    // 粘贴是往系统里注入按键，窗口得在眼前、输入框得是焦点，否则就粘到别的窗口去了
    try { webview.focus() } catch (e) { /* 焦点拿不到就继续试，键盘注入那一步会告诉我们成没成 */ }
    return focusInput().then(function () {
      host.tapPaste()
    })
  }

  /**
   * 执行一次提问。data 是 uTools 传进来的进入动作：
   * { code, payload, type }，code 是 plugin.json 里那条 feature。
   */
  function doAsk(data) {
    var code = data && data.code
    var text = (data && data.payload) || ''
    var shouldSend = true

    if (text) {
      if (PREFIX[code]) text = PREFIX[code] + text
      else if (code !== 'ask') {
        // 不认识的动作：只开窗，不往里塞东西
        text = ''
        shouldSend = false
      }
    } else {
      // 光带了个"打开"的意思：把光标放进输入框就够了
      shouldSend = false
    }

    return isGenerating().then(function (busy) {
      // 正在生成就先停掉，否则新消息只会被官网排队，看着像"发了没反应"
      if (!busy) return
      return clickSend().then(function () { return sleep(200) })
    }).then(function () {
      if (!text) return focusInput()
      return sleep(200).then(function () {
        return setInputValue(text)
      }).then(function () {
        if (!shouldSend) return undefined
        return sleep(500).then(clickSend)
      })
    }).catch(function (e) {
      console.error('[chat] 执行提问失败:', e)
    })
  }

  /**
   * 父窗的入口（它用 executeJavaScript 敲这里）。
   * 页面还没就绪就先记下 —— 父窗那边注入得比官网加载快是常态。
   */
  function ask(data) {
    if (pageReady) return doAsk(data)
    pendingAsk = data
    start()
    return Promise.resolve()
  }

  window.dsChat = { ask: ask, isPageReady: isPageReady }

  // ------------------------------------------------------------ 登录令牌

  function readPath() {
    return run('location.pathname')
  }

  function readPageToken() {
    return run('localStorage.getItem("userToken")')
  }

  function writePageToken(token) {
    return run('localStorage.setItem("userToken", ' + JSON.stringify(String(token)) + ')')
  }

  function seenAppInSession() {
    try { return sessionStorage.getItem(SESSION_FLAG) === '1' } catch (e) { return false }
  }

  function markAppInSession() {
    try { sessionStorage.setItem(SESSION_FLAG, '1') } catch (e) { /* 记不上就退化成"每次重启都可能多登一次" */ }
  }

  /**
   * 把登录态在"官网的 localStorage"和"插件自己的存储"之间对一遍。
   *
   * 为什么需要：uTools 建出来的自定义窗口用的是非持久化会话，Cookie / localStorage
   * 只活在内存里，uTools 一退出就没了 —— 重启后官网只会把人送回登录页。
   * 参考插件的办法是把官方存在 localStorage 的令牌镜像一份，下次开窗写回去，实测有效。
   *
   * @returns {Promise<boolean>} true 表示刚触发了重载（调用方这次就别再往里塞提问了）
   */
  function syncToken() {
    return readPath().then(function (path) {
      if (path !== SIGN_IN_PATH) {
        // 已经进到应用里了：把令牌存一份，下次重启靠它免登录
        markAppInSession()
        return readPageToken().then(function (now) {
          if (now && now !== host.readToken()) host.writeToken(now)
          return false
        })
      }

      var saved = host.readToken()
      if (!saved) return false

      if (seenAppInSession()) {
        // 这个会话里明明登录进去过，又回到登录页 —— 是用户点了登出（或令牌过期）。
        // 这时把旧令牌塞回去就等于"登不出去"，所以反过来把它丢掉。
        host.clearToken()
        return false
      }

      return readPageToken().then(function (current) {
        if (current || restoreTried) return false
        restoreTried = true
        return writePageToken(saved).then(function () {
          try {
            webview.reload()
          } catch (e) {
            console.error('[chat] 写回令牌后重载失败:', e)
          }
          return true
        })
      })
    }).catch(function (e) {
      console.error('[chat] 处理登录令牌时出错（不影响使用）:', e)
      return false
    })
  }

  // ------------------------------------------------------------ 页面状态机

  function onPageReady() {
    pageReady = true
    syncToken().then(function (reloading) {
      // 刚从登录页写回令牌、正在重载：等下一轮 did-stop-loading，
      // 挂起的提问那时再执行（重载会把这个页面里的状态清掉，但 pendingAsk 在这儿留着）。
      if (reloading || !pendingAsk) return
      var data = pendingAsk
      pendingAsk = null
      return doAsk(data)
    }).catch(function (e) {
      console.error('[chat] 页面就绪后的处理出错:', e)
    })
  }

  /** 等官网把界面画出来（官网是 SPA，did-stop-loading 之后还要一会儿才渲染完） */
  function start() {
    if (readyTimer) return
    var tries = 0
    readyTimer = setInterval(function () {
      tries++
      if (tries > 100) {
        // 10 秒还没就绪就不再轮询了：可能是网络慢，也可能是官网改版。
        // 界面照常留着，用户自己刷新比我们在这儿空转强。
        clearInterval(readyTimer)
        readyTimer = null
        return
      }
      isPageReady().then(function (ready) {
        if (!ready) return
        clearInterval(readyTimer)
        readyTimer = null
        onPageReady()
      })
    }, 100)
  }

  /** 把当前地址报回父窗（父窗决定记不记） */
  function reportUrl() {
    var url = ''
    try { url = webview.getURL() } catch (e) { url = '' }
    if (url) host.send('chat:url', url)
  }

  // ------------------------------------------------------------ 挂上事件

  function boot() {
    // UA 去掉 Electron 标记：官网（以及它背后的 WAF）不需要知道这是 Electron 里开的窗口。
    // 这一行是参考插件里的原样写法，替换后会多一个空格，无妨。
    try {
      webview.setAttribute('userAgent', navigator.userAgent.replace(/ Electron\/.*? /i, ' '))
    } catch (e) {
      console.error('[chat] 设置 UA 失败:', e)
    }

    webview.addEventListener('did-start-loading', function () {
      pageReady = false
    })

    webview.addEventListener('did-stop-loading', function () {
      fallback.classList.remove('show')
      start()
    })

    webview.addEventListener('did-fail-load', function (e) {
      // -3 是 ERR_ABORTED：点链接、重载这类正常操作也会报它，不能当成加载失败
      if (!e || e.isMainFrame === false || e.errorCode === -3) return
      showFallback('没能打开 DeepSeek',
        '这次加载失败了（' + (e.errorDescription || e.errorCode) + '）。重试一下，还不行就查查代理。')
    })

    webview.addEventListener('did-navigate', reportUrl)
    webview.addEventListener('did-navigate-in-page', reportUrl)

    // 窗口被缩放 → 报给父窗落库。第一次 resize 是窗口刚建出来时框架尺寸落定的那一下，
    // 不是用户改的，记下来会把默认尺寸当成用户的选择。
    var firstResize = true
    var sizeTimer = null
    window.addEventListener('resize', function () {
      if (firstResize) {
        firstResize = false
        return
      }
      clearTimeout(sizeTimer)
      sizeTimer = setTimeout(function () {
        host.send('chat:size', {
          width: Math.round(window.outerWidth),
          height: Math.round(window.outerHeight),
        })
      }, 400)
    })

    fallback.classList.remove('show')
    var target = host.readLastUrl() || SITE
    webview.setAttribute('src', target)
  }

  try {
    if (host.isDark()) document.documentElement.classList.add('dark')
  } catch (e) {
    // 拿不到就按浅色渲染
  }

  boot()

  // 开发时把官网那一侧的开发者工具直接开出来 —— 它就在 <webview> 里，
  // 光开窗口自己的 DevTools 是看不到官网的网络的。
  if (host.isDev()) {
    setTimeout(function () {
      try { webview.openDevTools() } catch (e) { console.error('[chat] 打开 webview 开发者工具失败:', e) }
    }, 1500)
  }
})()

// DeepSeek 悬浮助手 —— 主面板交互
//
// 这个页面跑在 uTools 搜索框主窗口里，和主 preload 共享同一个 window，
// 所以直接调 window.deepseekHost（preload 里挂上去的），不用走 ipc。

(function () {
  'use strict'

  var host = window.deepseekHost
  var dot = document.getElementById('ballDot')
  var stateText = document.getElementById('ballState')
  var toggleBtn = document.getElementById('ballToggleBtn')
  var chatBtn = document.getElementById('chatBtn')
  var sizeWidth = document.getElementById('sizeWidth')
  var sizeHeight = document.getElementById('sizeHeight')
  var sizeHint = document.getElementById('sizeHint')
  var hotkeyValue = document.getElementById('hotkeyValue')
  var hotkeyHint = document.getElementById('hotkeyHint')

  // preload 没挂上（加载失败、被别的插件顶掉）时给个能看懂的提示，
  // 而不是让所有按钮点下去毫无反应。
  if (!host) {
    stateText.textContent = '插件未正确加载，请重新进入一次'
    dot.classList.remove('on')
    return
  }

  var lastState = null

  function fmt(size) {
    return size.width + ' × ' + size.height
  }

  function render(state) {
    if (!state) return
    lastState = state

    var on = !!state.ballRunning && !!state.ballVisible
    dot.classList.toggle('on', on)
    if (on) {
      stateText.textContent = '悬浮球正在桌面显示'
    } else if (state.ballVisible) {
      stateText.textContent = '悬浮球已开启，但当前没有显示'
    } else {
      stateText.textContent = '悬浮球已关闭'
    }
    toggleBtn.textContent = state.ballVisible ? '隐藏悬浮球' : '显示悬浮球'
    chatBtn.textContent = state.chatOpen ? '关闭对话' : '打开对话'

    // 只回填"没在输入的那个"框：用户正敲着数字时被改写是最招人烦的交互。
    // 点「应用」时按钮会拿走焦点，所以那会儿两个框都能正常回填成夹取后的真实值。
    if (document.activeElement !== sizeWidth) sizeWidth.value = state.chatSize.width
    if (document.activeElement !== sizeHeight) sizeHeight.value = state.chatSize.height

    sizeHint.textContent = '默认 ' + fmt(state.chatSizeDefault) + '（手机比例），最小 ' +
      fmt(state.chatSizeMin) + '，再大也不会超出屏幕。' +
      (state.chatOpen ? '对话窗正开着，改动下次开窗生效（它是 uTools 的浏览器窗口，改不了正在开的那个）。'
        : '改动下次开窗生效。')

    // 快捷键。uTools 自己管着系统级注册，面板只负责显示"现在配的是哪个键"，
    // 点「设置」跳去它那边配（面板里没法直接抓按键组合）。
    hotkeyValue.textContent = state.hotkey || '未设置'
    hotkeyValue.classList.toggle('none', !state.hotkey)
    hotkeyHint.textContent = state.hotkey
      ? '按 ' + state.hotkey + ' 把对话窗叫到跟前（没开就打开，藏着或被盖住就摆到最前）。' +
        '快捷键只负责叫出来、不会关窗 —— 关窗点悬浮球，或用对话窗自己的关闭按钮。'
      : '在 uTools 的全局快捷键里给「' + (state.hotkeyCmd || 'DeepSeek窗口') +
        '」这条指令绑一个键，就能随时把对话窗叫出来 —— 点「设置」直接跳过去。'
  }

  /** 读两个输入框。填的不是正整数就返回 null，让调用方提示并回填 */
  function readSize() {
    var w = parseInt(String(sizeWidth.value).trim(), 10)
    var h = parseInt(String(sizeHeight.value).trim(), 10)
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null
    return { width: w, height: h }
  }

  function applySize() {
    var size = readSize()
    if (!size) {
      sizeHint.textContent = '尺寸要填正整数，宽度和高度的单位是像素。'
      return
    }
    // host 会把值夹进合法范围再落库，回填的 state 就是真正生效的大小
    render(host.setChatSize(size.width, size.height))
  }

  var ACTIONS = {
    chat: function () { return host.toggleChat() },
    ballToggle: function () { return host.toggleBall() },
    resetPos: function () { return host.resetBallPos() },
    applySize: applySize,
    resetSize: function () { return host.resetChatSize() },
    // 只读显示，改不了按键 —— 点了就往 uTools 的全局快捷键设置跳
    hotkey: function () { return host.openHotkeySetting() && host.state() },
  }

  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-act]') : null
    if (!el) return
    var fn = ACTIONS[el.getAttribute('data-act')]
    if (!fn) return
    try {
      var result = fn()
      // 开关对话窗那几颗是异步的（对话窗是 uTools 自己的浏览器窗口），返回的是 Promise<state>；
      // 其余是同步的，直接就是 state。两条都接住。
      if (result && typeof result.then === 'function') {
        result.then(function (state) {
          if (state) render(state)
        }, function (err) {
          console.error('[panel] 操作失败:', el.getAttribute('data-act'), err)
        })
        return
      }
      if (result) render(result)
    } catch (err) {
      console.error('[panel] 操作失败:', el.getAttribute('data-act'), err)
    }
  })

  // 尺寸框里按回车就等于点「应用」。先 blur 再应用 —— 让 render 能把夹取后的
  // 真实值回填进去（否则那个框还在焦点里，会被当成"用户正在输入"而跳过）。
  function onSizeKeydown(e) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    e.target.blur()
    try {
      applySize()
    } catch (err) {
      console.error('[panel] 应用尺寸失败:', err)
    }
  }

  sizeWidth.addEventListener('keydown', onSizeKeydown)
  sizeHeight.addEventListener('keydown', onSizeKeydown)

  // 悬浮球被隐藏/显示、对话窗被开/关之后，面板上的状态要跟着变
  host.onChange(render)

  // 点「设置」会跳到 uTools 的全局快捷键页面，那边配完再回来时窗口重新拿到焦点。
  // 快捷键是 uTools 存的，不重读一次的话，用户配完回来看到的还是"未设置"。
  window.addEventListener('focus', function () {
    try {
      render(host.state())
    } catch (e) {
      // 拿不到就保持原样，不值得打断面板
    }
  })

  // 跟随 uTools 的深浅色，避免深色主题下白底刺眼
  try {
    if (utools.isDarkColors()) document.documentElement.classList.add('dark')
  } catch (e) {
    // 拿不到就按浅色渲染
  }

  // plugin.json 里已经设了 pluginSetting.height，这里再兜一次：
  // 万一那个高度被改小，面板会被挤压出一堆滚动条。
  host.setPanelHeight(680)

  render(host.state())
})()

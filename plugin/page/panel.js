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
  var hotkeySetBtn = document.getElementById('hotkeySetBtn')
  var utoolsHotkeyBtn = document.getElementById('utoolsHotkeyBtn')

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

    // 全局快捷键：插件自己注册（Windows 的 RegisterHotKey），不依赖 uTools 的快捷键页 ——
    // uTools 那边设不了 Ctrl+Space 这类组合。面板这边负责显示状态和"按一下改键"。
    renderHotkey(state)
  }

  function renderHotkey(state) {
    var spec = state.hotkey || ''
    hotkeyValue.textContent = spec || '未设置'
    hotkeyValue.classList.toggle('none', !spec)

    var st = state.hotkeyState || {}
    if (capturing) {
      hotkeyHint.textContent = '现在按下你要用的组合键（要带 Ctrl / Alt / Shift / Win 里的至少一个），Esc 取消。'
      return
    }
    if (st.state === 'unsupported') {
      hotkeyHint.textContent = '⚠ 用不了：' + (st.message || '这个环境不支持') +
        '。插件会退回用 uTools 的快捷键（下面那个入口）。'
      return
    }
    if (st.state === 'fail') {
      hotkeyHint.textContent = '⚠ 没注册上：' + (st.message || '') +
        '。多半是这个名字被别的程序占着（Ctrl+Space 在 Windows 上默认归输入法的中英切换），换一个试试。'
      return
    }
    hotkeyHint.textContent = '插件自己注册的系统级热键，按一下开/关对话窗（和点悬浮球一样）。' +
      '插件被 uTools 回收后它会有最多一分钟的空档 —— 插件每分钟会把自己拉回来；' +
      '在 uTools 设置里关掉这个插件的「自动结束」就不会有空档。'
    utoolsHotkeyBtn.textContent = state.utoolsHotkey
      ? 'uTools 那边还绑着 ' + state.utoolsHotkey + '（也可以点这里改）'
      : '也可以在 uTools 的快捷键设置里给「' + (state.hotkeyCmd || 'DeepSeek窗口') + '」绑一个键'
  }

  // ---- 按键捕获：面板里直接按下组合键来设热键 ----

  var capturing = false

  // e.key → 小助手的键名（helper/hotkey.cs 里那张表对得上）
  var KEY_NAMES = {
    ' ': 'Space',
    Enter: 'Enter',
    Tab: 'Tab',
    Escape: 'Esc',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  }

  function keyNameOf(e) {
    var key = e.key
    if (KEY_NAMES[key]) return KEY_NAMES[key]
    if (/^[a-zA-Z]$/.test(key)) return key.toUpperCase()
    if (/^[0-9]$/.test(key)) return key
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key
    if ('-=[]\\;\',./`'.indexOf(key) !== -1) return key
    return null
  }

  function startCapture() {
    capturing = true
    hotkeySetBtn.textContent = '按组合键…'
    renderHotkey(lastState || {})
  }

  function stopCapture() {
    capturing = false
    hotkeySetBtn.textContent = '改键'
  }

  function onCaptureKeydown(e) {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stopCapture()
      if (lastState) renderHotkey(lastState)
      return
    }
    // 只按修饰键不算数
    if (['Control', 'Alt', 'Shift', 'Meta'].indexOf(e.key) !== -1) return

    var name = keyNameOf(e)
    if (!name) {
      hotkeyHint.textContent = '这个键不认：「' + e.key + '」，换一个（字母、数字、F1-F24、方向键都行）。'
      return
    }
    if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      // 不带修饰键的话就是个全局单键，会把那个键从所有程序手里抢走 —— 不做
      hotkeyHint.textContent = '要带 Ctrl / Alt / Shift / Win 里的至少一个，否则会把「' + name +
        '」这个键从所有程序手里抢走。'
      return
    }
    var parts = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push('Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Win')
    parts.push(name)
    var spec = parts.join('+')

    stopCapture()
    try {
      render(host.setHotkey(spec))
    } catch (err) {
      console.error('[panel] 设置快捷键失败:', err)
      hotkeyHint.textContent = '设置失败：' + ((err && err.message) || err)
    }
  }

  document.addEventListener('keydown', onCaptureKeydown, true)

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
    // 改键：进入"按一下组合键"的捕获状态，真正的注册在 preload 里（见 js/hotkey.js）
    hotkeySet: function () {
      startCapture()
      return undefined
    },
    hotkeyReset: function () {
      stopCapture()
      return host.clearHotkey()
    },
    // uTools 那条：只显示 + 跳过去设置（插件改不了它的绑定）
    utoolsHotkey: function () { return host.openHotkeySetting() && host.state() },
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

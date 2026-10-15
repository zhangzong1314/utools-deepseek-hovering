// DeepSeek 悬浮助手 —— 对话窗宿主页的 preload
//
// 分工：页面（page/chat-host.js）只管 DOM 和 <webview>，跟 uTools 打交道的都收在这里，
// 挂成 window.chatHost 给页面用 —— 和球页的 page/ball-preload.js 一个路子。
//
// 这个 preload 有一件以前做不到的事：**它能 require 我们的模块**（宿主页是插件自己的
// 本地页，窗口从头到尾都在插件目录里）。旧版那个 preload 会跟着窗口跑到官网上去执行，
// 所以连一句 require 都不敢写，存储键名只能两边各写一份。现在存储只有一个来源。

const config = require('../js/config')

window.chatHost = {
  isDev() {
    try {
      return !!utools.isDev()
    } catch (e) {
      return false
    }
  },

  isDark() {
    try {
      return !!utools.isDarkColors()
    } catch (e) {
      return false
    }
  },

  /** 上次打开的那个会话地址（没有就是 null，页面会退回官网首页） */
  readLastUrl() {
    return config.getLastChatUrl()
  },

  // ---- 登录令牌：官网 localStorage 里那份的镜像 ----
  // 自定义窗口的会话不落盘，重启 uTools 后官网会把人送回登录页，
  // 靠这份镜像把令牌写回去免掉重新登录（详见 page/chat-host.js 的 syncToken）。

  readToken() {
    return config.getUserToken()
  },

  writeToken(token) {
    config.setUserToken(token)
  },

  clearToken() {
    config.clearUserToken()
  },

  /** 把文字放进剪贴板（页面用它 + 粘贴把文字送进官网输入框，绕开受控组件） */
  copyText(text) {
    try {
      utools.copyText(text)
      return true
    } catch (e) {
      console.error('[chat] 写剪贴板失败:', e)
      return false
    }
  },

  /** 在当前焦点处按下粘贴。往系统里注入按键，所以调用前窗口得在眼前 */
  tapPaste() {
    try {
      utools.simulateKeyboardTap('v', utools.isMacOS() ? 'command' : 'ctrl')
      return true
    } catch (e) {
      console.error('[chat] 模拟粘贴失败:', e)
      return false
    }
  },

  /** 报给父窗（主 preload）。方向是"子 → 父"，父窗那边用 ipcRenderer.on 收 */
  send(channel, payload) {
    try {
      utools.sendToParent(channel, payload)
    } catch (e) {
      console.error('[chat] 上报失败:', channel, e)
    }
  },
}

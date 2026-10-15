// DeepSeek 悬浮助手 —— 悬浮球窗口的 preload
//
// 球窗是 uTools 自定义窗口，跟主窗口不是一个进程：
//   父 → 子：父窗 win.webContents.send(channel)，这里 ipcRenderer.on 收（见 host.shown/menu/menuClose）
//   子 → 父：utools.sendToParent(channel, payload)，父窗主 preload 收
//
// 这里在模块顶层注册监听是安全的：每个球窗都有自己的渲染进程，窗口销毁时监听
// 跟着进程一起消失，不存在主 preload 那种"重复注册"的隐患。

const { ipcRenderer } = require('electron')

window.ballHost = {
  /** 窗口已经显示出来了，可以播入场动画 */
  shown(callback) {
    ipcRenderer.on('ball:shown', () => callback())
  },

  /** 父窗算好了菜单该摆在哪，把几何信息和菜单项发过来 */
  menu(callback) {
    ipcRenderer.on('ball:menu', (_event, data) => callback(data))
  },

  /** 父窗要求收起菜单（窗口已经被缩回去了），球页只需把菜单擦掉 */
  menuClose(callback) {
    ipcRenderer.on('ball:menuClose', () => callback())
  },

  send(channel, payload) {
    utools.sendToParent(channel, payload)
  },

  /**
   * 当前鼠标的屏幕坐标（DIP）。拖拽时靠轮询它来跟住光标 ——
   * 只靠 mousemove 的话，光标一旦快过窗口就会甩出窗口外，事件断流、球停在半路。
   * 拿不到就返回 null，球页会退回用事件自带的 screenX/screenY。
   */
  cursorPoint() {
    try {
      const p = utools.getCursorScreenPoint()
      if (p && typeof p.x === 'number' && typeof p.y === 'number') return p
    } catch (e) {
      // 某些 uTools 版本可能不向自定义窗口暴露这个 API，不是错误，走退路即可
    }
    return null
  },
}

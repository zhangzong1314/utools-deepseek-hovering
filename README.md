# DeepSeek 悬浮助手（uTools 插件）

桌面悬浮球，单击打开 `https://chat.deepseek.com/` 对话，用官网账号登录；选中文字可以直接
丢给 DeepSeek 提问 / 翻译 / 取名 / 总结。关窗再开还落在上次那个会话。

**这一版的对话窗是照着参考实现做的**：本地宿主页里放一个 `<webview>` 装官网
（窗口开 `webSecurity:false`、`webviewTag:true`，UA 里的 ` Electron/xx` 去掉），
官网的一切操作都走 `webview.executeJavaScript`。参考实现是 JinkoWu 的 DeepSeek 插件
（`%APPDATA%\uTools\plugins\0f861bd274af36c0404df213d00e1096.asar`），同一台机器上实测能
把官网正常打开。

上一版走的是另一条路（窗口自己顶层导航到官网 + 一套 SRI 诊断/修复机制），遇到过官网脚本
加载不起来、只弹「页面资源加载异常」的问题。那一版整个留在 `_archive/` 里，没删。

## 目录结构

```
plugin/            ← 插件根目录：uTools 加载/打包的都是这个目录
  plugin.json        插件元信息与功能声明（7 条指令）
  preload.js         主 preload：入口分派、悬浮球 IPC、面板桥 window.deepseekHost
  index.html         主面板（uTools 搜索框里显示）
  page/chat.html     对话窗宿主页：一个 <webview> + 兜底界面
  page/chat-host.js  宿主页逻辑：送 webview 去官网、回报地址/尺寸、执行提问、同步登录令牌
  page/chat-preload.js  宿主页的 preload：把 config 与剪贴板/粘贴挂成 window.chatHost
  page/ball.html     悬浮球页面（右键菜单、拖拽）
  page/ball-preload.js  悬浮球窗的 preload
  page/panel.js      主面板交互
  js/config.js       配置读写（utools.dbStorage，唯一碰存储的地方）
  js/windows.js      悬浮球窗与对话窗的创建/复用/拖拽/尺寸/会话地址策略
  assets/logo.png    插件图标（由 tools/gen-icons.js 按 whale.svg 生成）
  assets/whale.svg   官网图标（favicon 的鲸鱼路径）
tools/             ← 开发自检用，不进插件包
  check.js           静态检查 + 用桩件跑一遍 preload 与宿主页
  gen-icons.js       由 whale.svg 生成 logo.png（PNG 里带源路径指纹）
_archive/          ← 上一版（顶层导航 + SRI 诊断/修复）的存档，只作对照，不参与加载
```

**`plugin.json` 为什么放在子目录里**：uTools 是拿 `plugin.json` 所在的目录当插件根来加载和打包的，
整个目录会被一起读进去。放项目根目录的话，`tools/`、`_archive/` 这些会跟着进插件包。

## 在 uTools 里调试

1. uTools → 右上角头像 → **开发者工具** → 新建/加载项目。
2. 路径选到本仓库的 **`plugin`** 目录（不是仓库根目录）。
3. 回主搜索框输入 `deepseek`（或 `ds`、`深度求索`、`ai对话`、`悬浮球`）回车 → 出现主面板，桌面上出现悬浮球。

## 打包

用 uTools 开发者工具自带的打包功能，打包对象同样是 **`plugin`** 目录。本项目不带打包脚本。

打包器会自己重写 `plugin.json`（`pluginName`/`author` 取自表单，另补 `platform`/`name` 等字段），
并且**换掉插件 id** —— 而 dbStorage 的目录名就是那个 id。所以"开发者工具加载"和"装包运行"两边
各存一份配置（悬浮球位置、窗口大小、记住的会话、登录令牌镜像），验收打包版时要在安装版里重设一次。

## 用法

| 操作 | 结果 |
| --- | --- |
| 单击悬浮球 | 对话窗关着就打开，开着就收起来（窗口不销毁，再开是一瞬间） |
| 按住悬浮球拖动 | 移动位置，松手记住，重启还在原处 |
| 右键悬浮球 | 菜单：打开/关闭对话、隐藏悬浮球 |
| 面板「打开对话」 | 同上；面板里还能显示/隐藏悬浮球、把它放回右下角 |
| 面板「对话窗大小」 | 填宽高点「应用」；窗口开着就立刻变，关着就下次按新尺寸开 |
| 面板「全局快捷键」 | 显示当前绑定，点「设置」跳到 uTools 快捷键页去配 |

**快捷键是"三态"的**：窗口没开就打开；开着但被别的窗口盖住，先调到最前面；已经就在最前面，
再按一下才收起。这和"点球就是开关"是刻意不同的 —— 按键盲操时，第一下要是把用户正想看的窗口
关掉就太别扭了。插件自己没有注册系统级热键的 API，键是 uTools 管的（`getCmdHotKey` 只读、
`redirectHotKeySetting` 只跳转，都不会替你创建绑定）。

**选中文字时**，uTools 的划词菜单里会有：向deepseek提问/搜索、找deepseek翻译、变量取名、
总结内容；剪贴板/选中的是网址时还有「总结网页内容」。点一下就开窗、把文字粘进输入框并发送。
这几条指令都带了 `mainHide`，不会闪主面板。

**记住上次的会话**：对话窗每次导航都把地址报给父窗，只有 `chat.deepseek.com/a/chat/s/<id>`
这种会话地址会被记住（hash 剥掉、查询串保留）；回到对话首页就忘掉；登录页、站外地址一律不碰。

**登录态**：uTools 的自定义窗口用的是内存会话（Cookie/localStorage 不落盘，重启就没了），
所以宿主页把官网存在 `localStorage` 里的 `userToken` 镜像一份到插件存储：进到应用里就存一份，
下次开窗如果落在登录页且没有页面令牌，就写回去并重载一次。用户点登出时会把这个镜像丢掉，
不会出现"登不出去"。

## 已知限制

- **这个窗口关不掉，只能藏起来。** 点球/快捷键是 `hide()`（窗口留着，登录态和正在打的字都在）。
  用窗口右上角的 × 关掉的话，uTools 不保证能拦住（自定义窗口没有可用的 close 拦截 API），
  窗口被销毁 → 下次开窗重建 → 靠上面的令牌镜像自动登录，但页面上没发出去的内容会丢。
- **`webSecurity: false` 是有代价的**：这个窗口里的官网页面不再受同源策略保护。影响面只有
  对话窗这一个窗口（它只装 chat.deepseek.com），不波及 uTools 其它窗口和面板。参考实现也是这么做的。
- **悬浮球靠插件进程存活。** uTools 主窗口隐藏后，插件默认会在几分钟内被回收，球会一起消失 ——
  再搜一次 `deepseek` 回车就回来了，或在 uTools 设置里关掉插件的自动结束。
- **官网改版会让"粘贴/发送"失效。** 页面里的 DOM 钩子（`textarea`、
  `input[type=file][multiple] + div[role=button]`）是照参考实现抄的实测值，
  官网一改版就得跟着改 `page/chat-host.js` 顶部那两个常量。
- **登录令牌是明文存在插件自己的存储里的**（`utools.dbStorage` 里的 `deepseek:userToken`）。
  它在 `%APPDATA%\uTools\database\<插件id>\` 下，和浏览器存 Cookie 是同一类东西；
  不想要的话，删掉这条记录就等于"下次重新登录"。
- **图标是 DeepSeek 的**，商标权归 DeepSeek。自己用没问题，往插件市场发布建议换掉。
- **对话窗如果显示「插件没加载起来」**，说明宿主页没拿到 preload 挂的 `window.chatHost`
  （preload 没跑，或者这个 uTools 版本给窗口开了 `contextIsolation`，那是另一个 JS 世界、页面看不见
  preload 挂的全局）。退路很直接：让 `page/chat-host.js` 自己用 `utools` 全局
  （`utools.dbStorage` / `utools.copyText` / `utools.simulateKeyboardTap` / `utools.sendToParent`）——
  参考实现就是这么用的。那时 `js/config.js` 就不能复用了，键名要在页面里再写一份。

## 开发时能跑的自检

```bash
npm run check     # plugin.json / 语法 / 本地引用 / 几处字面量绑定 / 图标指纹 + 桩件跑一遍链路
npm run icons     # 照着 assets/whale.svg 重新生成 assets/logo.png
```

`check.js` 会用桩件真跑 `preload.js`（进入插件 → 开球 → 点球开关对话窗 → 选中文字提问 →
地址/尺寸回流 → 快捷键三态），再把 `page/chat-host.js` 放进假 DOM 里跑一遍（UA 去掉 Electron、
src 初始值、导航与缩放上报、提问的粘与发、登录令牌的取回/写回/丢弃）。GUI 里点不出来的
低级错误基本能在这儿拦住；GUI 里才看得出来的（官网到底渲染没渲染、粘贴落在哪）只能人工过：
**开发者工具加载 `plugin/` → 点球 → 看官网界面正常（不是「页面资源加载异常」那张图）→ 登录 →
选中文字试一条指令 → 缩放窗口 → 关掉重开看尺寸与会话 → 完全退出 uTools 重启再看登录态。**

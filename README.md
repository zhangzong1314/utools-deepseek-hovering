# DeepSeek 悬浮助手（uTools 插件）

桌面悬浮球，单击打开 `https://chat.deepseek.com/` 对话，用官网账号登录；选中文字可以直接
丢给 DeepSeek 提问 / 翻译 / 取名 / 总结。关窗再开还落在上次那个会话。

**对话窗用的是 uTools 自带的浏览器**（`utools.ubrowser`，uTools 文档里的"内置浏览器"）。
这不是一开始的设计，是实测逼出来的，顺序记在这儿免得以后重走一遍：

| 试过的做法 | 结果 |
| --- | --- |
| 让自建窗口自己顶层导航到官网 | 官网那两只带 `integrity` + `crossorigin` 的脚本加载不起来（请求 0 字节结束），官网弹「页面资源加载异常」 |
| 自建窗口里放 `<webview>` 装官网（照 JinkoWu 的 DeepSeek 插件那套） | 页面上拿到的只是个空元素：uTools 构造插件窗口时只把 `webPreferences.preload` 透给 Electron，`webviewTag` 没这一项（uTools 自己的类型定义里 `webPreferences` 也只声明了 `preload`） |
| **uBrowser**（现在这版） | 官网正常渲染；而且它的会话是**持久化**的（`%APPDATA%\uTools\Partitions\<插件id>.ubrowser` 真落盘），登录态和页面存储重启都在 |

代价是这一层只能用 uTools 给的那套链式 API（`goto` / `wait` / `focus` / `paste` / `evaluate` /
`show` / `hide` / `run`），**没有窗口实例可拿**：窗口在不在只能问 `utools.getIdleUBrowsers()`，
它给的也只有 id / 地址 / 标题 / 宽高 / 坐标 —— 没有"可见性"，也没有"在不在最前面"。

## 目录结构

```
plugin/            ← 插件根目录：uTools 加载/打包的都是这个目录
  plugin.json        插件元信息与功能声明（7 条指令）
  preload.js         主 preload：入口分派、悬浮球 IPC、面板桥 window.deepseekHost
  index.html         主面板（uTools 搜索框里显示）
  page/ball.html     悬浮球页面（右键菜单、拖拽）
  page/ball-preload.js  悬浮球窗的 preload
  page/panel.js      主面板交互
  js/config.js       配置读写（utools.dbStorage，唯一碰存储的地方）
  js/windows.js      悬浮球窗 + 对话窗（uBrowser 那一套）的创建/复用/拖拽/尺寸/会话地址策略
  assets/logo.png    插件图标（由 tools/gen-icons.js 按 whale.svg 生成）
  assets/whale.svg   官网图标（favicon 的鲸鱼路径）
tools/             ← 开发自检用，不进插件包
  check.js           静态检查 + 用桩件跑一遍 preload 的链路
  gen-icons.js       由 whale.svg 生成 logo.png（PNG 里带源路径指纹）
_archive/          ← 更早两版（顶层导航 + SRI 诊断/修复、webview 宿主页）的存档，不参与加载
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
并且**换掉插件 id** —— 而 uBrowser 的会话分区和 dbStorage 的目录名都是那个 id。也就是说
"开发者工具加载"和"装包运行"两边各存一份：悬浮球位置、窗口大小、记住的会话、**登录态**都会分开，
验收打包版时要在安装版里重新登录、重设一次。

## 用法

| 操作 | 结果 |
| --- | --- |
| 单击悬浮球 | 对话窗藏着就摆出来，摆着就藏起来（藏起来那一页还在，再点是瞬间的事） |
| 按住悬浮球拖动 | 移动位置，松手记住，重启还在原处 |
| 右键悬浮球 | 菜单：打开/关闭对话、隐藏悬浮球 |
| 面板「打开对话」 | 同上；面板里还能显示/隐藏悬浮球、把它放回右下角 |
| 面板「对话窗大小」 | 填宽高点「应用」，**下次开窗生效**（uBrowser 改不了正在开的那个窗口） |
| 面板「全局快捷键」 | 显示当前绑定，点「设置」跳到 uTools 快捷键页去配 |

**快捷键只负责"把窗口叫到跟前"，不会关窗。** 上一版是"三态"（没开就开 / 被盖住就调到最前 /
已经在最前面才收起），第三态靠 `window.isFocused()` 判断 —— uBrowser 给不出焦点信息，那个判断
做不了了。盲操时第一下就把用户正想看的窗口关掉，比"多按一下没关掉"难受得多，所以定成
"只叫不关"：关窗点悬浮球、球上的右键菜单，或者对话窗自己的关闭按钮。
（插件自己没有注册系统级热键的 API，键是 uTools 管的：`getCmdHotKey` 只读、
`redirectHotKeySetting` 只跳转，都不会替你创建绑定。）

**选中文字时**，uTools 的划词菜单里会有：向deepseek提问/搜索、找deepseek翻译、变量取名、
总结内容；选中的是网址时还有「总结网页内容」。点一下就开窗、把文字贴进输入框并发送；
如果官网正在生成回答，会先替用户停掉（不然新消息只会被排队，看着像"发了没反应"）。
这几条指令都带了 `mainHide`，不会闪主面板。

**记住上次的会话**：每次跟对话窗打交道（开、关、送文字）都会从 uBrowser 给的窗口实例上把当前
地址收下来，只有 `chat.deepseek.com/a/chat/s/<id>` 这种会话地址会被记住（hash 剥掉、查询串保留）；
回到对话首页就忘掉；登录页、站外地址一律不碰。

**登录态不用管**：uBrowser 的会话是持久化的，登录一次就一直在（Cookie、localStorage 都落在
`%APPDATA%\uTools\Partitions\<插件id>.ubrowser\`）。想清空就删那个目录，或在 uTools 里清缓存。

## 已知限制

- **对话窗关不掉，只能藏起来**（程序化关窗 uBrowser 没给）。所以"关闭对话"实际是 hide：
  那一页还在，登录态、正在打的字、滚动位置都留着。
- **拿不到窗口的可见性和焦点**。"现在是开着还是藏着"由插件自己记在 `deepseek:chatShown` 里；
  用户用窗口自己的 × 关掉之后，`getIdleUBrowsers()` 里就没有它了，插件会当成"没开"，
  下次点球重新开一个（页面状态会重来，但登录态和上次的会话都还在）。
- **改不了正在开着的窗口的尺寸**，面板里的尺寸是"下次开窗生效"。
- **官网改版会让"粘贴/发送"失效。** 页面里的两个 DOM 钩子（`textarea`、
  `input[type=file][multiple] + div[role=button]`）是照参考实现抄的实测值，都在
  `js/windows.js` 顶上，官网一改版就得跟着改。
- **窗口是 uTools 的**，标题栏、右键菜单、开发者工具入口都是它那套；插件只能拿到它给的窗口信息。
- **图标是 DeepSeek 的**，商标权归 DeepSeek。自己用没问题，往插件市场发布建议换掉。

## 开发时能跑的自检

```bash
npm run check     # plugin.json / 语法 / 本地引用 / 几处字面量绑定 / 图标指纹 + 桩件跑一遍链路
npm run icons     # 照着 assets/whale.svg 重新生成 assets/logo.png
```

`check.js` 会用桩件真跑 `preload.js`：进入插件 → 开球 → 点球开关对话窗（断言 uBrowser 那条链上的
每一步：`goto` 去哪、`wait` 等什么、`paste` 贴了什么、`click` 点哪里）→ 送文字提问（五种引子各验一遍）→
地址与尺寸回流 → 快捷键只叫不关 → 面板改尺寸。uBrowser 的链式 API 在桩件里是"每步都记下来"的假实现，
所以链路有没有走对是能测的；测不了的是"官网到底渲染没渲染、文字有没有真的落到输入框里"——
那部分只能人工过：**开发者工具加载 `plugin/` → 点球 → 看官网界面正常 → 登录 → 选中文字试一条指令 →
关掉重开看会话与尺寸 → 完全退出 uTools 重启看登录态还在不在。**

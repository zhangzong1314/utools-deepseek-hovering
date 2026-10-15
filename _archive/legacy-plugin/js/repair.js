// DeepSeek 悬浮助手 —— "在 Node 侧把官网脚本取回来，验完哈希再灌进对话窗"
//
// 为什么需要这条路：对话窗里那两只官网脚本是「跨域 + crossorigin + integrity」，
// 浏览器肯不肯执行它们，得先过一道 CORS 校验。实测那次加载是 **HTTP 0、0 字节、耗时 1ms** ——
// 请求根本没发出去就被挡了，既不是网络问题也不是缓存问题（我们自己重新取回来的字节，
// 和 HTML 里写的 integrity 一模一样），更不是被换成了坏副本。
//
// 页面侧既然走不通，就换一边：Node 没有 CORS 这一层（也不受页面策略约束），
// 取回来的字节仍旧按官网 HTML 里写的那串 hash **逐个验过**，验过才算数；
// 然后把它直接灌进页面（webContents.executeJavaScript），全程不再经过 <script> 标签，
// 也就没有"这次请求被拒"这回事了。
//
// 安全边界要说清楚：**校验一点没少**，只是从"浏览器替我验"换成"我验完再交给浏览器执行"。
// 任何一只脚本验不过，就整体放弃、一个字都不注入 —— 宁可让用户继续看到报错，
// 也不能让来源不明的代码在他窗口里跑起来。
//
// 这个模块只依赖 Node 内置模块，且真正的"取"和"灌"是由调用方注入进来的
// （见 js/windows.js），所以 tools/check.js 能用假件把整条流水线跑一遍。

const https = require('https')
const zlib = require('zlib')

// 官网那两只脚本加起来约 2.5 MB；给到 32 MB 只是防"被喂一个无限流"，
// 正常情况差着两个数量级。
const MAX_BYTES = 32 * 1024 * 1024
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 30000

// CDN 会按 UA 挑响应（实测非浏览器 UA 会被限流），所以照浏览器带一份。
// Origin 写的是"这只脚本在页面里被请求时"的真实值 —— 那台 CDN 的
// access-control-allow-origin 是按它回显的（见 README 的「已知限制」）。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/132.0.6834.210 Safari/537.36'
const SITE_ORIGIN = 'https://chat.deepseek.com'

/**
 * 只认 sha384；别的算法（或写坏了的值）一律当"不认识"，不去猜。
 * integrity 属性允许写成好几个哈希（空格分开，浏览器会挑最强的那个），
 * 所以按空格拆开后取 sha384 那一段。
 */
function integrityHash(integrity) {
  const tokens = String(integrity || '').trim().split(/\s+/)
  for (const token of tokens) {
    const m = /^sha384-([A-Za-z0-9+/=]+)$/.exec(token)
    if (m) return m[1]
  }
  return null
}

function sha384Base64(buf) {
  return require('crypto').createHash('sha384').update(buf).digest('base64')
}

// 样式没有 integrity 可验（官网那只 <link> 上根本没写），所以只能用"只认这个域"来兜：
// 地址是从官网页面上读来的，但"读来的"不等于"可信"，该拦的还是要拦。
const CSS_HOST_RE = /(^|\.)deepseek\.com$/

/** 取回来的这一份，和官网 HTML 里写的 integrity 对得上吗 */
function verify(buf, integrity) {
  const expected = integrityHash(integrity)
  return !!expected && sha384Base64(buf) === expected
}

/** 服务器要是没听 Accept-Encoding 还是压了，就自己解开（不然哈希必然对不上） */
function decode(buf, encoding) {
  const enc = String(encoding || '').toLowerCase()
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
  if (enc === 'deflate') return zlib.inflateSync(buf)
  if (enc === 'br') return zlib.brotliDecompressSync(buf)
  return buf
}

/**
 * 取一只脚本的字节。只认 200；重定向跟着走（上限 5 跳）；大小和时长都有上限。
 * @returns {Promise<Buffer>}
 */
function fetchScript(url, redirects) {
  const hops = redirects || 0
  return new Promise(function (resolve, reject) {
    let parsed
    try {
      parsed = new URL(url)
    } catch (e) {
      reject(new Error('地址不合法: ' + url))
      return
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error('只走 https: ' + url))
      return
    }

    const req = https.get({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': BROWSER_UA,
        Origin: SITE_ORIGIN,
        Referer: SITE_ORIGIN + '/',
        Accept: '*/*',
        // 要原样字节：让服务器别压，省得还要解（真要压了 decode() 也接得住）
        'Accept-Encoding': 'identity',
      },
    }, function (res) {
      const status = res.statusCode || 0

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (hops >= MAX_REDIRECTS) {
          reject(new Error('重定向超过 ' + MAX_REDIRECTS + ' 跳'))
          return
        }
        resolve(fetchScript(new URL(res.headers.location, url).toString(), hops + 1))
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error('HTTP ' + status))
        return
      }

      const chunks = []
      let size = 0
      let done = false
      res.on('data', function (chunk) {
        if (done) return
        size += chunk.length
        if (size > MAX_BYTES) {
          done = true
          res.destroy()
          reject(new Error('响应超过 ' + MAX_BYTES + ' 字节，不收了'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', function () {
        if (done) return
        done = true
        let buf = Buffer.concat(chunks)
        try {
          buf = decode(buf, res.headers['content-encoding'])
        } catch (e) {
          reject(new Error('解压失败(' + res.headers['content-encoding'] + '): ' + e.message))
          return
        }
        resolve(buf)
      })
      res.on('error', function (e) {
        if (done) return
        done = true
        reject(e)
      })
    })

    req.setTimeout(TIMEOUT_MS, function () {
      req.destroy(new Error('请求超时(' + TIMEOUT_MS + 'ms)'))
    })
    req.on('error', reject)
  })
}

/**
 * 取回来 → 逐只验 → 还原页面结构 → 先补样式、再按顺序灌脚本 → 回读 #root 看界面到底挂上没有。
 *
 * 顺序上有个刻意的安排：**先把所有东西取完验完，再开始动 DOM**。否则第二只验不过时，
 * 第一只已经跑进去了 —— 那是个"半截的官网"，比干脆不动更难收拾。
 *
 * 样式排在脚本前面：官网那只 bundle 一渲染就拿不到样式的话，用户看到的是裸 HTML 闪一下，
 * 而"灌进去但没样式"这次已经实测撞上过一次了（`<link rel=stylesheet>` 和 `<script>` 一样
 * 是被"元素发请求"那条路挡掉的）。
 *
 * @param {{
 *   scripts: Array<{src: string, integrity: string}>,
 *   styles?: Array<{href: string}>,
 *   fetchScript: (url: string) => Promise<Buffer>,
 *   executeJavaScript: (code: string) => Promise<any>,
 *   insertCSS?: (css: string) => Promise<any>,
 * }} options 依赖由调用方注入，便于测试
 * @returns {Promise<{ok: boolean, reason: string, rootChildren?: number, message?: string}>}
 */
async function run(options) {
  const scripts = (options && options.scripts) || []
  if (!scripts.length) {
    return { ok: false, reason: 'noscripts', message: '没拿到脚本清单' }
  }
  const styles = (options && options.styles) || []

  const fetched = []
  for (const item of scripts) {
    let buf
    try {
      buf = await options.fetchScript(item.src)
    } catch (e) {
      return {
        ok: false,
        reason: 'fetch',
        message: '取不到 ' + item.src + '：' + ((e && e.message) || e),
      }
    }
    if (!verify(buf, item.integrity)) {
      return {
        ok: false,
        reason: 'integrity',
        message: '取回来的内容和官网 HTML 里写的哈希对不上，已放弃：' + item.src,
      }
    }
    fetched.push({ src: item.src, source: buf.toString('utf8') })
  }

  // 样式排在脚本前面注入（见上面的说明）。这里没有哈希可验，所以退一档：
  // 只认 https + `*.deepseek.com`，别的一律不注入。
  const sheets = []
  for (const item of styles) {
    let host = ''
    try {
      const parsed = new URL(item.href)
      if (parsed.protocol !== 'https:') throw new Error('不是 https')
      host = parsed.hostname
    } catch (e) {
      return { ok: false, reason: 'style', message: '样式的地址不合法，不注入：' + item.href }
    }
    if (!CSS_HOST_RE.test(host)) {
      return { ok: false, reason: 'style', message: '样式的地址不在 deepseek.com 下，不注入：' + item.href }
    }
    let buf
    try {
      buf = await options.fetchScript(item.href)
    } catch (e) {
      return {
        ok: false,
        reason: 'style',
        message: '取不到样式 ' + item.href + '：' + ((e && e.message) || e),
      }
    }
    sheets.push({ href: item.href, text: buf.toString('utf8') })
  }

  // 页面结构先搭回去：官网那张错误图是 document.body.replaceChildren(...) 换掉的，
  // 连 <div id="root"> 一起没了（官网的 body 就只有它一个节点），不还原的话界面没有地方可挂。
  // 这一步由页面自己做的原因是：body 原来的样子只有它手里那份快照（见 page/chat-preload.js）。
  //
  // 顺带记一条不那么明显的依赖：官网那只 bundle 是 webpack 打的，动态 chunk 的地址靠
  // `document.currentScript.src` 推，而 executeJavaScript 灌进去的代码没有 currentScript，
  // 于是退到"文档里最后一只 <script>"。好在官网页面上那两只 script 标签在 <head> 里
  // （_sriCk 只换 body，从不动 head），被 SRI 拒了之后仍然留在原地 —— 最后一只正是
  // main.js 那个带完整 CDN 地址的标签，所以退路算得出来。这跟还原 body 是两件事。
  await options.executeJavaScript('window.__dsHelper && window.__dsHelper.restoreBody()')

  for (const sheet of sheets) {
    await injectCSS(options, sheet)
  }

  for (const item of fetched) {
    await options.executeJavaScript(item.source)
  }

  // 别只听"没报错"：官网的界面真的挂上来了才算成。脚本跑完但不渲染
  // （少了运行时、DOM 被换过）是完全可能的。
  const rootChildren = await options.executeJavaScript(
    '(function(){var r=document.querySelector("#root");return r?r.childElementCount:-1})()')

  if (rootChildren > 0) {
    return { ok: true, reason: 'ok', rootChildren: rootChildren, styles: sheets.length }
  }
  return {
    ok: false,
    reason: 'empty',
    rootChildren: rootChildren,
    message: '脚本灌进去了，但官网界面没有挂上来（#root 子节点：' + rootChildren + '）',
  }
}

/** 把一份 CSS 灌进页面：优先用 Electron 的 insertCSS，没有就退到页内插一只 <style> */
async function injectCSS(options, sheet) {
  if (typeof options.insertCSS === 'function') {
    await options.insertCSS(sheet.text)
    return
  }
  // JSON.stringify 出来的就是一个合法的 JS 字符串字面量（CSS 里引号换行都有），
  // 所以这里一层就够 —— 跟 windows.js 里那个两遍不一样，那里嵌的是"字符串参数"。
  await options.executeJavaScript(
    '(function(){var s=document.createElement("style");s.textContent=' +
    JSON.stringify(sheet.text) + ';document.head.appendChild(s)})()')
}

module.exports = {
  MAX_BYTES,
  BROWSER_UA,
  CSS_HOST_RE,
  integrityHash,
  sha384Base64,
  verify,
  decode,
  fetchScript,
  injectCSS,
  run,
}

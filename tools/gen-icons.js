// 生成插件图标 —— 零依赖手写 PNG 编码器
//
// 本机没有 ImageMagick / sharp 之类的图形工具，也不想为了一张图拉 node_modules
// （插件根目录会被 uTools 整个加载，多一个依赖就多一份体积），所以直接按 PNG 规范
// 拼字节：IHDR + IDAT(zlib) + IEND，每个 chunk 自带 CRC32。
//
// 画的图形是**官网图标本身**：assets/whale.svg 里的鲸鱼路径（取自
// https://fe-static.deepseek.com/chat/favicon.svg）。所以这里除了 PNG 编码，
// 还得有一个小型的 SVG 路径栅格化器 —— 官方那条路径只用到 M / C / Z，
// 把它展平成多边形再按 nonzero 规则扫描线填充就够了。
// 用 3× 超采样再降采样来做抗锯齿，效果等同浏览器里的矢量渲染。
//
// 跑法：npm run icons

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const { crc32 } = require('./lib/crc32')

const ROOT = path.join(__dirname, '..')
const ASSETS = path.join(ROOT, 'plugin', 'assets')
const WHALE_SVG = path.join(ASSETS, 'whale.svg')
const OUT_PNG = path.join(ASSETS, 'logo.png')

const SIZE = 256
const SUPERSAMPLE = 3
// 鲸鱼在图标里占多大：留一圈边距，别贴着图片边缘
const WHALE_SCALE = 0.84
// 官网 favicon 的填充色
const BRAND = [0x4d, 0x6b, 0xfe]

// ---------------------------------------------------------------- PNG 编码

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crc])
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 长度 width*height*4，直通（非预乘）RGBA
 * @param {Array<[string, string]>} [texts] 要写进图里的 tEXt 元数据（解码器会忽略，见下面 FP_KEY）
 */
function encodePng(width, height, rgba, texts) {
  const stride = width * 4
  // 每行前面要加一个 filter 字节，这里一律用 0（None）
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x]
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: truecolor + alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // tEXt 得夹在 IHDR 和 IEND 之间；解码器一律忽略它，不影响图片本身
  const textChunks = (texts || []).map(([keyword, text]) =>
    chunk('tEXt', Buffer.concat([
      Buffer.from(keyword, 'latin1'),
      Buffer.from([0]),
      Buffer.from(text, 'latin1'),
    ])))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...textChunks,
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------- SVG 路径

const BEZIER_STEPS = 24

/**
 * 解析 SVG 的 d 属性，返回一串子路径（每段是若干点，已经闭合）。
 * 只实现官方图标用到的命令；遇到别的命令就抛错 —— 宁可生成失败，
 * 也不要静默画出一只畸形的鲸鱼。
 */
function parsePath(d) {
  const tokens = d.match(/[MmLlCcZzHhVv]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi)
  if (!tokens) throw new Error('路径是空的')

  const subpaths = []
  let current = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let i = 0

  const num = () => {
    const t = tokens[i++]
    if (t === undefined) throw new Error('路径数据不完整，数字用完了')
    const n = Number(t)
    if (!isFinite(n)) throw new Error('路径里出现了非数字: ' + t)
    return n
  }
  const lineTo = (nx, ny) => {
    if (!current) throw new Error('路径以非 M 命令开头')
    current.push({ x: nx, y: ny })
    x = nx
    y = ny
  }
  const curveTo = (c1x, c1y, c2x, c2y, ex, ey) => {
    if (!current) throw new Error('路径以非 M 命令开头')
    // 三次贝塞尔按固定步数采样。24 段对 50 单位的设计稿来说，肉眼已经看不出折线。
    for (let s = 1; s <= BEZIER_STEPS; s++) {
      const t = s / BEZIER_STEPS
      const mt = 1 - t
      const a = mt * mt * mt
      const b = 3 * mt * mt * t
      const c = 3 * mt * t * t
      const e = t * t * t
      current.push({ x: a * x + b * c1x + c * c2x + e * ex, y: a * y + b * c1y + c * c2y + e * ey })
    }
    x = ex
    y = ey
  }

  while (i < tokens.length) {
    const cmd = tokens[i++]
    switch (cmd) {
      case 'M':
      case 'm': {
        const nx = num()
        const ny = num()
        const px = cmd === 'm' ? x + nx : nx
        const py = cmd === 'm' ? y + ny : ny
        current = []
        subpaths.push(current)
        current.push({ x: px, y: py })
        x = startX = px
        y = startY = py
        break
      }
      case 'L':
      case 'l':
        lineTo(cmd === 'l' ? x + num() : num(), cmd === 'l' ? y + num() : num())
        break
      case 'H':
      case 'h': {
        const nx = num()
        lineTo(cmd === 'h' ? x + nx : nx, y)
        break
      }
      case 'V':
      case 'v': {
        const ny = num()
        lineTo(x, cmd === 'v' ? y + ny : ny)
        break
      }
      case 'C':
      case 'c': {
        const c1x = num()
        const c1y = num()
        const c2x = num()
        const c2y = num()
        const ex = num()
        const ey = num()
        if (cmd === 'c') curveTo(x + c1x, y + c1y, x + c2x, y + c2y, x + ex, y + ey)
        else curveTo(c1x, c1y, c2x, c2y, ex, ey)
        break
      }
      case 'Z':
      case 'z':
        if (current && current.length) current.push({ x: startX, y: startY })
        x = startX
        y = startY
        break
      default:
        throw new Error('暂不支持的 SVG 命令: ' + cmd + '（只用到 M/L/H/V/C/Z 就够）')
    }
  }

  return subpaths.filter((sp) => sp.length > 2)
}

/** 从 assets/whale.svg 读出路径数据 —— 图标和页面里的内联标记共用同一份。 */
function readWhalePath() {
  const svg = fs.readFileSync(WHALE_SVG, 'utf8')
  const m = svg.match(/<path[^>]*\sd="([^"]+)"/)
  if (!m) throw new Error('在 ' + path.relative(ROOT, WHALE_SVG) + ' 里没找到 <path d="…">')
  const viewBox = svg.match(/viewBox="([^"]+)"/)
  const box = viewBox ? viewBox[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 50, 50]
  if (box.length !== 4 || box.some((n) => !isFinite(n)) || !box[2] || !box[3]) {
    throw new Error('viewBox 读不出来: ' + (viewBox ? viewBox[1] : '(没有)'))
  }
  return { d: m[1], subpaths: parsePath(m[1]), box }
}

// 图片里嵌一份"我是照哪条路径画的"的指纹。
// 没有它的话，改了 whale.svg 却忘了重跑 npm run icons，logo.png 会一直是旧图而没人发现 ——
// 这种错在 GUI 里表现为"图标没变"，很难联想到是忘了跑脚本。
const FP_KEY = 'deepseek-whale'

function whaleFingerprint(d) {
  return crypto.createHash('sha256').update(d).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- 栅格化

/**
 * 把多边形填成一张 size×size 的布尔掩码（坐标已经映射到像素空间）。
 *
 * 用扫描线 + nonzero 缠绕规则，和 SVG 的默认 fill-rule 一致：
 * 逐行求出所有边的交点，按 x 排序，边走边累加方向（向上 +1 / 向下 -1），
 * 缠绕数不为 0 的区段算在图形内部。鲸鱼的 4 个子路径靠这条规则合成
 * （眼睛那种"挖洞"的效果正是缠绕数抵消出来的）。
 *
 * 逐行求交是 O(行数 × 边数)，比逐像素判断快两个数量级 —— 超采样后有几百万个采样点。
 */
function fillPolygons(polygons, size) {
  const mask = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    const py = y + 0.5
    const crossings = []
    for (const poly of polygons) {
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[j]
        const b = poly[i]
        if (a.y === b.y) continue
        // 半开区间 [min, max)，保证顶点只算一次，缝合线不会漏
        if (py < Math.min(a.y, b.y) || py >= Math.max(a.y, b.y)) continue
        crossings.push({ x: a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y), dir: b.y > a.y ? 1 : -1 })
      }
    }
    if (!crossings.length) continue
    crossings.sort((p, q) => p.x - q.x)

    let winding = 0
    for (let k = 0; k < crossings.length - 1; k++) {
      winding += crossings[k].dir
      if (winding === 0) continue
      const from = Math.max(0, Math.ceil(crossings[k].x - 0.5))
      const to = Math.min(size - 1, Math.floor(crossings[k + 1].x - 0.5))
      for (let x = from; x <= to; x++) mask[y * size + x] = 1
    }
  }
  return mask
}

/** 把设计稿坐标映射到 size×size 的像素空间，等比居中 */
function mapToBox(subpaths, box, size, scale) {
  const unit = (size * scale) / Math.max(box[2], box[3])
  const originX = (size - box[2] * unit) / 2 - box[0] * unit
  const originY = (size - box[3] * unit) / 2 - box[1] * unit
  return subpaths.map((sp) => sp.map((p) => ({ x: originX + p.x * unit, y: originY + p.y * unit })))
}

function renderLogo(whale, size) {
  const S = size * SUPERSAMPLE
  const mask = fillPolygons(mapToBox(whale.subpaths, whale.box, S, WHALE_SCALE), S)

  const samples = SUPERSAMPLE * SUPERSAMPLE
  const out = new Uint8Array(size * size * 4)
  for (let sy = 0; sy < S; sy++) {
    const ty = (sy / SUPERSAMPLE) | 0
    for (let sx = 0; sx < S; sx++) {
      if (!mask[sy * S + sx]) continue
      const slot = (ty * size + ((sx / SUPERSAMPLE) | 0)) * 4
      // 只画鲸鱼本身，背景透明：这就是官网 favicon 的样子。
      // 超采样下每个子像素可能是"鲸鱼的半透明边缘"，alpha 累计出覆盖率即可。
      out[slot] = BRAND[0]
      out[slot + 1] = BRAND[1]
      out[slot + 2] = BRAND[2]
      out[slot + 3] = Math.min(255, out[slot + 3] + Math.round(255 / samples))
    }
  }
  return out
}

// ---------------------------------------------------------------- 自检
//
// 图片是二进制，肉眼看不出来"文件合法但画错了"（全透明、只有半只鲸鱼……）。
// 所以写完立刻自己解一遍：CRC、尺寸、IDAT 能不能解、不透明像素占多大。

let failures = 0

function check(cond, msg, detail) {
  if (cond) console.log('  ✓ ' + msg)
  else {
    failures++
    console.error('  ✗ ' + msg + (detail ? ' —— ' + detail : ''))
  }
  return !!cond
}

function inspectPng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('PNG 签名不对')

  // 顺着 chunk 走一遍：顺便校验每个 chunk 的 CRC，比只看文件头靠谱
  const chunks = []
  const text = {}
  let offset = 8
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + len)
    const crc = buf.readUInt32BE(offset + 8 + len)
    if (crc32(buf.subarray(offset + 4, offset + 8 + len)) !== crc) throw new Error(type + ' chunk CRC 校验失败')
    if (type === 'tEXt') {
      const sep = data.indexOf(0)
      if (sep > 0) text[data.toString('latin1', 0, sep)] = data.toString('latin1', sep + 1)
    }
    chunks.push({ type, data })
    offset += 12 + len
  }

  const ihdr = chunks.find((c) => c.type === 'IHDR')
  const idat = chunks.find((c) => c.type === 'IDAT')
  if (!ihdr || !idat) throw new Error('缺少 IHDR 或 IDAT')
  if (chunks[chunks.length - 1].type !== 'IEND') throw new Error('最后一个 chunk 不是 IEND')

  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  if (ihdr.data[8] !== 8 || ihdr.data[9] !== 6) {
    throw new Error('位深/颜色类型不对: ' + ihdr.data[8] + '/' + ihdr.data[9])
  }

  // IDAT 必须能解出来，且解压后正好是 height 行、每行 1+width*4 字节
  const raw = zlib.inflateSync(idat.data)
  const expected = (width * 4 + 1) * height
  if (raw.length !== expected) throw new Error('IDAT 解压后是 ' + raw.length + ' 字节，应为 ' + expected)

  // 顺便数一下不透明像素：全透明或全实的图大概率是画错了，
  // 这种错误光看"文件合法"是发现不了的。
  let opaque = 0
  for (let i = 0; i < raw.length; i += width * 4 + 1) {
    for (let x = 0; x < width; x++) if (raw[i + 1 + x * 4 + 3] > 8) opaque++
  }

  return { width, height, bytes: buf.length, chunks: chunks.length, opaque, text }
}

function main() {
  fs.mkdirSync(ASSETS, { recursive: true })
  const whale = readWhalePath()
  const fingerprint = whaleFingerprint(whale.d)
  const png = encodePng(SIZE, SIZE, renderLogo(whale, SIZE), [[FP_KEY, fingerprint]])
  fs.writeFileSync(OUT_PNG, png)

  const info = inspectPng(png)
  check(info.text[FP_KEY] === fingerprint,
    '图片里存的路径指纹和本次画的一致: ' + fingerprint)

  const ratio = info.opaque / (info.width * info.height)
  console.log('已生成 ' + path.relative(ROOT, OUT_PNG) +
    '  ' + info.width + '×' + info.height + '  ' + info.bytes + ' 字节')
  console.log('  鲸鱼占图面积 ' + (ratio * 100).toFixed(1) + '%（用来确认画的不是空白/整块实心）')
  console.log('  源路径指纹 ' + fingerprint + '（tools/check.js 会拿它核对图片是否最新）')
  if (ratio < 0.05 || ratio > 0.8) {
    console.error('  面积比例不正常，路径映射八成出问题了')
    process.exit(1)
  }
  if (failures) process.exit(1)
}

main()

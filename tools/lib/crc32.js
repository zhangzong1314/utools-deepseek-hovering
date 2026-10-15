// CRC-32（IEEE 802.3 多项式 0xedb88320）
//
// PNG 的每个 chunk 和 ZIP 的每个条目都要它，gen-icons.js 与 lib/zip.js 共用这一份。

const TABLE = (function () {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

module.exports = { crc32 }

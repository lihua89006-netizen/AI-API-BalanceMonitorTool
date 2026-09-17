// 背景图取样（零依赖）：解析 public/background.png（PNG truecolor+alpha），
// 在指定画布坐标区间统计「不透明覆盖率 + 平均亮度」，用于给挂件元素选落点。
// 用法：node probe/bg-sample.cjs [x0 x1 y0 y1 step]（坐标为 308 画布坐标）
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const file = path.join(process.cwd(), 'public', 'background.png')
const buf = fs.readFileSync(file)

// —— 最小 PNG 解析：只处理 IHDR + IDAT（非隔行，8bit，colorType 6/2）——
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
let off = 8
let width = 0, height = 0, bitDepth = 0, colorType = 0
const idat = []
while (off < buf.length) {
  const len = buf.readUInt32BE(off)
  const type = buf.toString('ascii', off + 4, off + 8)
  const data = buf.subarray(off + 8, off + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0); height = data.readUInt32BE(4)
    bitDepth = data[8]; colorType = data[9]
    if (data[12] !== 0) throw new Error('不支持隔行 PNG')
  } else if (type === 'IDAT') idat.push(data)
  else if (type === 'IEND') break
  off += 12 + len
}
if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
  throw new Error(`不支持的格式：bitDepth=${bitDepth} colorType=${colorType}`)
}
const bpp = colorType === 6 ? 4 : 3
const raw = zlib.inflateSync(Buffer.concat(idat))
const stride = width * bpp
const out = Buffer.alloc(height * stride)
// 逐行反滤波（PNG 五种滤波器）
const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
for (let y = 0; y < height; y++) {
  const ft = raw[y * (stride + 1)]
  const src = y * (stride + 1) + 1
  const dst = y * stride
  const prev = dst - stride
  for (let x = 0; x < stride; x++) {
    const v = raw[src + x]
    const a = x >= bpp ? out[dst + x - bpp] : 0
    const b = y > 0 ? out[prev + x] : 0
    const c = y > 0 && x >= bpp ? out[prev + x - bpp] : 0
    let r
    switch (ft) {
      case 0: r = v; break
      case 1: r = v + a; break
      case 2: r = v + b; break
      case 3: r = v + ((a + b) >> 1); break
      case 4: r = v + paeth(a, b, c); break
      default: throw new Error('未知滤波器 ' + ft)
    }
    out[dst + x] = r & 0xff
  }
}

const CANVAS = 308
const scale = width / CANVAS
const px = (cx, cy) => {
  const x = Math.min(width - 1, Math.max(0, Math.round(cx * scale)))
  const y = Math.min(height - 1, Math.max(0, Math.round(cy * scale)))
  const i = y * stride + x * bpp
  const r = out[i], g = out[i + 1], bl = out[i + 2]
  const alpha = bpp === 4 ? out[i + 3] : 255
  return { lum: Math.round((r * 299 + g * 587 + bl * 114) / 1000), alpha }
}

// —— 统计文字列（left 2% 宽 84% → 画布 x 6.2~264.9）在 y 区间内的不透明覆盖率与平均亮度 ——
const argv = process.argv.slice(2)

// 模式 map：整张画布的不透明图（每格 = cell×cell 画布 px 的平均 alpha），用于选落点看角色轮廓
if (argv[0] === 'map') {
  const cell = Number(argv[1] || 8)
  const legend = ' .:-=+*#%@'
  console.log(`不透明图（每格 ${cell}×${cell} 画布 px；legend "${legend}" 由透明→不透明；列标为画布 x）`)
  let header = '     '
  for (let cx = 0; cx < CANVAS; cx += cell) header += cx % 64 === 0 ? '|' : ' '
  console.log(header)
  for (let cy = 0; cy < CANVAS; cy += cell) {
    let line = String(cy).padStart(4) + ' '
    for (let cx = 0; cx < CANVAS; cx += cell) {
      let n = 0
      let sum = 0
      for (let dy = 0; dy < cell; dy += 2) {
        for (let dx = 0; dx < cell; dx += 2) {
          sum += px(cx + dx, cy + dy).alpha
          n++
        }
      }
      const avg = sum / n
      line += legend[Math.min(legend.length - 1, Math.round((avg / 255) * (legend.length - 1)))]
    }
    console.log(line)
  }
  process.exit(0)
}

const [x0 = 6, x1 = 265, y0 = 134, y1 = 190, step = 3] = argv.map(Number)
console.log(`图 ${width}x${height}  画布换算 scale=${scale.toFixed(3)}`)
console.log(`扫描：x=${x0}~${x1}  y=${y0}~${y1}  step=${step}`)
console.log('   y | 不透明占比 | 平均亮度 | 亮度范围')
for (let cy = y0; cy <= y1; cy += step) {
  let n = 0, solid = 0, sum = 0, lmin = 255, lmax = 0
  for (let cx = x0; cx <= x1; cx++) {
    const { lum, alpha } = px(cx, cy)
    n++
    if (alpha >= 128) solid++
    sum += lum
    if (lum < lmin) lmin = lum
    if (lum > lmax) lmax = lum
  }
  console.log(
    `${String(cy).padStart(4)} | ${((solid / n) * 100).toFixed(1).padStart(9)}% | ${(sum / n).toFixed(1).padStart(8)} | ${lmin}~${lmax}`,
  )
}

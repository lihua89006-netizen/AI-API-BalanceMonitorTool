/* ══════════════════════════════════════════════════════════════════════════
 * 开发期量测探针（仅由 vite serve 注入，不进生产构建、不改动 src/ 业务代码）
 *
 * 目的：把「挂件滚轮缩放的抖动」从主观观感变成可比较的数字。
 * 手段：
 *   ① 视觉夹具：把挂件内容临时换成纯色块 + 锚点标记点
 *      —— 纯色块便于屏幕捕获时精确定位窗口实际渲染边界；
 *      —— 标记点画在「滚轮锚点」对应的画布坐标上，理想情况下它在整个
 *         手势中屏幕位置应当纹丝不动（这正是鼠标焦点缩放的验收标准）。
 *   ② 合成真实滚轮事件驱动缩放（走 App 真实 wheel handler 代码路径）。
 *   ③ 逐帧（rAF）采样：窗口内部尺寸、画布实际 transform、resize 事件计数、
 *      screenX/screenY 等 —— 用于判断「内容层是否与窗口层同帧一致」。
 *   ④ 结果 POST 回 vite 中间件落盘，供离线分析。
 *
 * 触发：轮询 GET /__aqm/trigger（内容来自 probe/trigger.json），run 号变化即执行一轮。
 * ══════════════════════════════════════════════════════════════════════════ */

const CANVAS_BASE = 308

/**
 * 通用元素量测（2026-09/15 新增）：触发计划里给 `measure: ['.theme-opt', ...]` 时，
 * 回传这些选择器的 **viewport 坐标几何 + 文字 + 是否折行 + 是否溢出视口**。
 * 用途：核对设置页这类**非挂件**界面的排版（主题按钮组与壁纸下拉是否同一行、
 * 有没有把「跟随系统」挤到第二行、按钮组有没有超出主窗口宽度）——没有图像输入能力时，
 * 用矩形数据替代眼睛看（与布局报告同一思路，见交接文档 §4.10）。
 * 主窗口与挂件窗口都会执行；选择器量不到就返回空数组。
 */
function measureElements(selectors: string[]) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return selectors.map((sel) => {
    const nodes = Array.from(document.querySelectorAll(sel)) as HTMLElement[]
    return {
      sel,
      count: nodes.length,
      items: nodes.slice(0, 12).map((el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return {
          // 表单元素的当前值：textContent 读不到 input.value，故优先读 value；
          // 但 <button> 也有 value（默认空串）会盖住按钮文字 → 仅对真正的输入类元素用 value
          text: (() => {
            const tag = el.tagName
            const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
            const raw = isField ? (el as HTMLInputElement).value : el.textContent
            return (raw ?? '').toString().trim().slice(0, 40)
          })(),
          x: +r.left.toFixed(1),
          y: +r.top.toFixed(1),
          w: +r.width.toFixed(1),
          h: +r.height.toFixed(1),
          // 类名（2026-09/16 加）：用于核对"某个样式是否被改掉"这类无几何差异的改动
          // （如"导出按钮不要蓝色" = 类名里不再有 primary），光看矩形看不出来。
          // ⚠️ 必须走 getAttribute('class')：SVG 元素的 `className` 是 SVGAnimatedString 对象，
          // 直接 toString 只会得到 "[object SVGAnimatedString]"，拿 lucide-* 类名验证图标就失效了。
          cls: (el.getAttribute('class') ?? '').slice(0, 60),
          // 折行/溢出判定：scrollWidth > clientWidth 说明内容被压缩换行或截断
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
          fontSize: cs.fontSize,
          // 字重与颜色（2026-09/16 加）：核对"字体统一/颜色一致"这类改动的硬指标。
          // 只看字号会漏掉"字重 400 vs 600"这种差异（本轮"设置标题统一成高级设置那种"就是差字重）。
          fontWeight: cs.fontWeight,
          color: cs.color,
          visible: r.width > 0 && r.height > 0,
          inViewport: r.left >= 0 && r.top >= 0 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
        }
      }),
    }
  })
}

/**
 * 通用点击（2026-09/16 新增）：触发计划里给 `click: ['.switch', ...]` 时，按顺序依次处理：
 * ①等该选择器出现（最多 2s，便于"点 A 打开弹窗、再点弹窗里的 B"这种串联）
 * ②点它的第一个匹配元素 ③等过渡结束（CSS transition 0.18s → 260ms）→ 再处理下一个。
 * 用途：验证交互控件的**两态**几何、以及"点一下是否真的切换了"，而不是只看静态布局。
 * 回传每项的 `before`（点击前的 aria-checked / class，用来前后对照）。
 * 主窗口与挂件窗口都支持（挂件侧 2026-09/16 补：此前只有主窗口接，量挂件菜单面板时点不开）。
 */
async function clickElements(selectors: string[]) {
  const done: { sel: string; found: boolean; before: string }[] = []
  for (const sel of selectors) {
    let el: HTMLElement | null = null
    for (let i = 0; i < 20; i++) {
      el = document.querySelector(sel) as HTMLElement | null
      if (el) break
      await sleep(100)
    }
    if (!el) {
      done.push({ sel, found: false, before: '' })
      continue
    }
    const before = el.getAttribute('aria-checked') ?? el.className
    el.click()
    done.push({ sel, found: true, before })
    await sleep(260)
  }
  return done
}

/** 每轮把挂件归位到固定屏幕坐标。
 *  ⚠️ 必须做：鼠标焦点缩放必然让窗口向左上漂移（窗口左上角 = P0 + m(1-k)），
 *  连续多轮后挂件就会跑出屏幕捕获区域 → 量到的方块是**被裁剪**的，整批数据失真
 *  （本项目实测踩过：一批样本全部贴在捕获区域左上角，得到完全错误的结论）。 */
async function normalizePos(x: number, y: number) {
  try {
    const { getCurrentWindow, LogicalPosition } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setPosition(new LogicalPosition(x, y))
  } catch (e) {
    console.warn('[probe] 位置归位失败（继续）', e)
  }
}

/** 每轮量测前把挂件归一到基线尺寸（否则上一轮结束时的尺寸会污染下一轮基准）。
 *  直接走 Rust 的 widget_set_bounds（就是滚轮缩放用的那个命令），前端的滚轮手势
 *  状态在每次手势首帧会重新读 innerWidth，因此归一不会污染被测代码路径。 */
async function normalizeSize(target: number) {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__
  if (!internals?.invoke) return
  try {
    await internals.invoke('widget_set_bounds', {
      mouseX: 0,
      mouseY: 0,
      targetW: target,
      targetH: target,
      first: true,
    })
  } catch (e) {
    console.warn('[probe] 归一尺寸失败（继续）', e)
  }
}

interface ProbePlan {
  run: number
  notches: number
  deltaY: number
  gapMs: number
  anchorFx: number
  anchorFy: number
  paint: boolean
  settleMs: number
  posX?: number
  posY?: number
}

interface Sample {
  t: number
  iw: number
  ih: number
  cs: number
  rw: number
  rl: number
  rt: number
  sx: number
  sy: number
  nres: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 布局报告：把画布内各元素的几何（换算回 308 画布坐标）+ 背景图对应位置的亮度采样回传。
 *  用途：无法用眼睛看截图时，仍能客观核对"某个元素加在哪、压在什么背景上"。 */
async function layoutReport(
  canvas: HTMLElement,
  plan?: { setWillChange?: string; realLayout?: boolean; setSize?: number },
) {
  // 运行时设置窗口尺寸（走 Rust widget_set_bounds；锚点(0,0) → 位置不变、只改尺寸）
  if (plan && typeof plan.setSize === 'number') {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    if (internals?.invoke) {
      try {
        await internals.invoke('widget_set_bounds', {
          mouseX: 0,
          mouseY: 0,
          targetW: plan.setSize,
          targetH: plan.setSize,
          first: true,
        })
      } catch (e) {
        console.warn('[probe] setSize 失败', e)
      }
      await sleep(600)
    }
  }
  // 运行时切换 will-change 做同帧 A/B（验证合成层是否为模糊来源）；等待两帧让重栅格化完成
  if (plan && typeof plan.setWillChange === 'string') {
    canvas.style.willChange = plan.setWillChange
    await sleep(700)
  }
  // 运行时切换「真实布局」：把画布从「固定 308 布局 + transform 放大」改成
  // 「按窗口尺寸真实布局 + 基准字号同比放大」（其余文字用 em，自动跟随）。
  // 用于验证「模糊是否来自布局尺寸被 GPU 放大」。
  if (plan && typeof plan.realLayout === 'boolean') {
    const w = Math.max(window.innerWidth, window.innerHeight)
    if (plan.realLayout) {
      canvas.style.transform = 'none'
      canvas.style.width = `${w}px`
      canvas.style.height = `${w}px`
      canvas.style.fontSize = `${(16 * w) / CANVAS_BASE}px`
    } else {
      canvas.style.width = ''
      canvas.style.height = ''
      canvas.style.fontSize = ''
      canvas.style.transform = `scale(${w / CANVAS_BASE})`
    }
    await sleep(900)
  }
  // 回传 Rust 侧命中判定：核对「空白穿透」的遮罩映射与光标坐标系是否正确
  let hit: unknown = null
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (cmd: string, args: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__
    if (internals?.invoke) hit = await internals.invoke('widget_hit_state', {})
  } catch (e) {
    hit = { error: String(e) }
  }
  // 清晰度对照：在**同一窗口**内注入「原生尺寸」的同款文字（不经画布 transform 缩放），
  // 与画布内的缩放文字同帧对比——排除跨窗口/跨进程干扰，判定缩放是否真的造成模糊。
  if (plan && typeof (plan as unknown as { control?: boolean }).control === 'boolean') {
    const on = (plan as unknown as { control?: boolean }).control
    const old = document.getElementById('__aqm_textctrl')
    if (on) {
      let ctrl = old as HTMLElement | null
      const w0 = Math.max(window.innerWidth, window.innerHeight)
      const kk = w0 / CANVAS_BASE
      if (!ctrl) {
        ctrl = document.createElement('div')
        ctrl.id = '__aqm_textctrl'
        document.body.appendChild(ctrl)
      }
      const base = 16 * kk
      ctrl.style.cssText = [
        'position:fixed',
        'left:6px',
        'top:2px',
        'z-index:2147483647',
        'pointer-events:none',
        'white-space:nowrap',
        "font-family:'Maple Mono NF CN','Maple Mono NF',monospace",
        `font-size:${(base * 1.35).toFixed(2)}px`,
        'font-weight:700',
        'line-height:1',
        'color:#1f3a5f',
        'background:#ffffff',
        'text-shadow:0 1px 0 rgba(255,255,255,.9),1px 0 0 rgba(255,255,255,.9),0 -1px 0 rgba(255,255,255,.9),-1px 0 0 rgba(255,255,255,.9),1px 1px 0 rgba(255,255,255,.9),-1px 1px 0 rgba(255,255,255,.9),1px -1px 0 rgba(255,255,255,.9),-1px -1px 0 rgba(255,255,255,.9)',
      ].join(';')
      ctrl.textContent = 'DeepSeek官方余额'
    } else if (old) {
      old.remove() // 用完必须移除，否则会一直显示在挂件上（实测踩过）
    }
    await sleep(600)
  }
  const cbox = canvas.getBoundingClientRect()
  const k = cbox.width / CANVAS_BASE
  const rel = (sel: string) => {
    const el = canvas.querySelector(sel) as HTMLElement | null
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      sel,
      text: (el.textContent || '').trim(),
      x: +((r.left - cbox.left) / k).toFixed(1),
      y: +((r.top - cbox.top) / k).toFixed(1),
      w: +(r.width / k).toFixed(1),
      h: +(r.height / k).toFixed(1),
    }
  }
  // 背景图亮度采样：把 /background.png 画进离屏画布后按画布坐标取样
  const img = new Image()
  img.src = '/background.png'
  let lum: Array<{ label: string; x: number; y: number; lum: number }> = []
  try {
    await img.decode()
    const off = document.createElement('canvas')
    off.width = img.naturalWidth
    off.height = img.naturalHeight
    const cx = off.getContext('2d')
    if (cx) {
      cx.drawImage(img, 0, 0)
      const sample = (label: string, x: number, y: number) => {
        const px = Math.round((x / CANVAS_BASE) * off.width)
        const py = Math.round((y / CANVAS_BASE) * off.height)
        const d = cx.getImageData(Math.max(0, px - 3), Math.max(0, py - 3), 7, 7).data
        let s = 0
        for (let i = 0; i < d.length; i += 4) {
          s += (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
        }
        lum.push({ label, x, y, lum: Math.round(s / (d.length / 4)) })
      }
      sample('画布顶部 y=4', 154, 4)
      sample('画布 y=12', 154, 12)
      sample('画布 y=20', 154, 20)
      sample('画布 y=26', 154, 26)
      sample('画布 y=34', 154, 34)
      sample('画布 y=41', 154, 41)
      sample('站名行中心 y=54', 154, 54)
      sample('金额行中心 y=89', 154, 89)
      sample('状态行中心 y=125', 154, 125)
    }
  } catch (e) {
    lum = [{ label: '背景图解码失败', x: 0, y: 0, lum: -1 }]
    console.warn('[probe] 背景图采样失败', e)
  }
  return {
    kind: 'layout',
    hit,
    canvas: { w: +cbox.width.toFixed(2), h: +cbox.height.toFixed(2), scale: +k.toFixed(4) },
    canvasTransform: getComputedStyle(canvas).transform,
    willChange: getComputedStyle(canvas).willChange,
    canvasInline: canvas.style.transform,
    rootRect: (() => {
      const r = (canvas.parentElement as HTMLElement).getBoundingClientRect()
      return { w: +r.width.toFixed(2), h: +r.height.toFixed(2) }
    })(),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    els: ['.widget-peak', '.widget-peak-chip', '.widget-peak-text', '.widget-name', '.widget-balance', '.widget-status']
      .map(rel)
      .filter(Boolean),
    bgLum: lum,
  }
}

/** 取画布当前的实际缩放（合成器真正使用的值，而不是我们以为写进去的值） */
function readCanvasScale(canvas: HTMLElement): number {
  const tr = getComputedStyle(canvas).transform
  if (!tr || tr === 'none') return 1
  const m = tr.match(/matrix\(([^)]+)\)/)
  if (!m) return 1
  const parts = m[1].split(',').map((s) => parseFloat(s.trim()))
  return parts.length >= 4 ? parts[0] : 1
}

/** 视觉夹具：纯色块 + 锚点标记（锚点为其在画布中的坐标，画布缩放后仍指向同一点） */
function paintHarness(canvas: HTMLElement, cx: number, cy: number): () => void {
  const img = canvas.querySelector('img.widget-bg') as HTMLElement | null
  // 一并隐藏所有画布内文字层与徽标（.widget-text / .widget-peak）：
  // 夹具要的是"纯色块 + 锚点标记"，任何第三方像素都可能污染 bbox 与质心统计
  const texts = Array.from(
    canvas.querySelectorAll('.widget-text, .widget-peak'),
  ) as HTMLElement[]
  const saved: Array<[HTMLElement, string]> = []
  const keep = (el: HTMLElement) => saved.push([el, el.style.cssText])

  if (img) {
    keep(img)
    img.style.display = 'none'
  }
  texts.forEach((t) => {
    keep(t)
    t.style.display = 'none'
  })
  keep(canvas)
  canvas.style.background = '#FF00FF'

  const marker = document.createElement('div')
  marker.className = '__aqm_marker'
  // 标记点：纯黑方块，居中于锚点画布坐标
  marker.style.cssText = [
    'position:absolute',
    'width:10px',
    'height:10px',
    `left:${cx - 5}px`,
    `top:${cy - 5}px`,
    'background:#000000',
    'pointer-events:none',
  ].join(';')
  canvas.appendChild(marker)

  return () => {
    saved.forEach(([el, css]) => (el.style.cssText = css))
    marker.remove()
  }
}

async function runOnce(plan: ProbePlan, canvas: HTMLElement) {
  await normalizePos(plan.posX ?? 250, plan.posY ?? 420)
  await normalizeSize(CANVAS_BASE)
  await sleep(250) // 等归位落地并稳定
  // 手势起始状态：anchor 用「窗口内相对比例」决定，保证任何尺寸下都落在窗口内
  const w0 = Math.max(window.innerWidth, window.innerHeight)
  const k0 = w0 / CANVAS_BASE
  const ax = Math.round(window.innerWidth * plan.anchorFx)
  const ay = Math.round(window.innerHeight * plan.anchorFy)
  // 锚点对应的画布坐标（手势全程该点应固定于屏幕）
  const cx = ax / k0
  const cy = ay / k0

  const restore = plan.paint ? paintHarness(canvas, cx, cy) : () => {}
  await sleep(120) // 让夹具完成一帧合成

  const samples: Sample[] = []
  let resizeCount = 0
  const onResize = () => resizeCount++
  window.addEventListener('resize', onResize)

  let raf = 0
  let alive = true
  const tick = () => {
    if (!alive) return
    samples.push({
      t: performance.now(),
      iw: window.innerWidth,
      ih: window.innerHeight,
      cs: readCanvasScale(canvas),
      rw: canvas.getBoundingClientRect().width,
      rl: canvas.getBoundingClientRect().left,
      rt: canvas.getBoundingClientRect().top,
      sx: window.screenX,
      sy: window.screenY,
      nres: resizeCount,
    })
    resizeCount = 0
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  const t0 = performance.now()
  const events: Array<{ t: number; clientX: number; clientY: number; deltaY: number }> = []
  for (let i = 0; i < plan.notches; i++) {
    const deltaY = plan.deltaY
    events.push({
      t: performance.now() - t0,
      clientX: ax,
      clientY: ay,
      deltaY,
    })
    window.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        clientX: ax,
        clientY: ay,
        bubbles: true,
        cancelable: true,
      }),
    )
    await sleep(plan.gapMs)
  }

  await sleep(plan.settleMs)
  alive = false
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', onResize)
  restore()

  return {
    plan,
    gesture: { w0, k0, ax, ay, cx, cy, canvasBase: CANVAS_BASE },
    events,
    samples,
    dpr: window.devicePixelRatio,
    screen: { w: window.screen.width, h: window.screen.height, aw: window.screen.availWidth },
  }
}

async function main() {
  // 只在挂件窗口跑量测（主窗口没有 .widget-canvas）
  let canvas: HTMLElement | null = null
  for (let i = 0; i < 60; i++) {
    canvas = document.querySelector('.widget-canvas') as HTMLElement | null
    if (canvas) break
    await sleep(100)
  }
  if (!canvas) {
    // 主窗口：**只有显式触发 `{"control":true}` 时才注入**「清晰度控制组」
    //（把同一张背景图按原生尺寸渲染，供与画布缩放做同物理尺寸对照）。
    // ⚠️ 绝不默认注入：早期写成"页面加载即注入且移除不掉"，结果那张图一直挂在主界面上
    //（用户直接看到并质问"为什么主界面也有小鲸鱼娘背景图"）。触发 `{"control":false}` 会移除。
    let lastRun = -1
    let ctrl: HTMLImageElement | null = null
    for (;;) {
      try {
        const r = await fetch('/__aqm/trigger', { cache: 'no-store' })
        const plan = (await r.json()) as {
          run?: number
          control?: boolean
          measure?: string[]
          click?: string[]
        }
        if (plan && typeof plan.run === 'number' && plan.run !== lastRun) {
          lastRun = plan.run
          // 通用点击（先点再量，用于核对控件的两态）
          const clicked =
            Array.isArray(plan.click) && plan.click.length > 0
              ? await clickElements(plan.click)
              : null
          // 通用元素量测（主窗口排版核对，如设置页的主题按钮组/壁纸下拉、同步弹窗的加密开关）
          if (Array.isArray(plan.measure) && plan.measure.length > 0) {
            const result = {
              kind: 'measure',
              // ⚠️ 必须带上 plan.run：vite 插件用 `data.plan.run` 命名落盘文件，
              // 缺了它量测样本会固定写成 `run-000-*.json`，按 run 号去找会一直找不到
              //（本项目踩过：误判为"主窗口探针没响应"，白等了好几轮）
              plan: { run: plan.run },
              viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
              clicked,
              groups: measureElements(plan.measure),
            }
            await fetch('/__aqm/trace', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(result),
            })
            console.log('[probe] 元素量测完成', plan.measure)
          }
          if (plan.control) {
            if (!ctrl) {
              ctrl = document.createElement('img')
              ctrl.id = '__aqm_ctrl'
              ctrl.src = '/background.png'
              ctrl.style.cssText = [
                'position:fixed',
                'left:0',
                'top:0',
                'width:400px',
                'height:400px',
                'object-fit:cover',
                'background:#ffffff',
                'z-index:2147483647',
                'pointer-events:none',
              ].join(';')
              document.body.appendChild(ctrl)
            }
          } else if (ctrl) {
            ctrl.remove()
            ctrl = null
          }
        }
      } catch {
        /* 轮询失败忽略 */
      }
      await sleep(300)
    }
  }
  if (!canvas) {
    return
  }
  console.log('[probe] 挂件探针就绪，等待触发…')

  let lastRun = -1
  for (;;) {
    try {
      const r = await fetch('/__aqm/trigger', { cache: 'no-store' })
      const plan = (await r.json()) as ProbePlan & { measure?: string[]; click?: string[] }
      if (plan && typeof plan.run === 'number' && plan.run !== lastRun) {
        lastRun = plan.run
        console.log('[probe] 执行量测轮次', plan.run, plan)
        // 通用点击（2026-09/16 补到挂件侧）：量挂件菜单面板这类"要先点开才存在"的元素时，
        // 没有它就只能靠合成鼠标事件（坐标换算 + DPI 坑），见 §4.10「真实交互验证」。
        const clicked =
          Array.isArray(plan.click) && plan.click.length > 0
            ? await clickElements(plan.click)
            : null
        // 元素量测在**两类窗口都要接**（2026-09/16 补）：此前只接在主窗口的循环里，
        // 导致 {"measure":[…]} 在挂件窗口完全不响应，取到的永远是主窗口那份 ——
        // 排查挂件右上角的新按钮时白等了好几轮。
        if (Array.isArray(plan.measure) && plan.measure.length > 0) {
          const measured = {
            kind: 'measure',
            plan: { run: plan.run }, // 落盘文件名带 run 号（理由同主窗口那份）
            viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
            clicked,
            groups: measureElements(plan.measure),
          }
          await fetch('/__aqm/trace', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(measured),
          })
          console.log('[probe] 元素量测完成（挂件窗口）', plan.measure)
        }
        const result = (plan as unknown as { layout?: boolean }).layout
          ? await layoutReport(canvas as HTMLElement, plan as unknown as { setWillChange?: string; realLayout?: boolean })
          : await runOnce(plan, canvas as HTMLElement)
        await fetch('/__aqm/trace', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(result),
        })
        console.log('[probe] 轮次完成', plan.run)
      }
    } catch (e) {
      console.warn('[probe] 轮询失败', e)
    }
    await sleep(300)
  }
}

void main()

// 鲸鱼娘挂件：独立置顶小窗，单站点余额展示（阶段 3）
// 交互对齐 Python 版 show_window：单击刷新、60s 自动刷新、可拖动、边缘缩放、悬停滚轮缩放、右上角返回
// 数据源：widget:open 事件（Rust 侧 open_widget 命令发出）→ 复用 worker.fetchEntry 刷新

import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import './widget.css'
import '../styles/theme.css'
import { fetchEntry } from '../lib/worker'
import { getConfig, type ProviderEntry } from '../lib/store'
import { fmtMoney, fmtMoneySpaced } from '../lib/fmt'
import { recordUsageBaseline, todayUsed, type UsageBaseline } from '../lib/usage'
import { deepseekNextChange, deepseekPeakNow, fmtPeakCountdownRemaining, DEEPSEEK_PEAK_INFO } from '../lib/deepseekPeak'
import type { QuotaInfo } from '../providers/types'

const AUTO_REFRESH_MS = 60_000 // 60 秒自动刷新（对齐 Python 版）
const EDGE = 10 // 边缘拖拽调整大小的感应宽度
const DRAG_THRESHOLD = 4 // 位移超过此值（px）判定为拖动；否则 mouseup 视为单击刷新
const MIN_W = 160
const MIN_H = 180
// 字号缩放基准已由 CSS 接管：.widget-root font-size 用 vw（16px @ 308px 窗口 ≈ 5.1948vw），
// 浏览器在窗口 resize 时原生同帧重算，无需 JS 读取窗口尺寸。

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | null

/** 边缘缩放光标（鼠标悬停窗口边缘时显示，对齐 Python 版 _resize_cursor） */
const RESIZE_CURSORS: Record<Exclude<ResizeDir, null>, string> = {
  n: 'n-resize',
  s: 's-resize',
  e: 'e-resize',
  w: 'w-resize',
  ne: 'ne-resize',
  nw: 'nw-resize',
  se: 'se-resize',
  sw: 'sw-resize',
}

/** 边缘缩放拖拽状态（与组件内 resizeRef 同构） */
interface ResizeDragState {
  dir: Exclude<ResizeDir, null>
  startX: number
  startY: number
  startW: number
  startH: number
  startL: number
  startT: number
  at: number
}

/** 按下状态：单击/拖动判定（与组件内 pressRef 同构） */
interface PressState {
  x: number
  y: number
  moved: boolean
  at: number
}

// ══════════════════════════════════════════════════════════════════
// 滚轮缩放 —— 模块级单例
// ⚠️ 挂件窗口在 dev 下经 HMR / React StrictMode 会多次挂载 useEffect；若 wheel 监听写在
// effect 闭包内，旧 listener 残留 + 新 listener 叠加 → 同一滚轮被处理两次（Rust 日志实测：
// 同一 t 值 first=true 连续出现两次，锚点 S0 被反复重置 → 缩放比每步重算 → 尺寸忽大忽小地颤）。
// 根治：监听器与手势状态全部提升为模块级单例（挂件窗口单实例，安全），effect 只负责
// 「确保全局唯一监听」：挂载新 handler 前先移除已注册的旧 handler。任何时刻只有一个生效。
// ══════════════════════════════════════════════════════════════════
const MAX_S = 800
const MIN_S = Math.max(MIN_W, MIN_H)
// 滚轮缩放平滑参数：单帧最大位移（逻辑 px）与收尾帧数——「速度 vs 抖动」的直接旋钮，见 wheelFrame 内注释
const MAX_STEP = 6
const MIN_STEP = 0.5
const STEP_FRAMES = 4
// 画布基准尺寸（CSS .widget-canvas 固定 308×308；transform: scale(窗口边长/308)）
const CANVAS_BASE = 308
// 组件 refs 注入点：渲染时同步（handler 需访问 resize/press/wheelSave/canvas 状态）
let widgetRefs: {
  resize: React.MutableRefObject<ResizeDragState | null>
  press: React.MutableRefObject<PressState | null>
  wheelSave: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
  canvas: React.MutableRefObject<HTMLDivElement | null>
} | null = null

let wheelLastAt = 0 // 本手势上次滚轮时刻（前端时钟）
let wheelPendingSize: number | null = null // 本手势累计目标边长（逻辑 px）
let wheelAnchorSet = false
let wheelAnchorX = 0
let wheelAnchorY = 0
let wheelFirstOfGesture = false
// —— 窗口平滑动画泵（rAF 逐帧）——
// ⚠️ 窗口几何必须**逐帧小步**推进：抖动幅度 ≈ 0.4 × 单步位移（见 wheelFrame 实测标定）。
let wheelIdealSize = 0 // 理想尺寸游标（浮点、单调推进，**不**被落地取整影响——见下）
let wheelPumping = false // 泵是否在运行（防重入）
let wheelRaf = 0 // 本帧的 rAF 句柄（0 = 未排程）

/** 内容层 scale 的唯一写入点。内容静态布局于 308 画布，用 GPU transform 缩放匹配窗口。
 * 画布原点(0,0)对齐窗口左上角（.widget-canvas transform-origin: 0 0），配合 Rust 的
 * 窗口位置锚点数学（P1 = P0 + mouse*(1-k)），鼠标下内容点屏幕位置保持不动。 */
function setCanvasScale(w: number) {
  const canvas = widgetRefs?.canvas.current
  if (!canvas || w <= 0) return
  canvas.style.transform = `scale(${w / CANVAS_BASE})`
}

/** 缩放手势**进行中**才开启合成层，停歇后撤销。
 *
 *  原理：手势期间每帧只改 transform，常驻合成层可避免逐帧重绘（顺滑）；停歇后撤销，
 *  让浏览器按**最终尺寸**重新栅格化，不让画布一直钉在旧栅格上。
 *
 *  ⚠️ 诚实记录（2026-09/11 实测）：本开关对清晰度的**可测影响为零**——
 *  同尺寸 + 同缩放历史下切 auto/transform，各项指标逐位相同；缩放往返（S→其它→S）
 *  也测不出差异。保留它只是因为「空闲时不占合成层」本身合理且无代价，
 *  **不要声称它修好了什么**。
 *
 *  ⚠️ 量测教训：验证清晰度要用**同窗口原生对照**（同窗口注入一段原生尺寸的同款文字、同帧比对），
 *  或看「笔画核心暗度 / 深墨像素占比」。「边缘跃迁宽度」会随字号自然变大
 *  （受白色描边几何影响），既掩盖真实差异、也制造过假差异。 */
function setCanvasComposited(on: boolean) {
  const canvas = widgetRefs?.canvas.current
  if (canvas) canvas.style.willChange = on ? 'transform' : 'auto'
}


/** 兜底同步：按窗口当前真实尺寸对齐内容层（边缘缩放、系统改尺寸、以及落地校正） */
function syncCanvasScale() {
  const w = Math.max(window.innerWidth, window.innerHeight)
  if (w > 0) setCanvasScale(w)
}

/** 排下一帧（不重复排程） */
function scheduleWheelFrame() {
  if (!wheelRaf) wheelRaf = requestAnimationFrame(wheelFrame)
}

/** 发出一次窗口几何（位置+尺寸，Rust 侧单次 SetWindowPos 原子设置） */
function issueGeom(size: number, first: boolean) {
  void invoke<number>('widget_set_bounds', {
    mouseX: wheelAnchorX,
    mouseY: wheelAnchorY,
    targetW: size,
    targetH: size,
    first,
  }).catch(() => {
    wheelPendingSize = null
    wheelPumping = false
  })
}

// ⚠️ 窗口几何比内容层**晚一帧**发布（GEOM_DELAY_FRAMES=1）——这是"既快又不抖"的关键。
// 依据（屏幕捕获实测）：上屏的内容总是**落后窗口几何一帧**（窗口已是新位置、内容还是上一步的缩放）
// → 锚点被拖回一步，偏移量 ≈ 0.4 × 单帧窗口位移。反过来让几何晚一帧发布，两者在同一个呈现帧里
// 就来自**同一个步**，错位消失 → 不必再靠"压小单帧位移"换平滑，步长可以放大（动画变快）。
// 实测对比（快速滚动 +100 逻辑px，单位物理像素）：无延后 0.87 均值 / 932ms；有延后 0.285 均值 / 399ms；
// 而最初的旧策略是 3.94 均值 / 5.0 峰值。
// 副作用：延后期间内容层比窗口略大（最多一个步长 ≈6px）→ 右/下边缘被窗口裁掉一条。
// 可见框仍由窗口驱动、平滑增长，被裁的是图像边角，实测幅度下不易察觉；
// 若日后要彻底消除，需让 Rust 把「锚点数学所用尺寸」与「窗口实际尺寸」分开（窗口留 margin），
// 并把返回按钮改为相对内容定位（当前定位在窗口右上角，会被 margin 推偏）。
const GEOM_DELAY_FRAMES = 1
let wheelGeomLag: number | null = null

/** 单帧一步：推进内容层 scale，并把**上一帧**的内容尺寸作为窗口几何发出（见 GEOM_DELAY_FRAMES）。
 *
 *  ⚠️ 三条实测标定（2026-09/11，屏幕捕获 + 亚像素质心，见交接文档 §4.6）：
 *
 *  ① 抖动根因 = 窗口几何由系统在收到 SetWindowPos 后**立即**应用（DWM 合成），而内容层 transform
 *     要等渲染进程下一次提交才上屏 → 上屏的那一帧里窗口已是新位置、内容还是上一步的缩放，
 *     鼠标下的锚点被"拖回"一步，偏移量 ≈ 0.4 × 单帧窗口位移。
 *     （实测：单步 3px→锚点摆 ~2px；单步 9px→摆 5px；单步 1px→低于量测噪声底。）
 *     解法 = 让窗口几何晚一帧发布，与上屏的内容取自同一步（见 GEOM_DELAY_FRAMES）。
 *
 *  ② 步长基准必须用**前端自持的浮点游标**，不能每帧回读落地值。
 *     落地尺寸是物理像素取整结果（125% 缩放下粒度 0.8 逻辑 px），拿它当下一帧基准会把步长
 *     向上取整——实测请求 1.25px 时有效步长被顶到 2px，抖动随之放大 1.6 倍。
 *     游标单调推进不回落，落地值只用于收敛判断与收尾对齐（避免"乐观推进/落地回退"互相拉扯）。
 *
 *  ③ 步长上限是「速度 vs 抖动」的直接旋钮：抖动 ∝ 单步位移，故 MAX_STEP 越大动画越快、抖动越大。
 *     当前 MAX_STEP=6 是在「几何延后已消掉大部分错位」之后选定的折中点（见常量注释与实测表）。 */
function wheelFrame(): void {
  wheelRaf = 0
  if (wheelPendingSize === null || !wheelAnchorSet) {
    wheelPumping = false
    return
  }
  const cur = wheelIdealSize > 0 ? wheelIdealSize : Math.max(window.innerWidth, window.innerHeight)
  if (cur <= 0) {
    wheelPumping = false
    return
  }
  const diff = wheelPendingSize - cur
  if (Math.abs(diff) < 0.5) {
    // 内容层已追平：先把延后一帧的几何补发（否则窗口永远差一步），再真正收尾
    if (wheelGeomLag !== null) {
      const f = wheelFirstOfGesture
      wheelFirstOfGesture = false
      issueGeom(wheelGeomLag, f)
      wheelGeomLag = null
      scheduleWheelFrame()
      return
    }
    wheelPendingSize = null // 追平
    wheelPumping = false
    syncCanvasScale() // 收尾按真实落地值对齐一次（内容层与窗口严格一致）
    setCanvasComposited(false) // 撤销合成层 → 按最终尺寸重新栅格化（否则栅格停在旧尺寸、越放越糊）
    return
  }
  // 自适应步长：抖动 ∝ 单步位移，故把单步钳在 ≤MAX_STEP；
  // 大距离改为多帧走完（|diff|/STEP_FRAMES 帧），滚动越快动画越从容、但每帧位移始终很小。
  const absDiff = Math.abs(diff)
  const step = Math.min(MAX_STEP, Math.max(MIN_STEP, absDiff / STEP_FRAMES))
  const target = cur + Math.sign(diff) * Math.min(step, absDiff)
  wheelIdealSize = target // ① 浮点游标（下一步基准，不受落地取整影响）
  setCanvasScale(target) // ② 内容层
  // ③ 窗口几何：GEOM_DELAY_FRAMES=1 时用**上一帧**的内容尺寸（与上屏的内容对齐，见文件头说明）
  if (GEOM_DELAY_FRAMES > 0) {
    if (wheelGeomLag !== null) {
      const first0 = wheelFirstOfGesture
      wheelFirstOfGesture = false
      issueGeom(wheelGeomLag, first0)
    }
    wheelGeomLag = target
    scheduleWheelFrame() // 本帧只推进内容层，几何下一帧发
    return
  }
  const first0 = wheelFirstOfGesture
  wheelFirstOfGesture = false
  issueGeom(target, first0)
}

/** 启动泵（防重入）：滚轮事件更新目标后调用 */
function wheelStartPump() {
  if (!wheelPumping) {
    wheelPumping = true
    scheduleWheelFrame()
  }
}

/** 全局唯一 wheel handler：累计目标边长 + 启动串行泵。
 * 锚点数学在 Rust（first 帧缓存真实位置），前端只上报鼠标内容坐标 + 目标边长。 */
function wheelHandler(e: WheelEvent) {
  const refs = widgetRefs
  if (!refs) return
  const now = performance.now()
  // ⚠️ 自愈兜底：边缘缩放中 mouseup 丢失也会让 resize 卡住，超过 500ms 视为已结束
  if (refs.resize.current && now - refs.resize.current.at > 500) refs.resize.current = null
  // ⚠️ press 不再阻塞滚轮：它只属于单击/拖动判定。拖动已在 startDragging 时释放；
  // 残留的卡死状态（mouseup 被吞）在此兜底清除，保证滚轮永远可用。
  refs.press.current = null
  if (refs.resize.current) return // 仅「进行中」的边缘缩放拦截滚轮
  // 停歇后的首次滚轮 = 新手势：重置锚点与累计
  if (now - wheelLastAt > 400) {
    wheelAnchorSet = false
    wheelPendingSize = null
    wheelIdealSize = Math.max(window.innerWidth, window.innerHeight)
  }
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY // 行模式兜底换算（WebView 通常为像素模式）
  // 方向：滚轮向下（deltaY>0）→ delta>0 → 放大；滚轮向上（deltaY<0）→ 缩小。100/格 → 10px/格
  const delta = Math.max(-50, Math.min(50, dy * 0.1))
  if (delta === 0) return
  // 非 passive + preventDefault：显式声明页面自行处理滚轮，防 WebView2 吞后续 wheel 事件
  if (e.cancelable) e.preventDefault()
  wheelLastAt = now
  // 手势首次滚轮：锁定锚点（鼠标指向的内容坐标），整个手势不变；首次通知 Rust 缓存真实位置锚点
  if (!wheelAnchorSet) {
    wheelAnchorX = e.clientX
    wheelAnchorY = e.clientY
    wheelAnchorSet = true
    wheelFirstOfGesture = true
    setCanvasComposited(true) // 手势期间常驻合成层（每帧只改 transform → 顺滑）
    wheelIdealSize = Math.max(window.innerWidth, window.innerHeight)
  }
  // 累计目标边长；rAF 泵逐帧小步推进（步长钳制见 wheelFrame）
  const base = wheelPendingSize ?? wheelIdealSize
  wheelPendingSize = Math.max(MIN_S, Math.min(MAX_S, base + delta))
  wheelStartPump()
  if (refs.wheelSave.current) clearTimeout(refs.wheelSave.current)
  refs.wheelSave.current = setTimeout(() => {
    refs.wheelSave.current = null
    // 保存尺寸（位置由 Rust widget_save_size 从真实 outer_position 读取）
    const s = Math.max(window.innerWidth, window.innerHeight)
    void invoke('widget_save_size', { w: s, h: s }).catch(() => {})
    if (!wheelPumping) setCanvasComposited(false) // 停歇且动画结束 → 撤销合成层
  }, 300)
}

/** 全局唯一 resize handler：**非动画期间**按窗口真实尺寸对齐画布（边缘缩放、系统改尺寸）；
 *  滚轮动画期间画布 scale 由 wheelFrame 独占（避免两个写入者写不同取整口径的值互相打架）；
 *  动画结束且滚轮停歇后重置手势状态。 */
function resizeHandler() {
  const refs = widgetRefs
  if (!refs) return
  // ⚠️ 泵运行中一律不动：既不能写内容层（与泵的浮点游标打架），也不能清手势状态。
  // 旧写法只看「距上次滚轮 >400ms」就清 pending——那是给「100ms 内跑完」的旧快泵定的阈值；
  // 现在单帧位移被钳小（MAX_STEP），一个 100px 的滚动要跑 1s 以上，
  // 若不看 wheelPumping，就会在最后一次滚轮 400ms 后把动画**腰斩**（实测目标只走到 29%）。
  if (wheelPumping) return
  syncCanvasScale()
  if (performance.now() - wheelLastAt > 400) {
    wheelPendingSize = null
    wheelAnchorSet = false
  }
}

/** 安装全局唯一滚轮缩放监听（跨 HMR 真幂等：handler 引用存 window 全局属性，
 *  重挂载时能移除旧模块实例残留在 window 上的旧 listener——模块级变量在 HMR 后是新的，
 *  用模块内函数引用 removeEventListener 找不到旧函数，旧监听残留 → 同一滚轮被处理两次）。 */
function ensureWheelListener() {
  const w = window as unknown as {
    __dshWidgetWheel?: { wheel: (e: WheelEvent) => void; resize: () => void }
  }
  const prev = w.__dshWidgetWheel
  if (prev) {
    window.removeEventListener('wheel', prev.wheel)
    window.removeEventListener('resize', prev.resize)
  }
  // 监听统一挂 window（非 passive，可 preventDefault）；wheel 事件冒泡到 window 必然到达
  window.addEventListener('wheel', wheelHandler, { passive: false })
  window.addEventListener('resize', resizeHandler)
  w.__dshWidgetWheel = { wheel: wheelHandler, resize: resizeHandler }
}

/** 生成并上传「命中遮罩」：把 background.png 的 alpha 通道二值化成 N×N 网格。
 *
 *  用途：挂件窗口是矩形，但背景图有约 **48% 像素完全透明**（鲸鱼娘是异形角色）——
 *  那近一半空白会吃掉鼠标、挡住后面的窗口。Rust 侧据此把光标所在为空白时设为鼠标穿透
 *  （见 widget.rs 的 hit 相关实现）。**只在挂载时上传一次**（背景图不会变）。
 *
 *  取块内**平均** alpha + 很低阈值 ≈ 对实体区域做膨胀：宁可多捕获一点，
 *  也不能把鲸鱼娘本体判成空白（否则用户点不到它、甚至拖不动窗口）。
 *  上传失败则维持原行为（不穿透），不影响可用性。 */
async function uploadHitMask() {
  const N = 128
  try {
    const img = new Image()
    img.src = '/background.png'
    await img.decode()
    const off = document.createElement('canvas')
    off.width = N
    off.height = N
    const ctx = off.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, N, N)
    ctx.drawImage(img, 0, 0, N, N) // 浏览器降采样：块内 alpha 会被平均
    const data = ctx.getImageData(0, 0, N, N).data
    const cells: number[] = new Array(N * N)
    for (let i = 0; i < N * N; i++) cells[i] = data[i * 4 + 3] >= 16 ? 1 : 0
    await invoke('widget_set_hitmask', { size: N, cells })
  } catch (err) {
    console.warn('挂件命中遮罩上传失败（不启用空白穿透）：', err)
  }
}

/** 卸载全局滚轮缩放监听（按 window 全局引用精确移除） */
function teardownWheelListener() {
  const w = window as unknown as {
    __dshWidgetWheel?: { wheel: (e: WheelEvent) => void; resize: () => void }
  }
  const prev = w.__dshWidgetWheel
  if (prev) {
    window.removeEventListener('wheel', prev.wheel)
    window.removeEventListener('resize', prev.resize)
    delete w.__dshWidgetWheel
  }
}

export default function WidgetApp() {
  const [entry, setEntry] = useState<ProviderEntry | null>(null)
  const [info, setInfo] = useState<QuotaInfo | null>(null)
  const [statusText, setStatusText] = useState('点击任意位置刷新')
  const [statusKey, setStatusKey] = useState<'idle' | 'ok' | 'err' | 'busy'>('idle')
  const [bgFailed, setBgFailed] = useState(false)
  // 「今日已用」的当日余额记录（来自 config.json 的 usageBaselines；纯本地推算，见 lib/usage.ts）
  const [baseline, setBaseline] = useState<UsageBaseline | null>(null)
  // 右上角 ☰ 的展开态：「今日充值金额」面板自 2026-09/16 起是**独立窗口**（label=widget-menu，
  // 位于挂件正上方、右对齐），这里只跟随 Rust 的 `widget:menu-state` 事件（权威状态），
  // 不做本地 toggle —— 本地 toggle 会在"面板被取消/确定收起"时与真实状态不一致。
  const [menuOpen, setMenuOpen] = useState(false)

  const entryRef = useRef<ProviderEntry | null>(null)
  const busyRef = useRef(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  // 按下状态：单击/拖动判定（对齐 Python 版 mousePress/MouseMove/MouseRelease）
  const pressRef = useRef<{ x: number; y: number; moved: boolean; at: number } | null>(null)
  // 边缘缩放状态
  const resizeRef = useRef<{
    dir: Exclude<ResizeDir, null>
    startX: number
    startY: number
    startW: number
    startH: number
    startL: number
    startT: number
    at: number
  } | null>(null)
  // 滚轮缩放后防抖持久化（连续滚动只在停止后写一次配置）
  const wheelSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 重读当日记录（`config.usageBaselines`）：每次刷新后、以及面板登记充值收起后都要重读 */
  const reloadBaseline = useCallback(async (uid: string) => {
    try {
      const cfg = await getConfig()
      setBaseline(cfg.usageBaselines?.[uid] ?? null)
    } catch (e) {
      console.error('重读当日记录失败：', e)
    }
  }, [])

  const applyInfo = useCallback(async (i: QuotaInfo, uid: string) => {
    setInfo(i)
    if (i.ok) {
      setStatusText('数据正常')
      setStatusKey('ok')
    } else {
      setStatusText(i.message || '查询失败')
      setStatusKey('err')
    }
    // 今日已用（本地推算）：成功时上报当日读数，Rust 侧维护「当日最高余额（水位）」
    // （余额上升 = 充过值，水位持久化，故提示不会因下次读数回落而消失），然后重读记录。
    // 整条链路失败一律静默——它只是状态行上的一行附加信息，绝不能影响主流程。
    if (i.ok) {
      try {
        await recordUsageBaseline(uid, i)
        await reloadBaseline(uid)
        // 提示由「当前余额 > 水位 + 已登记充值」派生（见 needRecharge），此处无需另存状态
      } catch (e) {
        console.error('今日已用推算失败：', e)
      }
    }
  }, [reloadBaseline])

  const refresh = useCallback(async () => {
    const e = entryRef.current
    if (!e || busyRef.current) return
    busyRef.current = true
    setStatusText('刷新中…')
    setStatusKey('busy')
    try {
      const i = await fetchEntry(e)
      await applyInfo(i, e.uid)
    } catch (err) {
      setStatusText(`查询失败：${err instanceof Error ? err.message : String(err)}`)
      setStatusKey('err')
    } finally {
      busyRef.current = false
    }
  }, [applyInfo])

  // 打开/切换站点：从 config 找到完整 entry；
  // 有主界面已有结果（info）则立即显示，再后台刷新（不等网络，打开即见数据）
  const openSite = useCallback(
    async (uid: string, displayName: string, cached?: QuotaInfo | null) => {
      try {
        const cfg = await getConfig()
        const e = cfg.providers.find((p) => p.uid === uid) ?? null
        entryRef.current = e
        setEntry(e)
        // 切站点时先落上该站点自己的基准（否则会短暂显示上一个站点的今日已用）
        setBaseline(cfg.usageBaselines?.[uid] ?? null)
        document.title = `widget:${e ? uid : 'missing'}:${displayName}`
        if (!e) return
        if (cached) await applyInfo(cached, uid) // 主界面已有数据：先显示
        await refresh() // 再后台刷新覆盖为最新
      } catch (err) {
        console.error('挂件加载站点失败：', err)
        document.title = `widget:error:${String(err)}`
      }
    },
    [refresh, applyInfo],
  )

  // 挂载时主动拉取目标站点（握手：避免页面加载完成 ≠ React 挂载完成导致事件丢失）
  useEffect(() => {
    invoke<{ uid: string; displayName: string; info: QuotaInfo | null } | null>('widget_get_site')
      .then((site) => {
        if (site) void openSite(site.uid, site.displayName, site.info)
      })
      .catch((err) => console.error('拉取挂件站点失败：', err))
  }, [openSite])

  // 监听 Rust 侧 widget:open 事件（挂件窗口已存在时切换站点）
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<{ uid: string; displayName: string; info: QuotaInfo | null }>('widget:open', (e) => {
      void openSite(e.payload.uid, e.payload.displayName, e.payload.info)
    }).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }, [openSite])

  // ☰ 面板的开合状态（Rust 权威）：只用于同步按钮的 aria-expanded。
  // 面板里现在没有会改动数据的操作（「今日充值金额」已随换模型删除），故收起时无需重读记录。
  useEffect(() => {
    let unlisten: (() => void) | undefined
    listen<boolean>('widget:menu-state', (e) => setMenuOpen(e.payload)).then((fn) => (unlisten = fn))
    return () => unlisten?.()
  }, [])

  // 60 秒自动刷新
  useEffect(() => {
    const t = setInterval(() => void refresh(), AUTO_REFRESH_MS)
    return () => clearInterval(t)
  }, [refresh])

  // DeepSeek 官方站峰谷徽标 + 距下一时段的倒计时（对齐主界面站点卡片的同一套口径）。
  // 纯本地按时段计算、不依赖网络；切换只发生在整点。
  // 刷新节奏与主卡片同规则：剩余 < 2 小时时逐秒跳动（此时文案带秒），否则 10 秒一次（分钟级）。
  const [dsPeak, setDsPeak] = useState<{ kind: 'peak' | 'valley'; title: string; text: string } | null>(null)
  useEffect(() => {
    if (entry?.providerId !== 'deepseek_official') {
      setDsPeak(null)
      return
    }
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      if (timer) clearInterval(timer)
      const now = new Date()
      const kind = deepseekPeakNow(now)
      const next = deepseekNextChange(now)
      setDsPeak({
        kind,
        title: DEEPSEEK_PEAK_INFO[kind].title,
        text: fmtPeakCountdownRemaining(next.seconds),
      })
      timer = setInterval(tick, next.seconds < 7200 ? 1000 : 10_000)
    }
    tick()
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [entry?.providerId])

  // 诊断回报：页面已挂载
  useEffect(() => {
    document.title = `widget-ready:${getCurrentWindow().label}`
  }, [])

  // 空白处点击穿透：上传命中遮罩（背景图不变，只需一次）
  useEffect(() => {
    void uploadHitMask()
  }, [])

  // —— 边缘命中测试（窗口逻辑像素）——
  const hitTest = (x: number, y: number): Exclude<ResizeDir, null> | null => {
    const w = window.innerWidth
    const h = window.innerHeight
    const left = x <= EDGE
    const right = x >= w - EDGE
    const top = y <= EDGE
    const bottom = y >= h - EDGE
    if (left && top) return 'nw'
    if (right && top) return 'ne'
    if (left && bottom) return 'sw'
    if (right && bottom) return 'se'
    if (left) return 'w'
    if (right) return 'e'
    if (top) return 'n'
    if (bottom) return 's'
    return null
  }

  // —— 边缘缩放（无边框窗口自实现；对齐 Python 版拖边缘缩放）+ 单击/拖动判定 ——
  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const dir = hitTest(e.clientX, e.clientY)
    if (dir) {
      // 命中边缘：进入缩放模式，并阻止触发任何拖动逻辑
      e.stopPropagation()
      e.preventDefault()
      resizeRef.current = {
        dir,
        startX: e.screenX,
        startY: e.screenY,
        startW: window.outerWidth,
        startH: window.outerHeight,
        startL: window.screenX,
        startT: window.screenY,
        at: performance.now(),
      }
      setCanvasComposited(true) // 边缘拖拽期间同样要合成层（拖完在 mouseup 撤销）
      return
    }
    // 返回按钮不参与刷新/拖动判定
    if ((e.target as HTMLElement).closest('.widget-back')) return
    // 记录按下位置：mouseup 时位移未超阈值 = 单击 → 刷新；超阈值 = 拖动
    pressRef.current = { x: e.screenX, y: e.screenY, moved: false, at: performance.now() }
  }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current
      if (r) {
        const dx = e.screenX - r.startX
        const dy = e.screenY - r.startY
        // 期望的新宽高（自由拖拽）
        let nw = r.startW + (r.dir.includes('e') ? dx : r.dir.includes('w') ? -dx : 0)
        let nh = r.startH + (r.dir.includes('s') ? dy : r.dir.includes('n') ? -dy : 0)
        // 固定比例 1:1（对齐 Python 版 resizeEvent：取较大边为正方形边长）
        const s = Math.max(nw, nh, MIN_W, MIN_H)
        // 位置：拖动的边跟随鼠标，对边锚定
        let l = r.startL
        let t = r.startT
        if (r.dir.includes('w')) l = r.startL + (r.startW - s)
        if (r.dir.includes('n')) t = r.startT + (r.startH - s)
        const win = getCurrentWindow()
        void win.setPosition(new LogicalPosition(l, t))
        void win.setSize(new LogicalSize(s, s))
        return
      }
      // 拖动判定：位移超过阈值后进入原生拖动循环（startDragging，手感流畅）
      const p = pressRef.current
      if (p && !p.moved) {
        const dx = e.screenX - p.x
        const dy = e.screenY - p.y
        if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
          p.moved = true
          // ⚠️ 拖动交给系统（startDragging 原生循环会吞掉 mouseup，onUp 永远收不到）：
          // 必须在此立即释放按下状态，否则 pressRef 永久卡住 → 后续滚轮全被拦截
          // （「拖动窗口后滚轮失效」根因）。单击刷新逻辑只认「未移动」的按下，不受影响。
          pressRef.current = null
          void getCurrentWindow().startDragging()
        }
      }
    }
    const onUp = () => {
      if (resizeRef.current) {
        resizeRef.current = null
        if (rootRef.current) rootRef.current.style.cursor = 'default'
        // 缩放结束：立即上报当前大小持久化（不依赖关闭时机，应用退出也不会丢）
        void invoke('widget_save_size', {
          w: window.outerWidth,
          h: window.outerHeight,
        }).catch(() => {})
        syncCanvasScale() // 按真实落地尺寸对齐内容层
        setCanvasComposited(false) // 撤销合成层 → 重新栅格化（否则停在旧栅格、越拖越糊）
        return
      }
      // 单击（未移动）：刷新余额；拖动（已 moved 或 startDragging）不刷新
      const p = pressRef.current
      pressRef.current = null
      if (p && !p.moved) void refresh()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [refresh])

  // —— 边缘悬停光标：窗口边缘显示缩放箭头（缩放中保持对应方向） ——
  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = resizeRef.current
    const dir = r ? r.dir : hitTest(e.clientX, e.clientY)
    e.currentTarget.style.cursor = dir ? RESIZE_CURSORS[dir] : 'default'
  }

  // —— 悬停滚轮缩放：滚轮向下放大 / 滚轮向上缩小（≈10px 一格），
  // 缩放焦点 = 鼠标所在位置（缩放前后鼠标指向的屏幕点不动，窗口随焦点平移），1:1 正方形（对齐边缘缩放规则）。
  // 拖动/边缘缩放进行中不响应；缩放上限 800（文字缩放 2x≈616px 封顶，之上仅图片放大）。
  // ⚠️ 实现说明（抖动漂移的演进与根治，详见模块顶部注释）：
  //   ①JS 自维护窗口位置不可靠（WebView2 高 DPI 读数差 1000px）→ 锚点数学移至 Rust，
  //     从系统真实 outer_position/size 出发，first 帧缓存锚点，无累积漂移。
  //   ②窗口动画由 rAF **逐帧一步**驱动（不自持时钟抢跑）：每步把「内容层 scale」与
  //     「窗口几何（位置+尺寸，Rust 单次 SetWindowPos 原子设置）」放进同一个任务发出，
  //     两者落在同一合成帧 → 锚点全程不动（见 wheelFrame 注释与 §4.6 实测数据）。
  //   ③wheel/resize 监听与手势状态为「模块级单例」，effect 只注入 refs + 幂等确保唯一监听，
  //     根治 HMR / StrictMode 双挂载导致的「同一滚轮处理两次 → 锚点反复重置 → 忽大忽小颤」。
  useEffect(() => {
    // 注入组件 refs（挂件单实例；handler 运行期读取最新值，无需重建闭包）
    widgetRefs = { resize: resizeRef, press: pressRef, wheelSave: wheelSaveRef, canvas: canvasRef }
    // 幂等安装：若已存在旧监听先移除再挂新，任何时刻全局只有一个 wheel/resize handler
    ensureWheelListener()
    // 初次同步画布 scale（匹配当前窗口尺寸）
    syncCanvasScale()
    return () => {
      // 卸载时移除监听（按 window 全局引用精确移除旧 handler）并清空注入点
      teardownWheelListener()
      widgetRefs = null
      if (wheelRaf) {
        cancelAnimationFrame(wheelRaf)
        wheelRaf = 0
      }
      wheelPumping = false
      if (wheelSaveRef.current) {
        clearTimeout(wheelSaveRef.current)
        wheelSaveRef.current = null
      }
    }
  }, [])

  // —— 单击任意位置刷新：由 mouseup 位移判定触发（见上方 useEffect），不再依赖 click 事件 ——
  const close = () => {
    void invoke('close_widget').catch((err) => console.error('关闭挂件失败：', err))
  }

  // —— 「今日充值金额」面板：**独立窗口**（Rust `widget_menu_toggle`），内容与保存都在
  //    WidgetMenuApp 里。这里只负责开关 —— 面板位置由 Rust 对齐到挂件正上方、右对齐，
  //    挂件缩小时不会再裁到面板（此前面板画在本窗口内，缩小后显示不全）。 ——
  const toggleMenu = () => {
    void invoke('widget_menu_toggle').catch((err) =>
      console.error('切换充值面板失败：', err),
    )
  }

  const value = info?.remaining ?? info?.total
  const name = entry ? entry.displayName.replace(/\s+/g, '') : '未命名站点'
  const balance = entry
    ? fmtMoney(value, info?.currency ?? '')
    : '-'
  // 状态行：有「今日已用」时优先显示它（用户要求），否则回退到原有状态文案
  // （刷新中的「刷新中…」、错误的红色原因、无基准时的新站点/跨天情况都走回退）
  // ⚠️ 单一类名：不能把 'used' 与原有 statusKey 并列，否则前一次是错误态时
  //    .widget-status.err 的深红会盖住今日已用（CSS 里 .err 规则在后）
  const used = todayUsed(baseline, info?.currency)
  // 币种符号与数字之间留一点间隙（2026-09/15 用户要求，仅此行）：
  // 间隙由字符承载（U+2009 THIN SPACE，≈0.2em）而非 CSS margin——宽度可量测、可单独调到更窄/更宽，
  // 也不会影响金额与「今日已用」标签之间的字距。其余金额（余额大字、卡片等）仍是紧贴格式。
  const usedText = used === null ? null : `今日已用 ${fmtMoneySpaced(used, info?.currency ?? '', '\u2009')}`
  // ⚠️ 自 2026-09/16 换模型起，这里**不再有**"需要登记充值"的提示分支（`needRecharge` /
  //    状态行被顶掉 / `.widget-status.recharge` 全部删除）：
  //    消费只由"下降"累加（见 lib/usage.ts），充值不可能让这个数字出错，因此无需打断用户。
  //    数字只在"今天还没有观测区间"（跨天后第一次刷新之前）时缺省，此时回退到状态文案。
  const statusLine = usedText ?? statusText
  const statusClass: string = usedText === null ? statusKey : 'used'

  return (
    <div
      className="widget-root"
      ref={rootRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
    >
      {/* 缩放画布：固定 308×308 布局，JS 按窗口尺寸设置 transform: scale，
          内容不重排，GPU 整体缩放 → 平滑无抖（见 syncCanvasScale）。

          data-has-peak（2026-09/15）：标记该站点**有没有站名行上方的特殊内容行**（目前只有
          DeepSeek 的峰谷徽标 + 倒计时）。没有时由 CSS 把三行文字整体上移，避免顶部空出一块
          —— 用户要求：「显示没有特殊显示内容的站点数据（如峰谷等）时，三行上移」。 */}
      <div className="widget-canvas" ref={canvasRef} data-has-peak={dsPeak ? '1' : '0'}>
        {bgFailed ? (
          <div className="widget-bg widget-bg-fallback" />
        ) : (
          <img
            className="widget-bg"
            src="/background.png"
            alt=""
            draggable={false}
            onError={() => setBgFailed(true)}
          />
        )}

        {/* DeepSeek 官方峰谷徽标：站名行上方（对齐主界面站点卡片里的同名徽标）。
            位置落在背景图气泡内（气泡内区约画布 y 18~41px，站名文字框上缘约 43px），见 widget.css */}
        <div className="widget-text widget-name">
          {/* 站名与「余额」必须同一行：JSX 元素间的换行缩进会折叠成空格 */}
          {name}<span className="suffix">余额</span>
        </div>
        <div className="widget-text widget-balance">{balance}</div>
        <div className={`widget-text widget-status ${statusClass}`}>{statusLine}</div>

        {/* 峰谷徽标 + 倒计时：2026-09/15 由站名上方移到「今日已用」下方（用户要求），
            同一行显示，如「峰 剩余5时23分」 */}
        {dsPeak && (
          <div className="widget-peak row">
            <span className={`widget-peak-chip widget-peak-${dsPeak.kind}`} title={dsPeak.title}>
              {DEEPSEEK_PEAK_INFO[dsPeak.kind].label}
            </span>
            <span className="widget-peak-text" title={dsPeak.title}>
              {dsPeak.text}
            </span>
          </div>
        )}
      </div>

      {/* 返回按钮在画布外：不随缩放（固定右上角 10px） */}
      <button
        className="widget-back"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          close()
        }}
      >
        ↩
      </button>

      {/* 菜单按钮：样式与返回键一致，固定在返回键**正下方**（同一列，不随画布缩放）。
          该处是背景图 y 152~176 的透明区，不压角色；因点击穿透的命中遮罩判定的是 alpha，
          实体按钮元素可接收事件，无需额外保护。
          点它打开的是**独立窗口**（挂件正上方、右对齐），面板内容见 WidgetMenuApp.tsx ——
          2026-09/16 前是画在本窗口内的浮层，挂件缩小时会被裁掉。 */}
      <button
        className="widget-menu"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          toggleMenu()
        }}
        title="设置今日充值金额"
        aria-label="设置今日充值金额"
        aria-expanded={menuOpen}
      >
        ☰
      </button>
    </div>
  )
}
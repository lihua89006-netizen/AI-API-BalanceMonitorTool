// DeepSeek 官方 API 峰谷时段判断（官网规则）
//
// 高峰时段：北京时间 工作日 9:00–12:00、14:00–18:00
// 空闲（谷）时段：周末全天、中国法定节假日全天、工作日其余时段（午休、夜间与清晨）
//
// 2026-09/19 起生效的**官方新规**（「API 峰谷时间说明」）：**调休上班的周末、中国法定节假日全天
// 均按空闲时段计费**（公告口径见 §0 / §11；本项目改用同一口径）。因此判定口径为：
//   1) 周六、周日一律全天谷 —— **包括因调休需要上班的周末**（不是"上班日就算峰"）；
//   2) 中国法定节假日（《国务院办公厅关于 … 部分节假日安排的通知》里的**放假日期**）全天谷；
//   3) 其余日子才按工作日的 9:00–12:00、14:00–18:00 计峰。
// 换句话说：**「调休上班的周末」与「法定节假日」都只做减法，不放宽峰时段**。
//
// ⚠️ 放假安排每年由国务院办公厅单独发布（通常在上一年的 10~11 月）→ 见下方 CN_HOLIDAY_SPANS
//    的补表说明；表外的年份**自动退回**「周末谷 / 工作日峰」的老口径（不会算错成工作日峰以外的值）。
// 返回 'peak'（峰）或 'valley'（谷）

import { fmtDuration } from './fmt'

/** 一段放假日期（含首含尾，'YYYY-MM-DD'，北京时间的日历日） */
interface HolidaySpan {
  from: string
  to: string
}

/**
 * 中国法定节假日放假日期表（只收录**放假**的日子；调休上班的周末不必收录 —— 周末本来就全天谷）。
 *
 * 来源：`国务院办公厅关于 2026 年部分节假日安排的通知`（2025-11-04 发布）。原文摘录（供核对）：
 *   元旦 1/1(四)–1/3(六)，共 3 天（**1/4 周日上班**）
 *   春节 2/15(日)–2/23(一)，共 9 天（**2/14、2/28 周六上班**）
 *   清明 4/4(六)–4/6(一)，共 3 天
 *   劳动节 5/1(五)–5/5(二)，共 5 天（**5/9 周六上班**）
 *   端午 6/19(五)–6/21(日)，共 3 天
 *   中秋 9/25(五)–9/27(日)，共 3 天
 *   国庆 10/1(四)–10/7(三)，共 7 天（**9/20 周日、10/10 周六上班**）
 *
 * ⚠️ **补表**：下一年安排公布后，在此追加同年区间即可（一天一行、含注释原文），无需改判定逻辑；
 *    未补的年份按「周末谷 + 工作日峰」兜底。
 */
const CN_HOLIDAY_SPANS: readonly HolidaySpan[] = [
  { from: '2026-01-01', to: '2026-01-03' }, // 元旦
  { from: '2026-02-15', to: '2026-02-23' }, // 春节
  { from: '2026-04-04', to: '2026-04-06' }, // 清明
  { from: '2026-05-01', to: '2026-05-05' }, // 劳动节
  { from: '2026-06-19', to: '2026-06-21' }, // 端午
  { from: '2026-09-25', to: '2026-09-27' }, // 中秋
  { from: '2026-10-01', to: '2026-10-07' }, // 国庆
]

/** 峰时段：上午 9:00–12:00、下午 14:00–18:00（分钟数，左闭右开） */
const PEAK_RANGES: readonly (readonly [number, number])[] = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/** 兜底扫描上限（天）：连续 400 天都是休息日在现实中不存在，仅防御死循环 */
const MAX_SCAN_DAYS = 400

/** 两位补零 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 北京时间日历键 'YYYY-MM-DD'（入参用 UTC 分量读，调用方负责已换算） */
function dateKey(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** 展开放假区间为逐日 key 集合（模块加载时算一次） */
function buildHolidaySet(spans: readonly HolidaySpan[]): Set<string> {
  const set = new Set<string>()
  for (const { from, to } of spans) {
    const cur = new Date(`${from}T00:00:00Z`)
    const end = new Date(`${to}T00:00:00Z`)
    if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) continue // 写错格式就跳过，不崩
    while (cur.getTime() <= end.getTime()) {
      set.add(dateKey(cur))
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
  }
  return set
}

const CN_HOLIDAY_SET: ReadonlySet<string> = buildHolidaySet(CN_HOLIDAY_SPANS)

/**
 * 北京时间（UTC+8）换算：直接用本地时间 + 时区偏移，避免依赖 Intl 时区名
 * （WebView 有的不含 Asia/Shanghai）。返回的 Date 请一律用 getUTC* 读分量。
 */
function toBeijing(date: Date): Date {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
}

/** 该北京时间日期是否为**非工作日**：周末（含调休上班的周末）或法定节假日 */
function isRestDay(bjDay: Date): boolean {
  const weekday = bjDay.getUTCDay() // 0=周日 ... 6=周六
  if (weekday === 0 || weekday === 6) return true
  return CN_HOLIDAY_SET.has(dateKey(bjDay))
}

/** 是否为峰时刻（已确认当天是工作日） */
function isPeakMinutes(minutes: number): boolean {
  return PEAK_RANGES.some(([start, end]) => minutes >= start && minutes < end)
}

/** 返回当前时刻的 DeepSeek 时段：'peak' | 'valley' */
export function deepseekPeakNow(date: Date = new Date()): 'peak' | 'valley' {
  const bj = toBeijing(date)
  // 周末与法定节假日（含调休上班的周末）：全天谷
  if (isRestDay(bj)) return 'valley'
  // 工作日高峰：9:00–12:00、14:00–18:00
  return isPeakMinutes(bj.getUTCHours() * 60 + bj.getUTCMinutes()) ? 'peak' : 'valley'
}

/** 把 bj 时刻归零到当天 00:00（北京时间） */
function startOfDay(bj: Date): Date {
  const d = new Date(bj.getTime())
  d.setUTCHours(0, 0, 0, 0)
  return d
}

/** 当天 hour:00（北京时间）的时刻 */
function atHour(bjDay: Date, hour: number): Date {
  const d = new Date(bjDay.getTime())
  d.setUTCHours(hour, 0, 0, 0)
  return d
}

/**
 * 从 bj 时刻起，找**下一个峰时段的开始时刻**：
 *   当天是工作日且还没到 9:00 → 当天 9:00；午休中（12:00–14:00）→ 当天 14:00；
 *   其余（已过 18:00、周末、法定节假日、调休上班的周末）→ 逐日找下一个工作日 9:00。
 */
function nextPeakStart(bj: Date): Date {
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  if (!isRestDay(bj)) {
    if (minutes < PEAK_RANGES[0][0]) return atHour(bj, PEAK_RANGES[0][0] / 60)
    if (minutes >= PEAK_RANGES[0][1] && minutes < PEAK_RANGES[1][0]) {
      return atHour(bj, PEAK_RANGES[1][0] / 60)
    }
  }
  const day = startOfDay(bj)
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    day.setUTCDate(day.getUTCDate() + 1)
    if (!isRestDay(day)) return atHour(day, PEAK_RANGES[0][0] / 60)
  }
  return atHour(day, PEAK_RANGES[0][0] / 60) // 不可达：仅防御性返回
}

/**
 * 计算距下一时段切换的剩余时间与下一时段类型
 * @returns { next: 'peak'|'valley'; seconds: number } seconds 为剩余秒数（向上取整，≥1）
 */
export function deepseekNextChange(date: Date = new Date()): { next: 'peak' | 'valley'; seconds: number } {
  const bj = toBeijing(date)
  const now = deepseekPeakNow(date)
  // 下一时段类型
  const next: 'peak' | 'valley' = now === 'peak' ? 'valley' : 'peak'

  // 当前时刻距下一个切换点的毫秒数
  let targetMs: number
  if (now === 'peak') {
    // 高峰段内：切换到谷 = 该段结束（12:00 或 18:00）
    const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
    const endHour = minutes < PEAK_RANGES[0][1] ? PEAK_RANGES[0][1] / 60 : PEAK_RANGES[1][1] / 60
    targetMs = atHour(bj, endHour).getTime()
  } else {
    // 谷段：到下一个峰时段开始（可能是几天后的节后第一个工作日）
    targetMs = nextPeakStart(bj).getTime()
  }
  const remainMs = targetMs - bj.getTime()
  return { next, seconds: Math.max(1, Math.ceil(remainMs / 1000)) }
}

/** 时段中文标签与说明 */
export const DEEPSEEK_PEAK_INFO: Record<'peak' | 'valley', { label: string; title: string }> = {
  peak: {
    label: '峰',
    title: '高峰时段：工作日（周一至周五，法定节假日除外）9:00-12:00、14:00-18:00（北京时间）',
  },
  valley: {
    label: '谷',
    title: '空闲时段：周末全天（含调休上班的周末）、中国法定节假日全天，以及工作日其余时段（北京时间）',
  },
}

/** 倒计时文本（分级，随剩余时间变化）：
 *  - ≥ 2 小时：不显示秒（天级「X天Y小时」与包时一致，小时级「X小时Y分钟」）
 *  - < 2 小时：显示秒（「X小时Y分钟Z秒」/「X分钟Y秒」/「X秒」），由调用方以 1 秒节奏刷新 */
export function fmtPeakCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s >= 7200) {
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`
    if (m > 0) return `${h}小时${m}分钟`
    return `${h}小时`
  }
  // < 2 小时：复用包时规则（带秒）
  return fmtDuration(s)
}

/**
 * 挂件用紧凑倒计时（2026-09/15 用户指定措辞）：如「剩余5时23分」。
 *
 * 与主卡片 `fmtPeakCountdown` 的区别只在**措辞**，口径完全一致（同一套 `deepseekNextChange`
 * 剩余秒数 + 同样的 2 小时分级阈值），因此挂件与主卡片不会出现两个互相矛盾的倒计时：
 *   - ≥ 2 小时（分钟级，带前缀）：「剩余2天1时」/「剩余5时23分」/「剩余5时」
 *   - < 2 小时（带秒，**不带前缀**）：「59分59秒」/「23分05秒」/「45秒」
 *     —— 2026-09/16 用户要求「显示秒数时不显示『剩余』两个字」。
 *
 * 说明：< 2 小时保留秒（与主卡片同一阈值），否则整点前的最后一分钟会显示「剩余0分」——
 * 既在语义上说不通，也会让用户以为倒计时停了。
 *
 * @param withPrefix 是否带「剩余」前缀；仅对带秒（< 2 小时）的文案生效。
 *   默认 false = 带秒时不显示「剩余」（用户要求、挂件实际使用）；
 *   传 true 可得到与旧版一致的文案（仍被测试引用，用于校验阈值与分级不变）。
 */
export function fmtPeakCountdownRemaining(totalSeconds: number, withPrefix = false): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const p = (n: number) => String(n).padStart(2, '0')
  if (s >= 7200) {
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return h > 0 ? `剩余${d}天${h}时` : `剩余${d}天`
    if (m > 0) return `剩余${h}时${p(m)}分`
    return `剩余${h}时`
  }
  // —— 以下为 < 2 小时（带秒）的文案：按用户要求不带「剩余」前缀 ——
  const pre = withPrefix ? '剩余' : ''
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${pre}${h}时${p(m)}分${p(sec)}秒`
  if (m > 0) return `${pre}${m}分${p(sec)}秒`
  return `${pre}${sec}秒`
}

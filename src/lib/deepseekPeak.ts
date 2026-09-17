// DeepSeek 官方 API 峰谷时段判断（官网规则）
// 高峰时段：北京时间 周一至周五 9:00–12:00、14:00–18:00
// 其余（含周末全天、午休、夜间与清晨）均为空闲（谷）时段
// 返回 'peak'（峰）或 'valley'（谷）

import { fmtDuration } from './fmt'

/** 返回当前时刻的 DeepSeek 时段：'peak' | 'valley' */
export function deepseekPeakNow(date: Date = new Date()): 'peak' | 'valley' {
  // 转北京时间（UTC+8）：直接用本地时间 + 时区偏移换算，避免依赖 Intl 时区名（WebView 有的不含 Asia/Shanghai）
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const weekday = bj.getUTCDay() // 0=周日 ... 6=周六（用 UTC 读，因 bj 已手动 +8）
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  // 周末：全天谷
  if (weekday === 0 || weekday === 6) return 'valley'
  // 工作日高峰：9:00–12:00、14:00–18:00
  const amPeak = minutes >= 9 * 60 && minutes < 12 * 60
  const pmPeak = minutes >= 14 * 60 && minutes < 18 * 60
  return amPeak || pmPeak ? 'peak' : 'valley'
}

/** 时段中文标签与说明 */
export const DEEPSEEK_PEAK_INFO: Record<'peak' | 'valley', { label: string; title: string }> = {
  peak: { label: '峰', title: '高峰时段：周一至周五 9:00-12:00、14:00-18:00（北京时间）' },
  valley: { label: '谷', title: '空闲时段：周末全天及工作日其余时段（北京时间）' },
}

/**
 * 计算距下一时段切换的剩余时间与下一时段类型
 * @returns { next: 'peak'|'valley'; seconds: number } seconds 为剩余秒数（向上取整，≥1）
 */
export function deepseekNextChange(date: Date = new Date()): { next: 'peak' | 'valley'; seconds: number } {
  const bj = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const weekday = bj.getUTCDay()
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()

  const now = deepseekPeakNow(date)
  // 下一时段类型
  const next: 'peak' | 'valley' = now === 'peak' ? 'valley' : 'peak'

  // 当前时刻距下一个切换点的毫秒数
  let targetMs: number
  if (weekday === 0 || weekday === 6) {
    // 周末整天谷：下一个切换 = 下周一 9:00（峰）
    const target = new Date(bj.getTime())
    target.setUTCDate(target.getUTCDate() + ((8 - weekday) % 7 || 7)) // 到周一
    target.setUTCHours(9, 0, 0, 0)
    targetMs = target.getTime()
  } else if (now === 'peak') {
    // 工作日高峰段内：切换到谷 = 该段结束（12:00 或 18:00）
    const endHour = minutes < 12 * 60 ? 12 : 18
    const target = new Date(bj.getTime())
    target.setUTCHours(endHour, 0, 0, 0)
    targetMs = target.getTime()
  } else {
    // 工作日谷段：下一个高峰切换点
    if (minutes < 9 * 60) {
      const target = new Date(bj.getTime())
      target.setUTCHours(9, 0, 0, 0)
      targetMs = target.getTime()
    } else if (minutes < 14 * 60) {
      const target = new Date(bj.getTime())
      target.setUTCHours(14, 0, 0, 0)
      targetMs = target.getTime()
    } else {
      // 18:00 后：若今天是周五则切到下周一 9:00，否则次日 9:00
      const target = new Date(bj.getTime())
      const daysToMon = weekday === 5 ? 3 : 1 // 周五 +3 天到周一，其余 +1 天
      target.setUTCDate(target.getUTCDate() + daysToMon)
      target.setUTCHours(9, 0, 0, 0)
      targetMs = target.getTime()
    }
  }
  const remainMs = targetMs - bj.getTime()
  return { next, seconds: Math.max(1, Math.ceil(remainMs / 1000)) }
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
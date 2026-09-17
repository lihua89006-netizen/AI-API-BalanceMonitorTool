// 挂件峰谷倒计时文案测试（lib/deepseekPeak.ts 的 fmtPeakCountdownRemaining）
//
// 重点：挂件文案与主卡片 fmtPeakCountdown 必须**口径一致**（同一套剩余秒数、同样的 2 小时分级阈值），
// 只允许措辞不同——否则挂件与主卡片会出现两个互相矛盾的倒计时。

import { describe, expect, it } from 'vitest'
import {
  deepseekNextChange,
  deepseekPeakNow,
  fmtPeakCountdown,
  fmtPeakCountdownRemaining,
} from '../src/lib/deepseekPeak'

/** 构造北京时间（UTC+8）某天某时刻的 Date */
function bj(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0))
}

describe('fmtPeakCountdownRemaining（挂件措辞）', () => {
  it('用户给的例子：5 小时 23 分 → 剩余5时23分', () => {
    expect(fmtPeakCountdownRemaining(5 * 3600 + 23 * 60)).toBe('剩余5时23分')
  })

  it('分钟补零（两位数口径）', () => {
    expect(fmtPeakCountdownRemaining(5 * 3600 + 3 * 60)).toBe('剩余5时03分')
  })

  it('整点不带分', () => {
    expect(fmtPeakCountdownRemaining(5 * 3600)).toBe('剩余5时')
  })

  it('天级：带小时 / 不带小时', () => {
    expect(fmtPeakCountdownRemaining(2 * 86400 + 3600)).toBe('剩余2天1时')
    expect(fmtPeakCountdownRemaining(2 * 86400)).toBe('剩余2天')
  })

  it('★显示秒数时不带「剩余」两个字（2026-09/16 用户要求）', () => {
    expect(fmtPeakCountdownRemaining(23 * 60 + 5)).toBe('23分05秒')
    expect(fmtPeakCountdownRemaining(45)).toBe('45秒')
    expect(fmtPeakCountdownRemaining(7199)).toBe('1时59分59秒')
    expect(fmtPeakCountdownRemaining(3600)).toBe('1时00分00秒')
    // 不带秒（≥2 小时）时仍保留「剩余」，用户只要求去掉带秒时的前缀
    expect(fmtPeakCountdownRemaining(7200)).toBe('剩余2时')
    expect(fmtPeakCountdownRemaining(5 * 3600 + 23 * 60)).toBe('剩余5时23分')
  })

  it('阈值边界：7199 秒进入带秒区间（避免出现「0分」）', () => {
    expect(fmtPeakCountdownRemaining(7200)).toBe('剩余2时')
    // 7201 秒仍 ≥2 小时 → 分钟级；分钟为 0 时按既有分级省略（与「剩余5时」同规则）
    expect(fmtPeakCountdownRemaining(7201)).toBe('剩余2时')
    expect(fmtPeakCountdownRemaining(7199)).toBe('1时59分59秒')
  })

  it('< 2 小时：时/分/秒分级（均不带前缀）', () => {
    expect(fmtPeakCountdownRemaining(3600)).toBe('1时00分00秒')
    expect(fmtPeakCountdownRemaining(23 * 60 + 5)).toBe('23分05秒')
    expect(fmtPeakCountdownRemaining(45)).toBe('45秒')
    expect(fmtPeakCountdownRemaining(0)).toBe('0秒')
  })

  it('负数按 0 处理（不能显示「-1秒」）', () => {
    expect(fmtPeakCountdownRemaining(-5)).toBe('0秒')
  })

  it('withPrefix=true 可得到旧文案（保留该参数用于回归对照）', () => {
    expect(fmtPeakCountdownRemaining(23 * 60 + 5, true)).toBe('剩余23分05秒')
    expect(fmtPeakCountdownRemaining(45, true)).toBe('剩余45秒')
    // 带秒区间之外两种取值一致（前缀本来就在）
    expect(fmtPeakCountdownRemaining(7200, true)).toBe('剩余2时')
    expect(fmtPeakCountdownRemaining(7200, true)).toBe(fmtPeakCountdownRemaining(7200))
  })

  it('与主卡片 fmtPeakCountdown 同阈值、同剩余秒数（只措辞不同）', () => {
    // 同一组秒数下，两者进入「带秒」区间的分界必须一致：7200 及以上不带秒、以下带秒
    const cases = [90000, 86400, 7201, 7200, 7199, 3661, 1385, 59, 1, 0]
    for (const s of cases) {
      const card = fmtPeakCountdown(s)
      // 用 withPrefix 版对照措辞与分级（前缀不影响带秒与否）
      const widgetText = fmtPeakCountdownRemaining(s, true)
      const cardHasSeconds = /秒/.test(card)
      const widgetHasSeconds = /秒/.test(widgetText)
      expect(widgetHasSeconds, `剩余 ${s} 秒时两者带秒与否应一致`).toBe(cardHasSeconds)
      // 小时/分钟的数量也必须一致（措辞不同：小时↔时、分钟↔分）
      const cardHours = Number((card.match(/(\d+)小时/) || [])[1] ?? -1)
      const widgetHours = Number((widgetText.match(/(\d+)时/) || [])[1] ?? -1)
      if (cardHours >= 0) expect(widgetHours).toBe(cardHours)
    }
  })
})

describe('deepseekPeakNow / deepseekNextChange 与北京时间规则', () => {
  it('工作日 9:00-12:00、14:00-18:00 为峰，其余为谷', () => {
    // 2026-09-15 是周二
    expect(deepseekPeakNow(bj(2026, 9, 15, 9, 0))).toBe('peak')
    expect(deepseekPeakNow(bj(2026, 9, 15, 11, 59))).toBe('peak')
    expect(deepseekPeakNow(bj(2026, 9, 15, 12, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 15, 14, 0))).toBe('peak')
    expect(deepseekPeakNow(bj(2026, 9, 15, 17, 59))).toBe('peak')
    expect(deepseekPeakNow(bj(2026, 9, 15, 18, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 15, 3, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 15, 21, 0))).toBe('valley')
  })

  it('周末全天为谷，且下一切换是下周一 9:00', () => {
    const sat = bj(2026, 9, 19, 10, 0) // 周六 10:00（若是工作日属峰时段）
    expect(deepseekPeakNow(sat)).toBe('valley')
    const next = deepseekNextChange(sat)
    expect(next.next).toBe('peak')
    expect(next.seconds).toBe(47 * 3600) // 周六 10:00 → 周一 09:00
  })

  it('峰时段剩余 = 到本段结束（11:00 → 1 小时）', () => {
    const n = deepseekNextChange(bj(2026, 9, 15, 11, 0))
    expect(n.next).toBe('valley')
    expect(n.seconds).toBe(3600)
    // < 2 小时 → 带秒口径，按用户要求不带「剩余」前缀
    expect(fmtPeakCountdownRemaining(n.seconds)).toBe('1时00分00秒')
  })

  it('周五 18:00 后跳到下周一 9:00', () => {
    const n = deepseekNextChange(bj(2026, 9, 18, 18, 0)) // 2026-09-18 周五
    expect(n.next).toBe('peak')
    expect(n.seconds).toBe(63 * 3600)
  })

  it('倒计时秒数永不为 0（至少 1，避免显示「剩余0秒」时刚好已切换）', () => {
    expect(deepseekNextChange(bj(2026, 9, 15, 8, 59)).seconds).toBeGreaterThanOrEqual(1)
    expect(deepseekNextChange(bj(2026, 9, 15, 11, 59)).seconds).toBeGreaterThanOrEqual(1)
  })
})

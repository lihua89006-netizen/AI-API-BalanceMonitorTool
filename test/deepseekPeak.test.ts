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

// DeepSeek 2026-09/19 官方新规：「调休上班的周末、中国法定节假日全天均按空闲时段计费」。
// 放假日期取自《国务院办公厅关于 2026 年部分节假日安排的通知》（2025-11-04 发布）。
describe('法定节假日与调休（2026 新规：节假日 / 调休上班的周末均全天谷）', () => {
  it('中秋 9/25(五)–9/27(日)：三个工作日/周末时段全谷，节后首个工作日 9:00 才回到峰', () => {
    expect(deepseekPeakNow(bj(2026, 9, 25, 9, 0))).toBe('valley') // 当日 9:00（原本是峰开始）
    expect(deepseekPeakNow(bj(2026, 9, 25, 10, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 25, 14, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 26, 10, 0))).toBe('valley') // 周六
    expect(deepseekPeakNow(bj(2026, 9, 27, 15, 0))).toBe('valley') // 周日
    expect(deepseekPeakNow(bj(2026, 9, 24, 10, 0))).toBe('peak') // 节前周四仍是峰
    expect(deepseekPeakNow(bj(2026, 9, 28, 9, 0))).toBe('peak') // 节后周一（工作日）恢复
    // 倒计时按**整段假期**算：9/25 10:00 → 9/28 09:00 = 71 小时
    const n = deepseekNextChange(bj(2026, 9, 25, 10, 0))
    expect(n.next).toBe('peak')
    expect(n.seconds).toBe(71 * 3600)
    // 天级文案（主卡片 / 挂件两套措辞都要能显示"还有 2 天多"）
    expect(fmtPeakCountdown(n.seconds)).toBe('2天23小时')
    expect(fmtPeakCountdownRemaining(n.seconds)).toBe('剩余2天23时')
    // 假期最后一晚：次日 9:00 开工
    expect(deepseekNextChange(bj(2026, 9, 27, 20, 0)).seconds).toBe(13 * 3600)
  })

  it('国庆 10/1(四)–10/7(三)：整段谷；10/8 周四 9:00 恢复峰', () => {
    expect(deepseekPeakNow(bj(2026, 10, 1, 10, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 10, 2, 15, 0))).toBe('valley') // 周五
    expect(deepseekPeakNow(bj(2026, 10, 6, 10, 0))).toBe('valley') // 周二
    expect(deepseekPeakNow(bj(2026, 10, 7, 17, 0))).toBe('valley') // 周三（假期最后一天下午）
    expect(deepseekPeakNow(bj(2026, 10, 8, 9, 0))).toBe('peak')
    expect(deepseekNextChange(bj(2026, 10, 7, 20, 0))).toEqual({ next: 'peak', seconds: 13 * 3600 })
  })

  it('★调休上班的周末仍全天谷（新规核心）：不因"要上班"而计峰', () => {
    // 国庆调休：9/20(周日)、10/10(周六) 上班 → 这两天全天谷，且不产生峰窗口
    expect(deepseekPeakNow(bj(2026, 9, 20, 9, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 20, 10, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 9, 20, 14, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 10, 10, 10, 0))).toBe('valley')
    // 倒计时跳过它们、直奔下一个真正的工作日
    expect(deepseekNextChange(bj(2026, 9, 20, 10, 0))).toEqual({ next: 'peak', seconds: 23 * 3600 }) // → 9/21 周一 9:00
    expect(deepseekNextChange(bj(2026, 10, 10, 14, 0))).toEqual({ next: 'peak', seconds: 43 * 3600 }) // → 10/12 周一 9:00
    // 元旦调休（1/4 周日上班）、春节调休（2/14、2/28 周六上班）、劳动节调休（5/9 周六上班）
    expect(deepseekPeakNow(bj(2026, 1, 4, 10, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 2, 14, 10, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 2, 28, 15, 0))).toBe('valley')
    expect(deepseekPeakNow(bj(2026, 5, 9, 10, 0))).toBe('valley')
  })

  it('元旦 1/1–1/3：放假全谷；1/4 周日（调休上班）仍谷 → 1/5 周一才恢复峰', () => {
    expect(deepseekPeakNow(bj(2026, 1, 1, 10, 0))).toBe('valley') // 周四
    expect(deepseekPeakNow(bj(2026, 1, 2, 15, 0))).toBe('valley') // 周五
    expect(deepseekPeakNow(bj(2026, 1, 3, 10, 0))).toBe('valley') // 周六（本就在放假区间内）
    expect(deepseekPeakNow(bj(2026, 1, 5, 9, 0))).toBe('peak')
    // 1/3 20:00 → 1/5 09:00 = 37 小时（中途的 1/4 是调休上班的周日，不计峰）
    expect(deepseekNextChange(bj(2026, 1, 3, 20, 0))).toEqual({ next: 'peak', seconds: 37 * 3600 })
  })

  it('春节 2/15–2/23（9 天）：整段谷；2/24 周二恢复峰', () => {
    expect(deepseekPeakNow(bj(2026, 2, 16, 10, 0))).toBe('valley') // 周一
    expect(deepseekPeakNow(bj(2026, 2, 20, 15, 0))).toBe('valley') // 周五
    expect(deepseekPeakNow(bj(2026, 2, 23, 10, 0))).toBe('valley') // 假期最后一天（周一）
    expect(deepseekPeakNow(bj(2026, 2, 13, 10, 0))).toBe('peak') // 节前周五
    expect(deepseekPeakNow(bj(2026, 2, 24, 9, 0))).toBe('peak')
    expect(deepseekNextChange(bj(2026, 2, 23, 20, 0))).toEqual({ next: 'peak', seconds: 13 * 3600 })
  })

  it('清明 4/4–4/6、劳动节 5/1–5/5、端午 6/19–6/21 同样整段谷', () => {
    expect(deepseekPeakNow(bj(2026, 4, 6, 10, 0))).toBe('valley') // 清明（周一）
    expect(deepseekNextChange(bj(2026, 4, 6, 10, 0))).toEqual({ next: 'peak', seconds: 23 * 3600 }) // → 4/7 周二
    expect(deepseekPeakNow(bj(2026, 5, 1, 10, 0))).toBe('valley') // 劳动节（周五）
    expect(deepseekPeakNow(bj(2026, 5, 5, 15, 0))).toBe('valley') // 假期最后一天（周二）
    expect(deepseekNextChange(bj(2026, 5, 5, 15, 0))).toEqual({ next: 'peak', seconds: 18 * 3600 }) // → 5/6 周三
    expect(deepseekPeakNow(bj(2026, 6, 19, 10, 0))).toBe('valley') // 端午（周五）
    expect(deepseekNextChange(bj(2026, 6, 19, 10, 0))).toEqual({ next: 'peak', seconds: 71 * 3600 }) // → 6/22 周一
  })

  it('放假表完整性：2026 年"工作日中的放假天"共 19 天（防区间写错）', () => {
    // 3+9+3+5+3+3+7 = 33 天放假，其中落在周一~周五的有 19 天（其余 14 天本就是周末）
    let weekdayHolidays = 0
    for (let m = 1; m <= 12; m++) {
      const daysInMonth = new Date(Date.UTC(2026, m, 0)).getUTCDate()
      for (let d = 1; d <= daysInMonth; d++) {
        const at10 = bj(2026, m, d, 10, 0)
        const wd = at10.getUTCDay() // 该 Date 按 UTC 读即北京时间星期
        if (wd >= 1 && wd <= 5 && deepseekPeakNow(at10) === 'valley') weekdayHolidays++
      }
    }
    expect(weekdayHolidays).toBe(19)
  })

  it('⚠️ 表外年份退回「周末谷 + 工作日峰」老口径（2027 安排公布后补表才精确）', () => {
    // 2027-01-01 是周五：放假表里没有它 → 按工作日算峰（补表后此断言应改）
    expect(deepseekPeakNow(bj(2027, 1, 1, 10, 0))).toBe('peak')
    // 周末规则与年份无关，始终为谷
    expect(deepseekPeakNow(bj(2027, 1, 2, 10, 0))).toBe('valley') // 周六
  })
})

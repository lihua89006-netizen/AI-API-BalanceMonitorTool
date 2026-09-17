// 「今日已用」余额观测测试（lib/usage.ts）
//
// 口径（2026-09/16 换模型）：**消费只由"下降"构成** —— 该函数返回的是 Rust 侧按下降累加出来的
// `debit`，与"当前余额"无关；充值只记在 `credit` 里，永远进不了这个数。
// 覆盖边界：跨天无区间、币种不一致、配额百分比、0 是有效值、老配置（无 debit）回退。

import { describe, expect, it } from 'vitest'
import { balanceOf, isMoneyCurrency, todayKey, todayUsed, type UsageBaseline } from '../src/lib/usage'
import type { QuotaInfo } from '../src/providers/types'

function quota(partial: Partial<QuotaInfo>): QuotaInfo {
  return {
    ok: true,
    providerId: 'deepseek_official',
    displayName: 'DeepSeek官方',
    message: 'ok',
    currency: 'CNY',
    ...partial,
  }
}

/** 当日观测记录 fixture（真实字段见 Rust `UsageBaseline`） */
function baseline(partial: Partial<UsageBaseline> = {}): UsageBaseline {
  return {
    opening: 100,
    currency: 'CNY',
    day: todayKey(),
    last: 100,
    lastAt: 1,
    debit: 0,
    credit: 0,
    ...partial,
  }
}

describe('todayKey', () => {
  it('输出本地日期 YYYY-MM-DD 并补零', () => {
    expect(todayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(todayKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('balanceOf', () => {
  it('remaining 优先，其次 total', () => {
    expect(balanceOf(quota({ remaining: 12.5, total: 99 }))).toBe(12.5)
    expect(balanceOf(quota({ remaining: null, total: 99 }))).toBe(99)
  })

  it('null/NaN/缺失一律返回 null', () => {
    expect(balanceOf(null)).toBeNull()
    expect(balanceOf(undefined)).toBeNull()
    expect(balanceOf(quota({ remaining: null, total: null }))).toBeNull()
    expect(balanceOf(quota({ remaining: Number.NaN }))).toBeNull()
  })

  it('0 是有效余额（不能当缺失处理）', () => {
    expect(balanceOf(quota({ remaining: 0 }))).toBe(0)
  })
})

describe('isMoneyCurrency', () => {
  it('金额币种为 true，配额百分比为空为 false', () => {
    expect(isMoneyCurrency('CNY')).toBe(true)
    expect(isMoneyCurrency('usd')).toBe(true)
    expect(isMoneyCurrency('%')).toBe(false)
    expect(isMoneyCurrency('')).toBe(false)
    expect(isMoneyCurrency(null)).toBe(false)
  })
})

describe('todayUsed = 当日累计下降', () => {
  it('直接返回 debit（与期初/当前余额无关）', () => {
    expect(todayUsed(baseline({ opening: 100, debit: 12 }), 'CNY')).toBe(12)
    // 余额一路上升过（期初 4.38、最后一次读数 54.2）也不影响这个数
    expect(todayUsed(baseline({ opening: 4.38, last: 54.2, debit: 0.18, credit: 50 }), 'CNY')).toBe(0.18)
  })

  it('★ 充值（credit）不进这个数', () => {
    const b = baseline({ debit: 25, credit: 500 })
    expect(todayUsed(b, 'CNY')).toBe(25)
    // 极端对照：把 credit 改成任意值，结果必须逐位相同
    expect(todayUsed({ ...b, credit: 0 }, 'CNY')).toBe(25)
    expect(todayUsed({ ...b, credit: 99999 }, 'CNY')).toBe(25)
  })

  it('0 是有效值（今天还没消费时显示 ¥0.00，不能当缺失）', () => {
    expect(todayUsed(baseline({ debit: 0 }), 'CNY')).toBe(0)
  })

  it('跨天/缺失一律 null（区间由当天首次刷新重建）', () => {
    expect(todayUsed(baseline({ day: '2000-01-01' }), 'CNY')).toBeNull()
    expect(todayUsed(null, 'CNY')).toBeNull()
    expect(todayUsed(undefined, 'CNY')).toBeNull()
  })

  it('币种不一致或非金额币种 → null', () => {
    expect(todayUsed(baseline({ currency: 'CNY' }), 'USD')).toBeNull()
    expect(todayUsed(baseline({ currency: '%' }), '%')).toBeNull()
    expect(todayUsed(baseline(), '')).toBeNull()
  })

  it('币种比较忽略大小写与首尾空白', () => {
    expect(todayUsed(baseline({ currency: 'cny', debit: 12 }), ' CNY ')).toBe(12)
  })

  it('debit 非法（老配置缺该字段/NaN）→ null，由调用方回退状态文案', () => {
    const legacy = { ...baseline(), debit: undefined } as unknown as UsageBaseline
    expect(todayUsed(legacy, 'CNY')).toBeNull()
    expect(todayUsed(baseline({ debit: Number.NaN }), 'CNY')).toBeNull()
  })
})

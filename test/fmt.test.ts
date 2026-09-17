// 金额格式化测试（lib/fmt.ts）
// 重点：fmtMoney 行为**不得因拆分重构而改变**（卡片/余额等大量调用点依赖它）；
// fmtMoneySpaced 只服务于挂件「今日已用」行，且对无前缀符号的币种必须退化为与 fmtMoney 一致。

import { describe, expect, it } from 'vitest'
import { fmtCount, fmtDuration, fmtMoney, fmtMoneyParts, fmtMoneySpaced } from '../src/lib/fmt'

describe('fmtMoney（既有行为回归）', () => {
  it('币种符号与数字紧贴（用户既有要求，勿改）', () => {
    expect(fmtMoney(9.44, 'CNY')).toBe('¥9.44')
    expect(fmtMoney(12, 'USD')).toBe('$12.00')
    expect(fmtMoney(1.5, 'RMB')).toBe('¥1.50')
  })

  it('千分位与两位小数', () => {
    expect(fmtMoney(1234567.891, 'CNY')).toBe('¥1,234,567.89')
  })

  it('配额百分比紧贴数字、无空格', () => {
    expect(fmtMoney(88, '%')).toBe('88.00%')
  })

  it('未知币种：数字 + 空格 + 币种代码', () => {
    expect(fmtMoney(5, 'JPY')).toBe('5.00 JPY')
  })

  it('缺失/非法值 → 横线', () => {
    expect(fmtMoney(null, 'CNY')).toBe('-')
    expect(fmtMoney(undefined, 'CNY')).toBe('-')
    expect(fmtMoney(Number.NaN, 'CNY')).toBe('-')
    expect(fmtMoney(Number.POSITIVE_INFINITY, 'CNY')).toBe('-')
  })

  it('-0 显示为 0.00（不出现负零）', () => {
    expect(fmtMoney(-0, 'CNY')).toBe('¥0.00')
  })

  it('币种大小写与空格不敏感', () => {
    expect(fmtMoney(1, ' cny ')).toBe('¥1.00')
  })

  it('负数保留符号', () => {
    expect(fmtMoney(-42.5, 'CNY')).toBe('¥-42.50')
  })
})

describe('fmtMoneyParts（拆分）', () => {
  it('有币种符号时前缀是符号、其余是数字', () => {
    expect(fmtMoneyParts(9.44, 'CNY')).toEqual({ prefix: '¥', rest: '9.44' })
    expect(fmtMoneyParts(12, 'USD')).toEqual({ prefix: '$', rest: '12.00' })
  })

  it('百分比是后缀不是前缀（间隙逻辑据此自动跳过）', () => {
    expect(fmtMoneyParts(88, '%')).toEqual({ prefix: '', rest: '88.00%' })
  })

  it('未知币种无前缀', () => {
    expect(fmtMoneyParts(5, 'JPY')).toEqual({ prefix: '', rest: '5.00 JPY' })
  })

  it('无值返回空前缀 + 横线', () => {
    expect(fmtMoneyParts(null, 'CNY')).toEqual({ prefix: '', rest: '-' })
  })
})

describe('fmtMoneySpaced（挂件「今日已用」行专用）', () => {
  it('默认用一个普通空格分隔符号与数字', () => {
    expect(fmtMoneySpaced(3.49, 'CNY')).toBe('¥ 3.49')
  })

  it('可指定更窄的间隙（挂件实际用 U+2009 THIN SPACE）', () => {
    expect(fmtMoneySpaced(3.49, 'CNY', '\u2009')).toBe('¥\u20093.49')
  })

  it('百分比/未知币种/无值 → 与 fmtMoney 完全一致（不引入多余空格）', () => {
    for (const [v, c] of [
      [88, '%'],
      [5, 'JPY'],
      [null, 'CNY'],
    ] as [number | null, string][]) {
      expect(fmtMoneySpaced(v, c)).toBe(fmtMoney(v, c))
    }
  })

  it('间隙不改变数字部分（拆分无副作用）', () => {
    expect(fmtMoneySpaced(1234567.891, 'CNY', '\u2009')).toBe('¥\u20091,234,567.89')
  })
})

describe('fmtCount / fmtDuration（回归）', () => {
  it('次数取整千分位，无值横线', () => {
    expect(fmtCount(1234.6)).toBe('1,235')
    expect(fmtCount(null)).toBe('—')
  })

  it('时长分级', () => {
    expect(fmtDuration(4800)).toBe('1小时20分钟')
    expect(fmtDuration(59)).toBe('59秒')
  })
})

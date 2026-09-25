// 桌宠数据组装（lib/petOverlay.ts）单测。
//
// 重点：桌宠显示的每一行都必须与桌面挂件**同口径**（这是方案里"口径唯一"的落点），
// 所以这里钉的是三件事：
//   ① 取值口径：余额 remaining 优先退化 total、无数据 '-'；
//   ② 「今日已用」优先于状态文案、跨天/币种不一致时**必须回退**（不能显示一个错的数）；
//   ③ 峰谷行的判断与倒计时文案（含 2 小时阈值换挡）与主卡片/挂件一致。
import { describe, expect, it } from 'vitest'
import {
  buildPetPayload,
  nextPetUid,
  petBalance,
  petName,
  petPeak,
  petPeakTickMs,
  petStatus,
  pickPetUid,
} from '../src/lib/petOverlay'
import { todayKey, type UsageBaseline } from '../src/lib/usage'
import type { AppConfig, ProviderEntry } from '../src/lib/store'
import type { QuotaInfo } from '../src/providers/types'

/** 币种符号与数字之间的细空格（U+2009，与挂件「今日已用」行同一处理） */
const THIN = '\u2009'

function entry(over: Partial<ProviderEntry> = {}): ProviderEntry {
  return {
    uid: 'u1',
    providerId: 'deepseek_official',
    displayName: 'DeepSeek 官方',
    enabled: true,
    autoRefreshMinutes: 30,
    config: {},
    ...over,
  }
}

function info(over: Partial<QuotaInfo> = {}): QuotaInfo {
  return {
    ok: true,
    providerId: 'deepseek_official',
    displayName: 'DeepSeek官方',
    message: 'ok',
    currency: 'CNY',
    remaining: 12.34,
    ...over,
  }
}

function cfg(providers: ProviderEntry[], lastWidgetUid: string | null = null): AppConfig {
  return { autoRefreshMinutes: 30, theme: 'light', providers, lastWidgetUid }
}

function baseline(over: Partial<UsageBaseline> = {}): UsageBaseline {
  return {
    opening: 12.75,
    currency: 'CNY',
    day: todayKey(),
    last: 12.34,
    lastAt: 1_700_000_000_000,
    debit: 0.41,
    credit: 0,
    ...over,
  }
}

describe('petName（站名）', () => {
  it('去掉所有空白字符（与桌面挂件同口径）', () => {
    expect(petName({ displayName: 'DeepSeek 官方' })).toBe('DeepSeek官方')
    expect(petName({ displayName: ' 绿洲 API ' })).toBe('绿洲API')
  })

  it('空名兜底，避免画出一行空白', () => {
    expect(petName({ displayName: '' })).toBe('未命名站点')
    expect(petName({ displayName: '   ' })).toBe('未命名站点')
  })
})

describe('petBalance（余额行）', () => {
  it('remaining 优先，退化到 total', () => {
    expect(petBalance(info({ remaining: 12.34 }))).toBe('¥12.34')
    expect(petBalance(info({ remaining: null, total: 5 }))).toBe('¥5.00')
    expect(petBalance(info({ remaining: undefined, total: 5 }))).toBe('¥5.00')
  })

  it('无数据与桌面挂件一样是 "-"（不是 0）', () => {
    expect(petBalance(info({ remaining: null, total: null }))).toBe('-')
    expect(petBalance(null)).toBe('-')
    expect(petBalance(undefined)).toBe('-')
  })

  it('配额百分比（% 非金额）照旧紧贴数字', () => {
    expect(petBalance(info({ remaining: 88, currency: '%' }))).toBe('88.00%')
  })
})

describe('petStatus（状态行）', () => {
  it('有当日账本时优先显示「今日已用」（与挂件同一取舍）', () => {
    const r = petStatus(info(), baseline({ debit: 0.41 }))
    expect(r.kind).toBe('used')
    expect(r.text).toBe(`今日已用 ¥${THIN}0.41`)
  })

  it('跨天（账本不是今天）必须回退到状态文案，不能显示昨天的数', () => {
    const r = petStatus(info(), baseline({ day: '2000-01-01' }))
    expect(r).toEqual({ text: '数据正常', kind: 'ok' })
  })

  it('币种与账本不一致时同样回退（观测值无意义）', () => {
    const r = petStatus(info({ currency: 'USD' }), baseline({ currency: 'CNY' }))
    expect(r).toEqual({ text: '数据正常', kind: 'ok' })
  })

  it('还没有任何结果 → 等待刷新（悬浮窗点不到鲸鱼，故不能沿用挂件的"点击刷新"文案）', () => {
    expect(petStatus(null, null)).toEqual({ text: '等待刷新…', kind: 'busy' })
  })

  it('失败 → 显示适配器给的原因，配色走 err', () => {
    expect(petStatus(info({ ok: false, message: 'API Key 无效' }), null)).toEqual({
      text: 'API Key 无效',
      kind: 'err',
    })
    expect(petStatus(info({ ok: false, message: '' }), null)).toEqual({ text: '查询失败', kind: 'err' })
  })

  it('失败但账本仍在时依然显示「今日已用」（数字是本地推算的，不因一次失败作废）', () => {
    const r = petStatus(info({ ok: false, message: '超时', remaining: 12.34 }), baseline())
    expect(r.kind).toBe('used')
  })
})

describe('petPeak（峰谷行）', () => {
  it('只有 DeepSeek 官方站有，其它站点整行为空', () => {
    expect(petPeak('max66')).toEqual({ label: '', text: '', kind: '' })
    expect(petPeak('aliyun')).toEqual({ label: '', text: '', kind: '' })
  })

  it('工作日 10:00（北京）＝高峰，距 12:00 剩 2 小时 → 分钟级文案带「剩余」', () => {
    // 2026-09-18 是周五；02:00Z + 8h = 10:00 北京时间
    expect(petPeak('deepseek_official', new Date('2026-09-18T02:00:00Z'))).toEqual({
      label: '峰',
      text: '剩余2时',
      kind: 'peak',
    })
  })

  it('工作日 13:00（北京）＝空闲，距 14:00 剩 1 小时 → 秒级文案不带「剩余」', () => {
    expect(petPeak('deepseek_official', new Date('2026-09-18T05:00:00Z'))).toEqual({
      label: '谷',
      text: '1时00分00秒',
      kind: 'valley',
    })
  })
})

describe('petPeakTickMs（峰谷倒计时刷新节奏）', () => {
  it('与主卡片/挂件同阈值：< 2 小时按秒刷，否则 10 秒', () => {
    expect(petPeakTickMs('deepseek_official', new Date('2026-09-18T02:00:00Z'))).toBe(10_000) // 正好 7200s
    expect(petPeakTickMs('deepseek_official', new Date('2026-09-18T05:00:00Z'))).toBe(1000)
    expect(petPeakTickMs('max66')).toBe(0) // 非 DeepSeek 站不需要刷新
  })
})

describe('buildPetPayload（整份组装）', () => {
  it('四行文字 + 配色 key 一次到位', () => {
    const payload = buildPetPayload(
      entry(),
      info({ remaining: 61.77 }),
      baseline({ debit: 0.41 }),
      new Date('2026-09-18T05:00:00Z'),
    )
    expect(payload).toEqual({
      uid: 'u1',
      name: 'DeepSeek官方',
      balance: '¥61.77',
      status: `今日已用 ¥${THIN}0.41`,
      statusKind: 'used',
      peakLabel: '谷',
      peakText: '1时00分00秒',
      peakKind: 'valley',
    })
  })

  it('非 DeepSeek 站点：峰谷字段为空串（原生层据此隐藏该行并把三行上移）', () => {
    const payload = buildPetPayload(entry({ providerId: 'max66', displayName: 'Max66' }), null, null)
    expect(payload.peakLabel).toBe('')
    expect(payload.peakText).toBe('')
    expect(payload.peakKind).toBe('')
    expect(payload.name).toBe('Max66')
  })
})

describe('pickPetUid / nextPetUid（站点选择与切换）', () => {
  const a = entry({ uid: 'u1', displayName: 'A' })
  const b = entry({ uid: 'u2', displayName: 'B' })

  it('默认站点：上次展示过的 → 列表第一张卡', () => {
    expect(pickPetUid(cfg([a, b], 'u2'))).toBe('u2')
    expect(pickPetUid(cfg([a, b], null))).toBe('u1')
    expect(pickPetUid(cfg([a, b], 'gone'))).toBe('u1') // 站点已删 → 回退
  })

  it('没有站点时返回 null（前端提示先添加站点）', () => {
    expect(pickPetUid(null)).toBeNull()
    expect(pickPetUid(cfg([]))).toBeNull()
  })

  it('切换站点按配置顺序循环', () => {
    expect(nextPetUid(cfg([a, b]), 'u1')).toBe('u2')
    expect(nextPetUid(cfg([a, b]), 'u2')).toBe('u1') // 回环
    expect(nextPetUid(cfg([a, b]), null)).toBe('u1')
    expect(nextPetUid(cfg([a, b]), 'gone')).toBe('u1')
    expect(nextPetUid(cfg([]), 'u1')).toBeNull()
  })
})

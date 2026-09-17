// 「启动时自动打开桌宠模式」判定与站点选择测试（src/lib/autoWidget.ts）
//
// 这段逻辑一旦写错，表现是"启动没反应"而不是报错（历史上踩过：effect 依赖写错 → 定时器被取消）。
// 故把三态归一与站点选择抽成纯函数并在这里钉住，覆盖：
//   ① 老配置兼容（只有布尔 autoOpenWidget）② 模式字段优先 ③ 各模式选哪个站点 ④ 回退链

import { describe, expect, it } from 'vitest'
import { AUTO_WIDGET_MODES, autoWidgetEnabled, autoWidgetMode, pickAutoOpenUid } from '../src/lib/autoWidget'
import type { AppConfig, ProviderEntry } from '../src/lib/store'

function site(uid: string, enabled = true): ProviderEntry {
  return {
    uid,
    providerId: 'deepseek_official',
    displayName: uid,
    enabled,
    autoRefreshMinutes: 0,
    config: {},
  }
}

/** 只填本用例关心的字段（其余走默认） */
function cfg(partial: Partial<AppConfig>): AppConfig {
  return { autoRefreshMinutes: 0, theme: 'light', providers: [], ...partial }
}

describe('autoWidgetMode（三态归一 + 老配置兼容）', () => {
  it('模式字段为空时由老布尔字段推导（true → last，false/缺省 → off）', () => {
    expect(autoWidgetMode(cfg({ autoOpenWidget: true }))).toBe('last')
    expect(autoWidgetMode(cfg({ autoOpenWidget: false }))).toBe('off')
    expect(autoWidgetMode(cfg({}))).toBe('off')
  })

  it('有模式字段时以它为准（老布尔字段不再参与）', () => {
    expect(autoWidgetMode(cfg({ autoOpenWidgetMode: 'pinned', autoOpenWidget: false }))).toBe('pinned')
    expect(autoWidgetMode(cfg({ autoOpenWidgetMode: 'off', autoOpenWidget: true }))).toBe('off')
    expect(autoWidgetMode(cfg({ autoOpenWidgetMode: ' last ' }))).toBe('last') // 容错首尾空白
  })

  it('非法/未知模式值一律回退到老布尔语义（不抛错、不静默当成开启）', () => {
    expect(autoWidgetMode(cfg({ autoOpenWidgetMode: '???', autoOpenWidget: true }))).toBe('last')
    expect(autoWidgetMode(cfg({ autoOpenWidgetMode: '???', autoOpenWidget: false }))).toBe('off')
  })

  it('null/undefined 配置 = 关闭自动', () => {
    expect(autoWidgetMode(null)).toBe('off')
    expect(autoWidgetMode(undefined)).toBe('off')
    expect(autoWidgetEnabled(cfg({ autoOpenWidgetMode: 'pinned' }))).toBe(true)
    expect(autoWidgetEnabled(cfg({ autoOpenWidgetMode: 'off' }))).toBe(false)
  })

  it('下拉框选项就是三态，且顺序固定', () => {
    expect(AUTO_WIDGET_MODES.map((o) => o.value)).toEqual(['off', 'last', 'pinned'])
    expect(AUTO_WIDGET_MODES.map((o) => o.label)).toEqual(['关闭自动', '上次站点', '置顶站点'])
  })
})

describe('pickAutoOpenUid（启动时打开哪个站点）', () => {
  const providers = [site('pinned-1'), site('second'), site('third')]

  it('关闭自动 → 不打开（null）', () => {
    expect(pickAutoOpenUid(cfg({ providers, autoOpenWidgetMode: 'off' }))).toBeNull()
    expect(pickAutoOpenUid(cfg({ providers, autoOpenWidget: false }))).toBeNull()
  })

  it('上次站点 → 打开 lastWidgetUid 记的那个', () => {
    expect(
      pickAutoOpenUid(cfg({ providers, autoOpenWidgetMode: 'last', lastWidgetUid: 'third' })),
    ).toBe('third')
  })

  it('上次站点但记录缺失/已停用 → 回退第一个启用站点', () => {
    expect(pickAutoOpenUid(cfg({ providers, autoOpenWidgetMode: 'last' }))).toBe('pinned-1')
    expect(
      pickAutoOpenUid(cfg({ providers, autoOpenWidgetMode: 'last', lastWidgetUid: 'gone' })),
    ).toBe('pinned-1')
    const withDisabled = [site('first-off', false), site('second')]
    expect(
      pickAutoOpenUid(
        cfg({ providers: withDisabled, autoOpenWidgetMode: 'last', lastWidgetUid: 'first-off' }),
      ),
    ).toBe('second')
  })

  it('置顶站点 → 打开列表第一张卡（与 lastWidgetUid 无关）', () => {
    expect(
      pickAutoOpenUid(cfg({ providers, autoOpenWidgetMode: 'pinned', lastWidgetUid: 'third' })),
    ).toBe('pinned-1')
  })

  it('置顶站点但第一张被停用 → 跳到第一个启用站点（避免"启动没反应"）', () => {
    const withDisabled = [site('top-off', false), site('second')]
    expect(pickAutoOpenUid(cfg({ providers: withDisabled, autoOpenWidgetMode: 'pinned' }))).toBe(
      'second',
    )
  })

  it('全部停用 / 列表为空 / 配置缺失 → null（调用方静默跳过）', () => {
    const allOff = [site('a', false), site('b', false)]
    expect(pickAutoOpenUid(cfg({ providers: allOff, autoOpenWidgetMode: 'pinned' }))).toBe('a')
    expect(pickAutoOpenUid(cfg({ providers: allOff, autoOpenWidgetMode: 'last' }))).toBe('a')
    expect(pickAutoOpenUid(cfg({ providers: [], autoOpenWidgetMode: 'pinned' }))).toBeNull()
    expect(pickAutoOpenUid(null)).toBeNull()
  })

  it('老配置（只有 autoOpenWidget=true）走"上次站点"语义', () => {
    expect(
      pickAutoOpenUid(cfg({ providers, autoOpenWidget: true, lastWidgetUid: 'second' })),
    ).toBe('second')
  })
})

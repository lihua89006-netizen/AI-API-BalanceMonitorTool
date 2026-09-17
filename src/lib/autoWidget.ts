// 「启动自动打开桌宠（鲸鱼娘挂件）」的模式判定与站点选择 —— 纯函数，便于单测。
//
// 2026-09/16 用户口径：原来的滑动开关「启动时自动打开鲸鱼娘窗口(上次选择)」改成**下拉框三选一**：
//   - 关闭自动：启动时不打开挂件
//   - 上次站点：打开 `lastWidgetUid` 记的那个（= 原开关打开时的行为）
//   - 置顶站点：打开**站点列表最上面那张卡**（用户拖拽排序后即第一张）
//
// ⚠️ 兼容老配置：早期只有布尔字段 `autoOpenWidget`。`autoWidgetMode()` 负责归一：
//    有 `autoOpenWidgetMode`（非空且合法）以它为准，否则 `true → 'last'`、`false → 'off'`。
// ⚠️ 为什么把这段抽出来：判定一旦写错，表现是"启动没反应"而不是报错。历史上就为这类问题踩过坑
//    （effect 依赖写成 `[cfg]` → 定时器被 cleanup 取消 → 挂件永远打不开），故把可测的部分隔离出来。

import type { AppConfig, AutoWidgetMode } from './store'

/** 下拉框选项（顺序即界面顺序） */
export const AUTO_WIDGET_MODES: { value: AutoWidgetMode; label: string }[] = [
  { value: 'off', label: '关闭自动' },
  { value: 'last', label: '上次站点' },
  { value: 'pinned', label: '置顶站点' },
]

type AutoWidgetConfig = Pick<AppConfig, 'autoOpenWidgetMode' | 'autoOpenWidget' | 'providers' | 'lastWidgetUid'>

/** 老配置兼容：把 `autoOpenWidgetMode` / `autoOpenWidget` 归一到三态 */
export function autoWidgetMode(
  cfg: Pick<AppConfig, 'autoOpenWidgetMode' | 'autoOpenWidget'> | null | undefined,
): AutoWidgetMode {
  const m = String(cfg?.autoOpenWidgetMode ?? '').trim()
  if (m === 'off' || m === 'last' || m === 'pinned') return m
  return cfg?.autoOpenWidget === true ? 'last' : 'off'
}

/** 该配置下启动时是否要自动打开挂件（`'off'` 之外都要） */
export function autoWidgetEnabled(cfg: AutoWidgetConfig | null | undefined): boolean {
  return autoWidgetMode(cfg) !== 'off'
}

/**
 * 选出启动时要打开的站点 uid；返回 `null` 表示"不该打开 / 没有可用站点"。
 * - `'off'`    → null
 * - `'last'`   → `lastWidgetUid` 那个（仍存在且启用）→ 回退第一个启用站点 → 再回退列表第一张
 * - `'pinned'` → **列表第一个启用**的站点（= 置顶那张卡；它被停用时跳过）→ 再回退列表第一张
 *   （回退链与 `'last'` 一致：宁可开一个能用的，也不要因为首张卡被停用而"启动没反应"）
 */
export function pickAutoOpenUid(cfg: AutoWidgetConfig | null | undefined): string | null {
  if (!cfg) return null
  const mode = autoWidgetMode(cfg)
  if (mode === 'off') return null
  const providers = Array.isArray(cfg.providers) ? cfg.providers : []
  if (providers.length === 0) return null
  const firstEnabled = providers.find((p) => p.enabled)
  if (mode === 'pinned') return (firstEnabled ?? providers[0]).uid
  const remembered = cfg.lastWidgetUid
    ? providers.find((p) => p.uid === cfg.lastWidgetUid && p.enabled)
    : undefined
  return (remembered ?? firstEnabled ?? providers[0]).uid
}

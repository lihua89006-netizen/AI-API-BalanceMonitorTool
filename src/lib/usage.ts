// 「今日已用」——余额**观测**（不额外请求任何接口）。
//
// ⚠️ 口径（2026-09/16 换模型）：**消费只由"下降"构成**。
//   余额接口只给快照、不给流水，所以"余额涨了"既可能是充值也可能是赠金/纠错。
//   旧模型把充值当**修正项**加进消费（`水位 + 已登记充值 − 当前余额`）→ 充值被算了两次，
//   显示值恒多出整整一个充值额、且判据下界被抬高到"再充小额也不提示"。
//   现在改成**升降分开累计**（对齐开源实现 DeepSeek-Balance-Whale-Widget 的账本思路）：
//     - 每次观测与上次读数比较：下降累加进 `debit`（= 今日已用）、上升只累加进 `credit`
//     - 于是充值在结构上**不可能**污染这个数字：它单调不减、恒 ≥ 0、也不需要用户登记任何金额
//
//   如实的边界（本地推算的固有代价，别当成账单）：
//     - **起点之前的消费不在本区间内**：区间 = 当天第一次成功查询的那一刻起
//     - 充值**与**消费落在同一次刷新间隔内时，净结果是一次上升 → 那部分消费观测不到
//     - 币种变了会重开区间（数值跳变不是消费）；跨天没有昨天的数据
//     - 数据全部本地推算、存在 config.json 的 `usageBaselines`（按站点 uid）

import { invoke } from '@tauri-apps/api/core'
import type { QuotaInfo } from '../providers/types'

/** 本地日期键（YYYY-MM-DD，本机时区的「今天」；跨天换区间以此为准） */
export function todayKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 站点当前余额（与挂件/卡片取值口径一致：remaining 优先，退化到 total） */
export function balanceOf(info: QuotaInfo | null | undefined): number | null {
  if (!info) return null
  const v = info.remaining ?? info.total
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 该币种是否适合做「余额观测」推算（排除配额百分比等非金额单位） */
export function isMoneyCurrency(currency: string | null | undefined): boolean {
  const c = String(currency || '').trim().toUpperCase()
  return c !== '' && c !== '%'
}

/** 当日余额观测记录（与 Rust `UsageBaseline` 一一对应） */
export interface UsageBaseline {
  /** 当日首个观测到的余额（本区间的期初） */
  opening: number
  currency: string
  /** 记录日期（YYYY-MM-DD，本机时区） */
  day: string
  /** 上次读到的余额 */
  last: number
  /** 上次观测时刻（毫秒时间戳；Rust 用它丢弃重复/迟到样本） */
  lastAt: number
  /** 当日**累计下降** = 今日已用 */
  debit: number
  /** 当日**累计上升**（充值/赠金/纠错）。只记录，不参与消费计算 */
  credit: number
}

export interface UsageBaselines {
  [uid: string]: UsageBaseline
}

/**
 * 上报一次余额观测（Rust 侧按"下降"累加消费，见 `config.rs::observe`）。
 *
 * ⚠️ `at` 必须是**本次读数**的时刻：挂件 60s 刷新与主界面各自上报，会乱序到达；
 * Rust 用 `at <= lastAt` 丢弃重复/迟到样本，否则会凭空造出一段"下降"或"上升"。
 * 整条链路失败一律静默——它只是状态行上的一行附加信息，绝不能影响刷新主流程。
 */
export async function recordUsageBaseline(uid: string, info: QuotaInfo, at = Date.now()): Promise<void> {
  if (!info.ok) return
  const value = balanceOf(info)
  if (value === null) return
  if (!isMoneyCurrency(info.currency)) return
  try {
    await invoke('record_usage_baseline', {
      uid,
      value,
      currency: (info.currency || 'CNY').trim(),
      day: todayKey(),
      at: Math.round(at),
    })
  } catch (e) {
    console.error('记录余额观测失败：', e)
  }
}

/**
 * 「今日已用」= 当日累计下降。
 *
 * 充值不进这个数（上升只记在 `credit` 里），因此它**单调不减、恒 ≥ 0**，也不需要用户
 * 登记任何充值金额。无法推算时返回 null（调用方据此回退到原有状态文案）：
 *   - 今天还没有区间（跨天后的第一次刷新之前 / 站点从未刷新成功）
 *   - 非金额币种（`%` 配额、按次/包时）
 *   - 币种与区间记录不一致（用户改了显示币种，或适配器口径变了）
 */
export function todayUsed(
  baseline: UsageBaseline | null | undefined,
  currency: string | null | undefined,
): number | null {
  if (!baseline) return null
  if (baseline.day !== todayKey()) return null // 跨天无区间（区间由当天首次刷新重建）
  if (!isMoneyCurrency(currency)) return null
  if (String(baseline.currency || '').trim().toUpperCase() !== String(currency || '').trim().toUpperCase()) {
    return null // 币种口径不同，观测值无意义
  }
  return Number.isFinite(baseline.debit) ? baseline.debit : null
}

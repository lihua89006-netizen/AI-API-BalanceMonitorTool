// 方案数据行（卡片主数据区 / 操作弹窗方案区 共用）：金额 + 方案标签 + 状态

import { PLANS } from '../lib/plans'
import type { PlanId } from '../lib/plans'
import type { QuotaInfo } from '../providers/types'
import { fmtMoney, fmtCount, fmtDuration } from '../lib/fmt'

export default function PlanValue({
  plan,
  q,
  big,
  statusEmoji,
  statusKey,
  statusTip,
  statusText,
}: {
  plan: PlanId
  q?: QuotaInfo
  big?: boolean
  /** 状态 emoji（合并到方案标签旁显示，如「按量余额 ✅」） */
  statusEmoji?: string
  statusKey?: string
  /** 状态悬浮提示（如失败原因） */
  statusTip?: string
  /** emoji 右侧的状态文字（如「刷新中」） */
  statusText?: string
}) {
  const label = PLANS.find((p) => p.id === plan)?.label ?? plan
  if (!q) {
    return (
      <div className={`plan-value ${big ? 'big' : ''}`}>
        <span className="card-balance plan-muted plan-empty">—</span>
        <span className="plan-value-tag plan-tag">{label}</span>
        {statusEmoji && (
          <span className={`card-status status-${statusKey ?? ''}`} title={statusTip}>
            {statusEmoji}
          </span>
        )}
      </div>
    )
  }
  const value = q.remaining ?? q.total
  // 方案专属数值格式：按次 → 「次数次」；包时 → 时长（remaining 单位为秒）；
  // 其余方案（按量/套餐）→ 金额
  const text =
    value === null || value === undefined
      ? '—'
      : plan === 'times'
        ? `${fmtCount(value)}次`
        : plan === 'duration'
          ? fmtDuration(value)
          : fmtMoney(value, q.currency)
  const ok = q.ok
  // 无数据（ok=false 且无值，如「无套餐订阅」）→ 灰色横线（信息性）；有值但失败 → 红色
  const noData = !ok && (q.remaining === null || q.remaining === undefined) && (q.total === null || q.total === undefined)
  return (
    <div className={`plan-value ${big ? 'big' : ''}`}>
      <span className={`card-balance ${ok ? '' : noData ? 'plan-muted' : 'err'}`}>{text}</span>
      <span className="plan-value-tag plan-tag">{label}</span>
      {statusEmoji && (
        <span className={`card-status status-${statusKey ?? ''}`} title={statusTip}>
          {statusEmoji}
          {statusText && <span className="status-text">{statusText}</span>}
        </span>
      )}
    </div>
  )
}
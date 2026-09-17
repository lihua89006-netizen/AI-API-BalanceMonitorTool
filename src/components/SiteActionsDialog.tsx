// 安卓端站点操作弹窗：卡片单击弹出
// 内容：站点信息 + 操作按钮（刷新/编辑/删除/打开官网）+ 全部计费方案（含设为主卡）
// 取代卡片内的按钮块、官网点击与多方案收纳条/次级卡片设计（安卓端）

import { openUrl } from '@tauri-apps/plugin-opener'
import { PLANS, entryPlans, entryPrimaryPlan } from '../lib/plans'
import type { PlanId } from '../lib/plans'
import PlanValue from './PlanValue'
import type { ProviderEntry } from '../lib/store'
import type { QuotaInfo } from '../providers/types'
import { PROVIDERS } from '../providers/registry'
import { ExternalLink, Pencil, RefreshCw, Trash2 } from 'lucide-react'

interface SiteActionsDialogProps {
  entry: ProviderEntry
  info?: QuotaInfo
  refreshing?: boolean
  onRefresh: (entry: ProviderEntry) => void
  onEdit: (entry: ProviderEntry) => void
  onDelete: (entry: ProviderEntry) => void
  /** 切换主显示方案（持久化 primaryPlan） */
  onSetPrimary: (uid: string, plan: PlanId) => void
  onClose: () => void
}

export default function SiteActionsDialog({
  entry,
  info,
  refreshing,
  onRefresh,
  onEdit,
  onDelete,
  onSetPrimary,
  onClose,
}: SiteActionsDialogProps) {
  const plans = entryPlans(entry.config)
  const primary = entryPrimaryPlan(entry.config)
  const planData: Record<string, QuotaInfo> | undefined = info?.plans ?? (info ? { paygo: info } : undefined)

  // 打开官网（与 Windows 卡片上点站名/图标行为一致，此处做成按钮）
  const provider = PROVIDERS.find((p) => p.id === entry.providerId)
  const websiteUrl = provider?.getWebsiteUrl
    ? provider.getWebsiteUrl(entry.config)
    : provider?.websiteUrl ?? ''
  const showOpenSite = /^https?:\/\//i.test(websiteUrl)
  const handleOpenSite = () => {
    if (showOpenSite) openUrl(websiteUrl)
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog actions-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{entry.displayName}</h2>

        {/* 打开站点网站：放在最上面（紧随标题） */}
        {showOpenSite && (
          <div className="actions-row site-actions-row">
            <button
              className="card-btn"
              onClick={handleOpenSite}
              aria-label="打开站点网站"
            >
              <ExternalLink size={14} strokeWidth={2.2} /> 打开站点网站
            </button>
          </div>
        )}

        {/* 全部计费方案（含展示/当前展示）：取代卡片内的多方案收纳条/次级卡片 */}
        <div className="actions-plans">
          {plans.map((p) => {
            const q = planData?.[p]
            const isMain = p === primary
            // 信息性无数据（ok=false 无值，如「无套餐订阅」）→ 中性灰 ○；真失败 → 红 ❌
            const noData =
              !!q && !q.ok &&
              (q.remaining === null || q.remaining === undefined) &&
              (q.total === null || q.total === undefined)
            const subStatusKey = !q || noData ? 'idle' : q.ok ? 'ok' : 'err'
            const subEmoji = !q || noData ? '○' : q.ok ? '✅' : '❌'
            const subTip = q && !q.ok && !noData ? q.message : ''
            return (
              <div key={p} className={`plan-subcard ${isMain ? 'is-main' : ''}`}>
                <PlanValue
                  plan={p}
                  q={q}
                  statusEmoji={subEmoji}
                  statusKey={subStatusKey}
                  statusTip={subTip}
                  statusText={refreshing ? '刷新中' : undefined}
                />
                {q?.extra ? (
                  <div className="plan-subcard-detail" title={q.extra}>
                    {q.extra}
                  </div>
                ) : null}
                {isMain ? (
                  <span className="plan-main-badge">当前展示</span>
                ) : (
                  <button
                    type="button"
                    className="plan-set-main"
                    onClick={() => onSetPrimary(entry.uid, p)}
                  >
                    展示
                  </button>
                )}
              </div>
            )
          })}
          {plans.length === 1 && (
            <p className="field-hint">该站点只支持「{PLANS.find((p) => p.id === primary)?.label}」一种计费方式</p>
          )}
        </div>

        {/* 置底操作行：删除 / 编辑 / 刷新 / 关闭（合并一行） */}
        <div className="dialog-actions dialog-actions-bottom">
          <button className="btn danger-solid" onClick={() => onDelete(entry)} aria-label="删除站点">
            <Trash2 size={14} strokeWidth={2.2} /> 删除
          </button>
          <button className="btn secondary" onClick={() => onEdit(entry)} aria-label="编辑站点">
            <Pencil size={14} strokeWidth={2.2} /> 编辑
          </button>
          <button className="btn secondary" onClick={() => onRefresh(entry)} disabled={refreshing} aria-label="刷新该站点">
            <RefreshCw size={14} strokeWidth={2.2} /> 刷新
          </button>
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
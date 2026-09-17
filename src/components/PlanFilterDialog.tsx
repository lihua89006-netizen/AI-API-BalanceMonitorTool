// 方案筛选弹窗：按量余额 / 包时 / 按次 / Token Plan 套餐
// 交互：勾选进入草稿状态，「确定」应用并关闭；「关闭」放弃更改直接退出；
// 头部「全选 / 清空」批量操作；每项显示当前各方案的站点计数

import { useState } from 'react'
import { PLANS } from '../lib/plans'

interface PlanFilterDialogProps {
  value: string[] // 已选方案 id（App 中已生效的筛选）
  counts: Record<string, number> // 各方案的站点数（缺失视为按量余额后的统计）
  onChange: (plans: string[]) => void
  onClose: () => void
}

export default function PlanFilterDialog({ value, counts, onChange, onClose }: PlanFilterDialogProps) {
  const [draft, setDraft] = useState<string[]>(value)

  const toggle = (id: string) => {
    if (draft.includes(id)) {
      setDraft(draft.filter((v) => v !== id))
    } else {
      setDraft([...draft, id])
    }
  }

  const allSelected = draft.length === PLANS.length
  const applyAndClose = () => {
    onChange(draft)
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog sync-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">方案筛选</h2>
        <div className="plan-toolbar">
          <button
            type="button"
            className="btn secondary"
            disabled={allSelected}
            onClick={() => setDraft(PLANS.map((p) => p.id))}
          >
            全选
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={draft.length === 0}
            onClick={() => setDraft([])}
          >
            清空
          </button>
        </div>
        <p className="field-hint">按计费方案筛选站点；未选中的方案在列表中隐藏</p>
        <div className="plan-list">
          {PLANS.map((p) => (
            <label key={p.id} className="plan-item">
              <input
                type="checkbox"
                checked={draft.includes(p.id)}
                onChange={() => toggle(p.id)}
              />
              <span>{p.label}</span>
              <span className="plan-count">{counts[p.id] ?? 0} 个站点</span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={applyAndClose}>
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
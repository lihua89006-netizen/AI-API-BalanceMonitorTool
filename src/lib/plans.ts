// 计费方案（方案筛选弹窗 / 站点编辑选勾 / 主界面过滤与卡片展示 共用）
// 约定：默认按量余额（paygo）。旧数据或 config 缺失计费字段的站点一律视为「按量余额」，
// 保证每个站点必属一类——开启筛选时不会出现站点「凭空消失」的情况。
//
// 多方案：一个站点可支持多种计费方式（config.billingPlans: string[]），
// 兼容旧单值字段 billingPlan: string；主显示方案存 config.primaryPlan，
// 缺失时按固定优先级（Token Plan > 包时 > 按次 > 按量）从支持列表中取。

export const PLANS = [
  { id: 'paygo', label: '按量余额' },
  { id: 'duration', label: '包时' },
  { id: 'times', label: '按次' },
  { id: 'plan', label: 'Token Plan 套餐' },
] as const

export type PlanId = (typeof PLANS)[number]['id']

export const DEFAULT_PLAN: PlanId = 'paygo'

/** 主显示方案优先级：数值越小越优先（Token Plan 套餐 > 包时 > 按次 > 按量） */
export const PLAN_PRIORITY: Record<PlanId, number> = {
  plan: 0,
  duration: 1,
  times: 2,
  paygo: 3,
}

function isPlanId(v: unknown): v is PlanId {
  return typeof v === 'string' && PLANS.some((p) => p.id === v)
}

/** 站点支持的所有计费方案（去重保序）。读 billingPlans 数组，兼容旧 billingPlan 单值；无则按量 */
export function entryPlans(config: Record<string, unknown> | undefined | null): PlanId[] {
  const v = config?.billingPlans
  if (Array.isArray(v)) {
    const list = v.filter(isPlanId)
    if (list.length > 0) return [...new Set(list)]
  }
  const single = config?.billingPlan
  if (isPlanId(single)) return [single]
  return [DEFAULT_PLAN]
}

/** 主显示方案：读 primaryPlan；非法或缺失时按优先级从支持列表取，兜底按量 */
export function entryPrimaryPlan(config: Record<string, unknown> | undefined | null): PlanId {
  const plans = entryPlans(config)
  const v = config?.primaryPlan
  if (isPlanId(v) && plans.includes(v)) return v
  return [...plans].sort((a, b) => PLAN_PRIORITY[a] - PLAN_PRIORITY[b])[0] ?? DEFAULT_PLAN
}
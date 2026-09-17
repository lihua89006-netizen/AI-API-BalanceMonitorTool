// 刷新调度：单站点查询（币种覆盖 + 错误转换），对齐原 Python 版 worker.fetch_entry

import { getProvider } from '../providers/registry'
import { ProviderError, failQuota, type NetClient, type NetRequest, type QuotaInfo } from '../providers/types'
import { entryPlans } from './plans'
import type { PlanId } from './plans'
import { tauriNetClient } from './net'
import type { ProviderEntry } from './store'

export async function fetchEntry(
  entry: ProviderEntry,
  client: NetClient = tauriNetClient,
): Promise<QuotaInfo> {
  const provider = getProvider(entry.providerId)
  if (!provider) {
    return failQuota(entry.providerId, entry.displayName, `未知的站点类型：${entry.providerId}`)
  }
  // 代理：站点配置里的 proxy 注入到每个请求（适配器无需感知）
  const proxy = String((entry.config || {}).proxy || '').trim() || undefined
  const effectiveClient: NetClient = proxy
    ? {
        request: (req: NetRequest) => client.request({ ...req, proxy }),
      }
    : client
  let info: QuotaInfo
  try {
    info = await provider.fetch(effectiveClient, entry.config || {})
  } catch (e) {
    if (e instanceof ProviderError) {
      return failQuota(entry.providerId, entry.displayName, e.message)
    }
    return failQuota(entry.providerId, entry.displayName, `网络错误：${e instanceof Error ? e.message : String(e)}`)
  }
  info.providerId = provider.id
  info.displayName = entry.displayName || provider.name
  // 币种：手动指定优先；否则保留接口返回的标准币种（USD/CNY），
  // 未识别到（或识别到异常值）才强制 CNY（HTML 页面识别的货币符号仅供参考）。
  // '%' 为配额百分比（如 OpenCode Go 订阅用量），透传不转 CNY
  const dc = String((entry.config || {}).display_currency || '').trim()
  const auto = String(info.currency || '').trim().toUpperCase()
  info.currency = dc || (auto === 'USD' || auto === 'CNY' || auto === '%' ? auto : 'CNY')
  info.message = info.message || 'ok'

  // —— 自动勾选计费方案 ——
  // 适配器返回 plans（多方案数据）时自动勾选，策略：
  // - 首次（config 无 billingPlans 或此前为自动写入）：billingPlans = 识别结果（含自愈：历史误判被移除）
  // - 用户手动勾选过（SiteDialog 保存时清除 _auto_billing_plans 标记）：尊重用户，不覆盖
  // 通过 detectedConfig 通道落库（前端 persistDetected 会写回 config）
  if (info.plans && Object.keys(info.plans).length > 0) {
    const detected = Object.keys(info.plans) as PlanId[]
    const wasAuto = (entry.config || {})._auto_billing_plans === true
    const hasPlans = Array.isArray((entry.config || {}).billingPlans)
    let merged: PlanId[]
    if (wasAuto || !hasPlans) {
      // 自动模式：以识别结果为准（自愈历史误判），保持识别顺序
      merged = [...detected]
    } else {
      // 用户手动模式：保留用户勾选，仅补充新识别到的方案
      const current = entryPlans(entry.config)
      merged = [...new Set([...current, ...detected])]
    }
    const userPrimary = String((entry.config || {}).primaryPlan || '') as PlanId
    // 主方案：保留用户手动选择（若仍有效）；否则取 merged[0]
    // （generic 已把主余额方案排最前；其余适配器单方案即唯一方案）
    let primary = userPrimary
    if (!merged.includes(primary)) {
      primary = merged[0]
    }
    const detectedConfig = {
      ...(info.detectedConfig ?? {}),
      billingPlans: merged,
      primaryPlan: primary,
      _auto_billing_plans: true, // 标记本次为自动写入（用户手动保存时会清除）
    }
    info.detectedConfig = detectedConfig
  }

  return info
}

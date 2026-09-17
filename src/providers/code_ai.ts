// Code AI 适配器（OpenCode / CommandCode 一个入口，下拉框选择服务商）
//
// 下拉「服务商」选择：
//   - OpenCode（opencode.ai）：
//       · Go 订阅用量（API Key → 官方未文档化接口 /zen/go/v1/usage，Bearer 鉴权，5小时/周/月用量百分比）
//       · Zen 预付费余额（auth cookie + workspace id → 抓 /workspace/<id> HTML 提取 $X.XX）
//   - CommandCode（commandcode.ai）：
//       · 官方 API Key（commandcode.ai/settings/api 创建）→ /alpha/whoami → /alpha/billing/credits + /alpha/billing/subscriptions
//         （官方 CLI 同款接口：月剩余额度 + 套餐 + 本期到期 + 已购/免费 + 5小时窗口）
//
// 均为纯 HTTP（走 Rust http_request 通道），无需浏览器自动化。
// 计费方式映射：OpenCode Zen / CommandCode 额度 → paygo（按量余额）；OpenCode Go → plan（套餐）

import type { NetClient, Provider, QuotaInfo } from './types'
import { ProviderError, num, parseJsonResponse } from './types'

const OC_DEFAULT_BASE = 'https://opencode.ai'
const CC_DEFAULT_BASE = 'https://api.commandcode.ai'

// —— OpenCode：Go 用量（官方未文档化接口）——
async function ocFetchGoUsage(client: NetClient, base: string, apiKey: string): Promise<QuotaInfo> {
  const url = `${base}/zen/go/v1/usage`
  const resp = await client.request({
    method: 'GET',
    url,
    headers: { Authorization: `Bearer ${apiKey}` },
    timeoutMs: 30000,
  })
  const data = parseJsonResponse(resp, url)
  const usage = (data.usage ?? data) as Record<string, unknown>
  const roll = (usage.rolling ?? {}) as Record<string, unknown>
  const week = (usage.weekly ?? {}) as Record<string, unknown>
  const month = (usage.monthly ?? {}) as Record<string, unknown>
  if (roll.status && roll.status !== 'ok') {
    return {
      ok: false,
      providerId: 'code_ai',
      displayName: '',
      message: String(roll.status),
      total: null,
      remaining: null,
      currency: '%',
    }
  }
  const pct = num(roll.percent)
  if (pct === null) throw new ProviderError('响应中没有用量百分比（usage.rolling.percent）')
  // 三个时间窗口逐行展示（5h → 周 → 月），每行：剩X% · 已用X% · 重置MM-DD
  //（卡片详情区已支持 pre-line 多行；无 \n 的适配器不受影响）
  const windows: Array<[string, Record<string, unknown>]> = [
    ['5h', roll],
    ['周', week],
    ['月', month],
  ]
  const extra = windows
    .map(([label, w]) => {
      const p = num(w.percent)
      if (p === null) return ''
      const remain = 100 - p
      const reset = String(w.resetsAt || '').slice(5, 10) // ISO → MM-DD
      return `${label} 剩${remain}% · 已用${p}%${reset && reset !== 'T' ? ` · 重置${reset}` : ''}`
    })
    .filter(Boolean)
    .join('\n')
  return {
    ok: true,
    providerId: 'code_ai',
    displayName: '',
    message: 'ok',
    total: 100,
    remaining: 100 - pct,
    currency: '%',
    extra,
  }
}

// —— OpenCode：Zen 余额（auth cookie 抓 dashboard）——
const OC_ZEN_RE = /(?:Current balance|Balance|balance)[^$]{0,120}\$(\d+(?:\.\d{1,2})?)/i
const OC_ANY_PRICE_RE = /\$(\d+(?:\.\d{1,2})?)\b/

async function ocFetchZenBalance(client: NetClient, base: string, cookie: string, workspaceId: string): Promise<QuotaInfo> {
  const url = `${base}/workspace/${workspaceId}`
  const resp = await client.request({
    method: 'GET',
    url,
    headers: { Cookie: `auth=${cookie}` },
    timeoutMs: 30000,
  })
  if (resp.status >= 400) {
    throw new ProviderError(`HTTP ${resp.status}：${resp.body.slice(0, 160)}`)
  }
  const m = resp.body.match(OC_ZEN_RE) ?? resp.body.match(OC_ANY_PRICE_RE)
  if (!m) {
    throw new ProviderError('未能从页面提取到余额（auth cookie 可能过期或 workspace id 无效）')
  }
  const v = num(m[1])
  if (v === null) throw new ProviderError('提取到的余额不是数字')
  return {
    ok: true,
    providerId: 'code_ai',
    displayName: '',
    message: 'ok',
    total: v,
    remaining: v,
    currency: 'USD',
    extra: 'Zen 预付费余额',
  }
}

async function fetchOpenCode(
  client: NetClient,
  config: Record<string, unknown>,
  apiKey: string,
): Promise<QuotaInfo> {
  const workspaceId = String((config.workspace_id as string) || '').trim()
  const cookie = String((config.auth_cookie as string) || '').trim()
  const base = String((config.api_base as string) || '').trim() || OC_DEFAULT_BASE
  const go = Boolean(apiKey)
  const zen = Boolean(workspaceId && cookie)
  if (workspaceId && !cookie) {
    throw new ProviderError('填了 Workspace ID 还需要填 auth Cookie（Zen 余额）')
  }
  if (!go && !zen) {
    throw new ProviderError('请填写 API Key（Go 用量），或 auth cookie + workspace id（Zen 余额）')
  }
  const plans: Record<string, QuotaInfo> = {}
  let main: QuotaInfo | null = null
  // Zen（paygo）优先作主显示：余额语义更贴近「余额」，且 plans key 顺序决定自动勾选主方案
  if (zen) {
    const z = await ocFetchZenBalance(client, base, cookie, workspaceId)
    plans.paygo = z
    main = z
  }
  if (go) {
    let g: QuotaInfo
    try {
      g = await ocFetchGoUsage(client, base, apiKey)
    } catch (e) {
      if (e instanceof ProviderError && /^HTTP 403/.test(e.message)) {
        g = {
          ok: false,
          providerId: 'code_ai',
          displayName: '',
          message: '无 Go 订阅',
          total: null,
          remaining: null,
          currency: '%',
        }
      } else {
        throw e
      }
    }
    plans.plan = g
    if (!main) main = g
  }
  return {
    ok: main?.ok ?? false,
    providerId: 'code_ai',
    displayName: '',
    message: main?.message ?? '',
    total: main?.total ?? null,
    remaining: main?.remaining ?? null,
    currency: main?.currency ?? 'CNY',
    extra: main?.extra ?? '',
    plans,
  }
}

// —— CommandCode：官方 CLI 同款计费接口 ——

const CC_PLAN_LABELS: Record<string, string> = {
  'individual-go': 'Go',
  'individual-goat': 'Goat',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro v1',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
}
const CC_PLAN_USD: Record<string, number> = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
}

/** 宽松取值：对象或数组里按路径取第一个非空字符串 */
function pickString(obj: unknown, keys: string[]): string {
  if (typeof obj !== 'object' || obj === null) return ''
  const d = obj as Record<string, unknown>
  for (const k of keys) {
    const v = d[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'object' && v !== null) {
      const inner = pickString(v, keys)
      if (inner) return inner
    }
  }
  return ''
}

/** ISO / epoch → 展示日期（YYYY-MM-DD） */
function fmtDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  const d = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(String(v))
  if (isNaN(d.getTime())) return ''
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function fetchCommandCode(
  client: NetClient,
  config: Record<string, unknown>,
  apiKey: string,
): Promise<QuotaInfo> {
  const base = String((config.api_base as string) || '').trim() || CC_DEFAULT_BASE
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'x-command-code-version': '0.52.1', // 官方 CLI 同款指纹（社区实现均带）
    'x-cli-environment': 'production',
  }
  // 1) whoami → org.id
  const whoUrl = `${base}/alpha/whoami`
  const who = await client.request({ method: 'GET', url: whoUrl, headers, timeoutMs: 20000 })
  const whoData = parseJsonResponse(who, whoUrl)
  const orgId = pickString(whoData, ['id', 'orgId']) || pickString(whoData, ['org', 'organization', 'data', 'result'])
  const qs = orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''

  // 2) credits（余额核心）
  const creditsUrl = `${base}/alpha/billing/credits${qs}`
  const cd = await client.request({ method: 'GET', url: creditsUrl, headers, timeoutMs: 20000 })
  const cdData = parseJsonResponse(cd, creditsUrl)
  const credits = (cdData.credits ?? cdData.data ?? cdData.result ?? cdData) as Record<string, unknown>
  const monthly = num(credits.monthlyCredits)
  const purchased = num(credits.purchasedCredits)
  const free = num(credits.freeCredits)
  const premium = num(credits.premiumMonthlyCredits)
  // 主余额 = 本月剩余额度；为 0/缺省时回退已购/免费额度（免费用户无月额度也能显示）
  const remaining = monthly || purchased || free || 0

  // 3) subscriptions（套餐；免费用户 data 为 null → 忽略）
  let planId = ''
  let periodEnd = ''
  try {
    const subUrl = `${base}/alpha/billing/subscriptions`
    const sr = await client.request({ method: 'GET', url: subUrl, headers, timeoutMs: 20000 })
    const sd = parseJsonResponse(sr, subUrl)
    const sub = (sd.data ?? sd.subscription ?? sd) as Record<string, unknown>
    planId = String(sub.planId || sub.plan_id || '')
    periodEnd = fmtDate(sub.currentPeriodEnd ?? sub.current_period_end ?? '')
  } catch {
    /* 免费用户 / 接口差异：套餐信息缺失时忽略 */
  }

  const extra: string[] = []
  if (planId) {
    const label = CC_PLAN_LABELS[planId] ?? planId
    const usd = CC_PLAN_USD[planId]
    extra.push(`套餐 ${label}${usd ? `·$${usd}/月` : ''}`)
  }
  if (periodEnd) extra.push(`本期至 ${periodEnd}`)
  if (purchased !== null && purchased > 0) extra.push(`已购 $${purchased}`)
  if (free !== null && free > 0) extra.push(`免费 $${free}`)
  if (premium !== null && premium > 0) extra.push(`高级月 $${premium}`)

  return {
    ok: true,
    providerId: 'code_ai',
    displayName: '',
    message: 'ok',
    total: remaining,
    remaining,
    currency: 'USD',
    extra: extra.join('；'),
    plans: { paygo: { ok: true, providerId: 'code_ai', displayName: '', message: '', total: remaining, remaining, currency: 'USD', extra: extra.join('；') } },
  }
}

// —— 适配器 ——

export const codeAiProvider: Provider = {
  id: 'code_ai',
  name: 'Code AI（OpenCode / CommandCode）',
  description:
    'OpenCode 与 CommandCode 共用入口，下拉选择服务商。OpenCode：Go 订阅用量（API Key）+ Zen 余额（auth cookie）；CommandCode：API Key 查月剩余额度 + 套餐。均为纯 HTTP 查询。',
  websiteUrl: 'https://opencode.ai',
  getWebsiteUrl(config) {
    const service = String((config.service as string) || 'opencode').trim().toLowerCase()
    if (service === 'commandcode') return 'https://commandcode.ai'
    const id = String((config.workspace_id as string) || '').trim()
    return id ? `https://opencode.ai/workspace/${id}` : 'https://opencode.ai'
  },
  configSchema: [
    {
      key: 'service',
      label: '服务商',
      type: 'select',
      required: true,
      options: [
        { value: 'opencode', label: 'OpenCode' },
        { value: 'commandcode', label: 'CommandCode' },
      ],
    },
    {
      key: 'api_key',
      label: 'API Key',
      type: 'password',
      required: false,
      placeholder: 'OpenCode：控制台 API Keys；CommandCode：commandcode.ai/settings/api',
    },
    {
      key: 'workspace_id',
      label: 'Workspace ID（OpenCode Zen 余额）',
      type: 'text',
      required: false,
      advanced: true,
      placeholder: '如 wrk_xxxxxxxx（登录后从 dashboard URL 获取）',
    },
    {
      key: 'auth_cookie',
      label: 'auth Cookie（OpenCode Zen 余额）',
      type: 'password',
      required: false,
      advanced: true,
      placeholder: '浏览器登录后 DevTools → Application → Cookies 复制 auth 值（有效期 1 年）',
    },
    {
      key: 'api_base',
      label: '接口地址',
      type: 'text',
      required: false,
      advanced: true,
      placeholder: '默认 opencode.ai / api.commandcode.ai',
    },
  ],
  async fetch(client: NetClient, config: Record<string, unknown>): Promise<QuotaInfo> {
    const service = String((config.service as string) || 'opencode').trim().toLowerCase()
    const apiKey = String((config.api_key as string) || '').trim()
    if (service === 'commandcode') {
      if (!apiKey) throw new ProviderError('请填写 CommandCode API Key（commandcode.ai/settings/api 创建）')
      return fetchCommandCode(client, config, apiKey)
    }
    return fetchOpenCode(client, config, apiKey)
  },
}

// 适配器层公共类型与工具

export interface ConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'number' | 'select'
  required?: boolean
  placeholder?: string
  default?: string | number
  /** 下拉选项（type: 'select' 时必填） */
  options?: { value: string; label: string }[]
  /** 进阶字段：收纳进对话框「高级设置」折叠区（默认收起） */
  advanced?: boolean
  /** 仅桌面端使用：安卓端不渲染该字段（如「模拟浏览器登录」的账号密码——安卓为手动登录） */
  desktopOnly?: boolean
}

// —— 网络抽象（生产走 Tauri invoke，测试用本地假服务器实现）——
export interface NetRequest {
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  /** 原始请求体（JSON 文本或 form 编码文本） */
  body?: string
  contentType?: string
  timeoutMs?: number
  proxy?: string
}

export interface NetResponse {
  status: number
  /** UTF-8 有损文本 */
  body: string
}

export interface NetClient {
  request(req: NetRequest): Promise<NetResponse>
}

export interface QuotaInfo {
  ok: boolean
  providerId: string
  displayName: string
  message: string
  total?: number | null
  remaining?: number | null
  currency: string
  extra?: string
  /** 自动识别的候选列表（供用户在界面校准） */
  candidates?: BalanceCandidate[]
  /** 适配器探测到的可缓存配置（如自动识别站点的登录接口/余额来源），由前端合并保存 */
  detectedConfig?: Record<string, unknown>
  /** 多方案站点的分方案数据（可选）：key 为 PlanId，value 为该方案自己的 QuotaInfo。
      缺省时卡片只展示主方案数据，次级方案显示「暂无数据」占位 */
  plans?: Record<string, QuotaInfo>
}

/** 自动识别出的余额候选 */
export interface BalanceCandidate {
  value: number
  currency: string
  /** 候选附近的页面文本，帮助用户判断（如「账户余额 ¥12.34」） */
  context: string
}

export interface Provider {
  id: string
  name: string
  description: string
  websiteUrl: string
  configSchema: ConfigField[]
  /** 点击类型名跳转的网站地址（可按配置动态生成） */
  getWebsiteUrl?(config: Record<string, unknown>): string
  fetch(client: NetClient, config: Record<string, unknown>): Promise<QuotaInfo>
}

// —— 错误与工具 ——

/** 业务错误（登录失败、Key 无效等），worker 转成 QuotaInfo(ok=false) 且不重试 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function failQuota(
  providerId: string,
  displayName: string,
  message: string,
): QuotaInfo {
  return { ok: false, providerId, displayName, message, currency: 'CNY' }
}

/** 宽松地把任意值转成 number，转不了返回 null */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 递归查找对象里的 message 字符串（处理 OpenAI 风格 {error:{message}} 嵌套） */
function deepFindMessage(obj: unknown, depth = 0): unknown {
  if (depth > 4 || typeof obj !== 'object' || obj === null) return undefined
  const d = obj as Record<string, unknown>
  if (typeof d.message === 'string') return d.message
  for (const v of Object.values(d)) {
    const r = deepFindMessage(v, depth + 1)
    if (r !== undefined) return r
  }
  return undefined
}

/** 校验 HTTP 状态并解析 JSON；错误响应抛出 ProviderError */
export function parseJsonResponse(resp: NetResponse, _url: string): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(resp.body)
  } catch {
    throw new ProviderError(
      `响应不是 JSON（HTTP ${resp.status}）：${resp.body.slice(0, 200)}`,
    )
  }
  if (resp.status >= 400) {
    const found = deepFindMessage(data)
    const detail = found !== undefined ? String(found) : resp.body.slice(0, 200)
    throw new ProviderError(`HTTP ${resp.status}：${detail}`)
  }
  if (typeof data !== 'object' || data === null) {
    throw new ProviderError(`响应结构异常：${typeof data}`)
  }
  return data as Record<string, unknown>
}

// DeepSeek 官方 API 适配器
// GET {api_base}/user/balance（Bearer API Key）；api_base 默认官方地址，可配置（测试/兼容中转用）

import { num, parseJsonResponse, ProviderError, type Provider, type QuotaInfo } from './types'

const DEFAULT_BASE = 'https://api.deepseek.com'

export const deepseekProvider: Provider = {
  id: 'deepseek_official',
  name: 'DeepSeek 官方',
  description: 'DeepSeek 官方 API 余额。接口固定为 https://api.deepseek.com/user/balance，只需填 API Key。',
  websiteUrl: 'https://platform.deepseek.com/usage',
  configSchema: [
    { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: '' },
    { key: 'api_base', label: '接口地址（可选）', type: 'text', required: false, placeholder: '留空用官方 https://api.deepseek.com' },
  ],

  async fetch(client, config) {
    const apiKey = String(config.api_key || '')
    if (!apiKey) {
      throw new ProviderError('缺少 API Key，请先在设置中填写。')
    }
    const apiBase = String(config.api_base || DEFAULT_BASE).replace(/\/+$/, '')
    const url = `${apiBase}/user/balance`
    const resp = await client.request({
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 30_000,
    })
    const data = parseJsonResponse(resp, url)

    if (data.is_available === false) {
      throw new ProviderError('账户当前不可用（is_available=false），请到 DeepSeek 平台确认状态。')
    }
    const infos = Array.isArray(data.balance_infos) ? (data.balance_infos as Record<string, unknown>[]) : []
    if (infos.length === 0) {
      throw new ProviderError('响应中没有 balance_infos 数据。')
    }
    const first = infos[0]
    const total = num(first.total_balance)
    const granted = num(first.granted_balance)
    const topped = num(first.topped_up_balance)

    // 多个币种时拼接附加信息
    let extra = ''
    if (infos.length > 1) {
      extra = infos
        .map((it) => `${it.currency}:${it.total_balance}`)
        .join('；')
    }

    const fmt = (v: number | null) => (v === null ? '-' : v.toFixed(2))
    const message = `充值 ${fmt(topped)} + 赠送 ${fmt(granted)}${extra ? `（${extra}）` : ''}`

    const info: QuotaInfo = {
      ok: true,
      providerId: this.id,
      displayName: '',
      message,
      total,
      remaining: total,
      currency: String(first.currency || 'CNY'),
      extra: '',
    }
    return info
  },
}

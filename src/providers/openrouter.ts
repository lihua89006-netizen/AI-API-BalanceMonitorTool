// OpenRouter 适配器
// GET {api_base}/api/v1/auth/key（Bearer API Key）；api_base 默认官方地址，可配置（测试用）
// 响应 data: { credits(剩余), usage(已用), limit(总额) }

import { num, parseJsonResponse, ProviderError, type Provider, type QuotaInfo } from './types'

const DEFAULT_BASE = 'https://openrouter.ai'

export const openrouterProvider: Provider = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'OpenRouter 官方 API 余额（credits，单位美元）。',
  websiteUrl: 'https://openrouter.ai/settings/keys',
  configSchema: [
    { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-or-...（openrouter.ai/settings/keys 获取）' },
    { key: 'api_base', label: '接口地址（可选）', type: 'text', required: false, placeholder: '留空用官方 https://openrouter.ai' },
  ],

  async fetch(client, config) {
    const apiKey = String(config.api_key || '')
    if (!apiKey) {
      throw new ProviderError('缺少 API Key，请先在设置中填写。')
    }
    const url = `${String(config.api_base || DEFAULT_BASE).replace(/\/+$/, '')}/api/v1/auth/key`
    const resp = await client.request({
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 30_000,
    })
    const data = parseJsonResponse(resp, url)
    const d = data.data as Record<string, unknown> | undefined
    if (typeof d !== 'object' || d === null) {
      throw new ProviderError('响应中没有 data 对象。')
    }

    const credits = num(d.credits) // 剩余
    const limit = num(d.limit) // 总额

    const info: QuotaInfo = {
      ok: true,
      providerId: this.id,
      displayName: '',
      message: 'ok',
      total: limit,
      remaining: credits,
      currency: 'USD',
      extra: '',
    }
    return info
  },
}

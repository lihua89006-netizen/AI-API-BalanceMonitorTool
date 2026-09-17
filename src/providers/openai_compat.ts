// OpenAI 官方 / 兼容中转站适配器
// GET {base_url}/v1/dashboard/billing/credit_grants（Bearer API Key）

import { num, parseJsonResponse, ProviderError, type Provider, type QuotaInfo } from './types'

export const openaiCompatProvider: Provider = {
  id: 'openai_compat',
  name: 'OpenAI 兼容计费接口',
  description: '适用于 OpenAI 官方及沿用 /v1/dashboard/billing/credit_grants 计费结构的中转站。',
  websiteUrl: '',
  getWebsiteUrl(config) {
    return String((config.base_url as string) || '').replace(/\/+$/, '') || ''
  },
  configSchema: [
    { key: 'base_url', label: '接口地址', type: 'text', required: true, placeholder: 'https://api.openai.com' },
    { key: 'api_key', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' },
  ],

  async fetch(client, config) {
    const base = String(config.base_url || '').replace(/\/+$/, '')
    const apiKey = String(config.api_key || '')
    if (!base || !apiKey) {
      throw new ProviderError('缺少接口地址或 API Key，请先在设置中填写。')
    }
    const url = `${base}/v1/dashboard/billing/credit_grants`
    const resp = await client.request({
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 30_000,
    })
    const data = parseJsonResponse(resp, url)

    const total = num(data.total_granted)
    const remaining = num(data.total_available)

    const info: QuotaInfo = {
      ok: true,
      providerId: this.id,
      displayName: '',
      message: 'ok',
      total,
      remaining,
      currency: 'CNY',
      extra: '',
    }
    return info
  },
}

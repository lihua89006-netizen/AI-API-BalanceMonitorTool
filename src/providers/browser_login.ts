// 「模拟浏览器登录」兜底适配器
// 定位：其它方式（自动识别/探测接口）识别不了时用这个 —— 自动用 Edge 无头浏览器
// 打开登录页,账号密码登录后跳转余额页,抓取余额接口；适合带滑块/验证码/SPA 的网页站点。
// 实际查询由 Rust 命令 browser_login_query 按需 spawn 一次性 Node+Playwright 进程完成。

import { invoke } from '@tauri-apps/api/core'
import type { NetClient, Provider, QuotaInfo } from './types'
import { ProviderError } from './types'

interface BrowserBalance {
  available?: number | null
  cash?: number | null
  voucher?: number | null
  credit?: number | null
  owed?: number | null
}

interface BrowserLoginResult {
  success: boolean
  message?: string
  extra?: string
  balance?: BrowserBalance | null
}

export const browserLoginProvider: Provider = {
  id: 'browser_login',
  name: '模拟浏览器登录',
  description:
    '兜底方案（其它方式识别不了时用）：Windows 端自动用 Edge 无头浏览器登录抓余额（需填写登录页/余额页/账号/密码）；安卓端打开应用内嵌浏览器手动登录（只填登录页/余额页地址，登录后自动抓取，登录态持久化）。适合带滑块/验证码/SPA、无公开接口的网页站点。',
  websiteUrl: '',
  getWebsiteUrl(config) {
    const url = String((config.balance_url as string) || (config.login_url as string) || '').trim()
    if (/^https?:\/\//i.test(url)) {
      try {
        return new URL(url).origin
      } catch {
        return ''
      }
    }
    return ''
  },
  configSchema: [
    { key: 'login_url', label: '登录页地址', type: 'text', required: true, placeholder: '如 https://platform.minimaxi.com/login' },
    { key: 'balance_url', label: '余额页地址', type: 'text', required: true, placeholder: '如 https://platform.minimaxi.com/console/recharge-records' },
    {
      key: 'username',
      label: '账号（邮箱/手机号）',
      type: 'text',
      required: true,
      placeholder: '登录账号',
      desktopOnly: true, // 安卓端为手动登录（WebView 内输入），无需配置账号密码
    },
    {
      key: 'password',
      label: '密码',
      type: 'password',
      required: true,
      placeholder: '登录密码',
      desktopOnly: true,
    },
    {
      key: 'balance_keyword',
      label: '余额接口关键字',
      type: 'text',
      required: false,
      placeholder: '留空自动识别（如 query_balance）',
      advanced: true,
    },
  ],
  async fetch(_client: NetClient, config: Record<string, unknown>): Promise<QuotaInfo> {
    const loginUrl = String((config.login_url as string) || '').trim()
    const balanceUrl = String((config.balance_url as string) || '').trim()
    if (!loginUrl || !balanceUrl) {
      throw new ProviderError('请填写登录页地址和余额页地址')
    }
    const username = String((config.username as string) || '').trim()
    const password = String((config.password as string) || '')
    const balanceKeyword = String((config.balance_keyword as string) || '').trim()

    let result: BrowserLoginResult
    try {
      result = await invoke<BrowserLoginResult>('browser_login_query', {
        params: { loginUrl, balanceUrl, balanceKeyword, username, password },
      })
    } catch (e) {
      throw new ProviderError(`浏览器查询失败：${e instanceof Error ? e.message : String(e)}`)
    }
    if (!result.success) {
      throw new ProviderError(result.message || '浏览器登录查询失败')
    }
    const b = result.balance
    if (!b || (b.available == null && b.cash == null)) {
      throw new ProviderError('未获取到余额数据')
    }
    const remaining = b.available ?? b.cash
    return {
      ok: true,
      providerId: 'browser_login',
      displayName: '',
      message: 'ok',
      total: remaining,
      remaining,
      currency: 'CNY',
      extra: result.extra || '',
    }
  },
}

// —— 测试环境不使用该适配器（依赖 Tauri invoke），故无测试用例 ——
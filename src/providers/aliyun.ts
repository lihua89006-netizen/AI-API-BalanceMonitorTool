// 阿里云 OpenAPI（BssOpenApi）适配器：QueryAccountBalance 查询账户可用余额
// 文档：https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance
// 认证：AccessKey（RAM 子账号）+ RPC V1 签名（HMAC-SHA1），端点 business.aliyuncs.com
// 权限：需给 RAM 用户授权 AliyunBSSReadOnlyAccess（或等效 bss 只读策略）；未授权返回 NotAuthorized

import { num, ProviderError, type Provider } from './types'

const DEFAULT_ENDPOINT = 'https://business.aliyuncs.com'

/** RFC3986 percent 编码（阿里云 RPC 签名：仅 A-Za-z0-9 - _ . ~ 不编码） */
function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

// —— 纯 JS SHA-1（不依赖 Web Crypto，兼容 Tauri WebView 各平台）——
function sha1Bytes(msg: Uint8Array): Uint8Array {
  const ml = msg.length * 8
  const paddedLen = Math.ceil((msg.length + 9) / 64) * 64
  const buf = new Uint8Array(paddedLen)
  buf.set(msg)
  buf[msg.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(paddedLen - 8, Math.floor(ml / 0x100000000))
  dv.setUint32(paddedLen - 4, ml >>> 0)

  const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 80; i++)
      w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const t = (rol(a, 5) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = rol(b, 30)
      b = a
      a = t
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  const out = new Uint8Array(20)
  const dvOut = new DataView(out.buffer)
  dvOut.setUint32(0, h0)
  dvOut.setUint32(4, h1)
  dvOut.setUint32(8, h2)
  dvOut.setUint32(12, h3)
  dvOut.setUint32(16, h4)
  return out
}

/** HMAC-SHA1（block 64B，key 超长先 SHA-1 压缩） */
function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const BLOCK = 64
  let k = key
  if (k.length > BLOCK) k = sha1Bytes(k)
  const ipad = new Uint8Array(BLOCK)
  const opad = new Uint8Array(BLOCK)
  for (let i = 0; i < BLOCK; i++) {
    const byte = k[i] ?? 0
    ipad[i] = byte ^ 0x36
    opad[i] = byte ^ 0x5c
  }
  const inner = new Uint8Array(BLOCK + msg.length)
  inner.set(ipad)
  inner.set(msg, BLOCK)
  const outer = new Uint8Array(BLOCK + 20)
  outer.set(opad)
  outer.set(sha1Bytes(inner), BLOCK)
  return sha1Bytes(outer)
}

/** Uint8Array → Base64（无 btoa 依赖） */
function base64Encode(bytes: Uint8Array): string {
  const B = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B[b0 >> 2]
    out += B[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? '=' : B[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? '=' : B[b2 & 63]
  }
  return out
}

const enc = new TextEncoder()

/** RPC V1 签名：HMAC-SHA1("GET&%2F&" + percentEncode(canonical), Secret + "&") */
function rpcSign(params: Record<string, string>, secret: string): string {
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&')
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonical)}`
  const sig = hmacSha1(enc.encode(secret + '&'), enc.encode(stringToSign))
  return base64Encode(sig)
}

export const aliyunProvider: Provider = {
  id: 'aliyun',
  name: '阿里云',
  description:
    '阿里云账户（console.aliyun.com）。用 RAM 子账号 AccessKey 查询账户可用余额（含现金余额与信用额度），需在 RAM 控制台为子账号授权 AliyunBSSReadOnlyAccess。',
  websiteUrl: 'https://billing-cost.console.aliyun.com/fortune/billing-account',
  configSchema: [
    { key: 'access_key_id', label: 'AccessKey ID', type: 'text', required: true, placeholder: 'LTAI...（RAM 控制台创建，仅需 BSS 只读权限）' },
    { key: 'access_key_secret', label: 'AccessKey Secret', type: 'password', required: true, placeholder: '创建时仅显示一次，请妥善保存' },
    { key: 'api_base', label: '接口地址（可选）', type: 'text', required: false, advanced: true, placeholder: `留空用官方 ${DEFAULT_ENDPOINT}` },
  ],

  async fetch(client, config) {
    const akId = String(config.access_key_id || '').trim()
    const akSecret = String(config.access_key_secret || '').trim()
    if (!akId || !akSecret) {
      throw new ProviderError('缺少 AccessKey ID / Secret，请在设置中填写（RAM 子账号 + BSS 只读权限）。')
    }
    const endpoint = String(config.api_base || DEFAULT_ENDPOINT).replace(/\/+$/, '')

    const params: Record<string, string> = {
      AccessKeyId: akId,
      Action: 'QueryAccountBalance',
      Format: 'JSON',
      SignatureMethod: 'HMAC-SHA1',
      SignatureNonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      SignatureVersion: '1.0',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      Version: '2017-12-14',
    }
    const signature = rpcSign(params, akSecret)
    const all: Record<string, string> = { ...params, Signature: signature }
    const qs = Object.keys(all)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
      .join('&')
    const resp = await client.request({
      method: 'GET',
      url: `${endpoint}/?${qs}`,
      timeoutMs: 30_000,
    })

    let data: Record<string, unknown>
    try {
      data = JSON.parse(resp.body)
    } catch {
      throw new ProviderError(`响应不是 JSON（HTTP ${resp.status}）：${resp.body.slice(0, 200)}`)
    }
    const code = String(data.Code ?? '')
    if (code && code !== '200') {
      const msg = String(data.Message || '')
      const hint = code === 'NotAuthorized' || code === 'Forbidden'
        ? '（该 AK 无权访问账单接口：请到 RAM 控制台给此子账号授权 AliyunBSSReadOnlyAccess）'
        : code === 'InvalidAccessKeyId.NotFound'
          ? '（AccessKey ID 不存在，请检查）'
          : ''
      throw new ProviderError(msg ? `${code}：${msg}${hint}` : `接口错误（Code=${code}）${hint}`)
    }
    const d = (data.Data ?? {}) as Record<string, unknown>
    const remaining = num(d.AvailableAmount)
    if (remaining === null) {
      throw new ProviderError('响应中没有可用余额（Data.AvailableAmount）。')
    }
    const currency = String(d.Currency || 'CNY').toUpperCase()
    // 附加信息：现金余额 / 信用额度 / 代金券等
    const cash = num(d.AvailableCashAmount)
    const credit = num(d.CreditAmount)
    const coupon = num(d.CouponAmount)
    const parts: string[] = []
    if (cash !== null) parts.push(`现金余额 ${cash.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)
    if (credit !== null) parts.push(`信用额度 ${credit.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)
    if (coupon !== null) parts.push(`代金券 ${coupon.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`)

    return {
      ok: true,
      providerId: this.id,
      displayName: '',
      message: 'ok',
      total: remaining,
      remaining,
      currency,
      extra: parts.join('；'),
    }
  },
}
// 火山引擎 OpenAPI 适配器：QueryBalanceAcct 查询账户可用余额
// 端点：billing.volcengineapi.com（Action=QueryBalanceAcct, Version=2022-01-01）
// 认证：AccessKey + 火山签名（HMAC-SHA256，仅签名 host;x-date 两个头）
// 权限：AK 需具备 billing:QueryBalanceAcct 权限（主账号密钥默认可查；子账号需授权）

import { num, ProviderError, type Provider } from './types'

const DEFAULT_ENDPOINT = 'https://billing.volcengineapi.com'
const SERVICE = 'billing'

// —— 纯 JS SHA-256（不依赖 Web Crypto，兼容 Tauri WebView 各平台）——

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function sha256Bytes(msg: Uint8Array): Uint8Array {
  const ml = msg.length * 8
  const paddedLen = Math.ceil((msg.length + 9) / 64) * 64
  const buf = new Uint8Array(paddedLen)
  buf.set(msg)
  buf[msg.length] = 0x80
  const dv = new DataView(buf.buffer)
  dv.setUint32(paddedLen - 4, ml >>> 0)
  dv.setUint32(paddedLen - 8, Math.floor(ml / 0x100000000))

  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19
  const w = new Uint32Array(64)
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K256[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }
  const out = new Uint8Array(32)
  const dvOut = new DataView(out.buffer)
  dvOut.setUint32(0, h0)
  dvOut.setUint32(4, h1)
  dvOut.setUint32(8, h2)
  dvOut.setUint32(12, h3)
  dvOut.setUint32(16, h4)
  dvOut.setUint32(20, h5)
  dvOut.setUint32(24, h6)
  dvOut.setUint32(28, h7)
  return out
}

/** HMAC-SHA256（block 64B，key 超长先 SHA-256 压缩） */
function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const BLOCK = 64
  let k = key
  if (k.length > BLOCK) k = sha256Bytes(k)
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
  const outer = new Uint8Array(BLOCK + 32)
  outer.set(opad)
  outer.set(sha256Bytes(inner), BLOCK)
  return sha256Bytes(outer)
}

/** Uint8Array → 小写 hex */
function hexEncode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

const enc = new TextEncoder()
const sha256Hex = (s: string) => hexEncode(sha256Bytes(enc.encode(s)))

export const volcengineProvider: Provider = {
  id: 'volcengine',
  name: '火山引擎',
  description:
    '字节跳动火山引擎控制台（console.volcengine.com/）。用 AccessKey（API 访问密钥）查询账户可用余额：' +
    '密钥在控制台「右上角头像 → API 访问密钥」创建（或 IAM 子账号密钥），并授予 BillingCenterReadOnlyAccess（只读余额）权限。',
  websiteUrl: 'https://console.volcengine.com/finance/account-overview/',
  configSchema: [
    { key: 'access_key_id', label: 'Access Key ID', type: 'text', required: true, placeholder: 'AKLT...（控制台 → API 访问密钥）' },
    { key: 'access_key_secret', label: 'Secret Access Key', type: 'password', required: true, placeholder: 'IAM 密钥创建时生成' },
    { key: 'api_base', label: '接口地址（可选）', type: 'text', required: false, advanced: true, placeholder: `留空用官方 ${DEFAULT_ENDPOINT}` },
  ],

  async fetch(client, config) {
    const akId = String(config.access_key_id || '').trim()
    const akSecret = String(config.access_key_secret || '').trim()
    if (!akId || !akSecret) {
      throw new ProviderError('缺少 AccessKey ID / Secret，请在设置中填写。')
    }
    const endpoint = String(config.api_base || DEFAULT_ENDPOINT).replace(/\/+$/, '')
    const host = endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '')

    const params: Record<string, string> = { Action: 'QueryBalanceAcct', Version: '2022-01-01' }
    const now = new Date()
    const xdate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
    const date = xdate.slice(0, 8)
    const region = 'cn-beijing'
    const qs = Object.keys(params)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
      .join('&')
    const payloadHash = sha256Hex('')
    const canonicalRequest = ['GET', '/', qs, `host:${host}\nx-date:${xdate}\n`, 'host;x-date', payloadHash].join('\n')
    const credentialScope = `${date}/${region}/${SERVICE}/request`
    const stringToSign = ['HMAC-SHA256', xdate, credentialScope, sha256Hex(canonicalRequest)].join('\n')
    const hmac = (key: Uint8Array, data: string) => hmacSha256(key, enc.encode(data))
    const kDate = hmac(enc.encode(akSecret), date)
    const kRegion = hmac(kDate, region)
    const kService = hmac(kRegion, SERVICE)
    const kSigning = hmac(kService, 'request')
    const signature = hexEncode(hmac(kSigning, stringToSign))
    const auth = `HMAC-SHA256 Credential=${akId}/${credentialScope}, SignedHeaders=host;x-date, Signature=${signature}`

    const resp = await client.request({
      method: 'GET',
      url: `${endpoint}/?${qs}`,
      headers: { 'X-Date': xdate, Authorization: auth },
      timeoutMs: 30_000,
    })

    let data: Record<string, unknown>
    try {
      data = JSON.parse(resp.body)
    } catch {
      throw new ProviderError(`响应不是 JSON（HTTP ${resp.status}）：${resp.body.slice(0, 200)}`)
    }
    const meta = (data.ResponseMetadata ?? {}) as Record<string, unknown>
    const err = (meta.Error ?? {}) as Record<string, unknown>
    const errCode = String(err.Code ?? '')
    if (errCode) {
      const msg = String(err.Message || '')
      const hint = errCode === 'AccessDenied' || errCode === 'PermissionDenied'
        ? '（该 AK 无权访问账单接口：请检查密钥权限，子账号需授权 billing:QueryBalanceAcct）'
        : ''
      throw new ProviderError(msg ? `${errCode}：${msg}${hint}` : `接口错误（${errCode}）${hint}`)
    }
    const result = (data.Result ?? {}) as Record<string, unknown>
    const remaining = num(result.AvailableBalance)
    if (remaining === null) {
      throw new ProviderError('响应中没有可用余额（Result.AvailableBalance）。')
    }
    const currency = String(result.Currency || 'CNY').toUpperCase()
    const cash = num(result.CashBalance)
    const credit = num(result.CreditLimit)
    const freeze = num(result.FreezeAmount)
    const arrears = num(result.ArrearsBalance)
    const fmt = (x: number | null) =>
      x === null ? '-' : x.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
    const parts: string[] = []
    if (cash !== null) parts.push(`现金 ${fmt(cash)}`)
    if (credit !== null) parts.push(`信用 ${fmt(credit)}`)
    if (freeze !== null) parts.push(`冻结 ${fmt(freeze)}`)
    if (arrears !== null && arrears > 0) parts.push(`欠费 ${fmt(arrears)}`)

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
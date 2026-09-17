// 无真实账号的适配器自检：本地假服务器模拟各站点响应（对齐原 Python 版 test_smoke.py 思路）

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http, { type Server } from 'node:http'
import { createHash, createHmac } from 'node:crypto'
import { fetchEntry } from '../src/lib/worker'
import type { NetClient, NetRequest, NetResponse } from '../src/providers/types'

function json(res: http.ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** 启动一个假服务器，按 path → 处理器 分发 */
function startServer(routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>) {
  const s = http.createServer((req, res) => {
    const path = req.url ?? ''
    const handler = Object.entries(routes).find(([p]) => path.includes(p))?.[1]
    if (handler) handler(req, res)
    else json(res, 404, { detail: 'Not Found' })
  })
  return new Promise<Server>((resolve) => {
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
}

function portOf(s: Server): number {
  const addr = s.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

// ---------- 假 NetClient：走 node fetch，不经 Tauri ----------
class FakeClient implements NetClient {
  count = 0 // 请求计数（缓存优化测试用）
  constructor(private base: string) {}
  baseUrl(): string {
    return this.base
  }
  async request(req: NetRequest): Promise<NetResponse> {
    this.count += 1
    const url = req.url.startsWith('http') ? req.url : this.base + req.url
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = v
    if (req.contentType) headers['content-type'] = req.contentType
    const resp = await fetch(url, { method: req.method, headers, body: req.body })
    const buf = new Uint8Array(await resp.arrayBuffer())
    const body = new TextDecoder().decode(buf)
    return { status: resp.status, body }
  }
}

function entry(providerId: string, config: Record<string, unknown>, displayName = '测试站点') {
  return {
    uid: `u-${providerId}`,
    providerId,
    displayName,
    enabled: true,
    autoRefreshMinutes: 0,
    config,
  }
}

// ---------- 服务器 ----------
let main: Server // 正常响应
let errServer: Server // HTTP 500 + 非 JSON
let loginFail: Server // 登录失败
let htmlServer: Server // HTML 自动识别
let acctServer: Server // 仅账户页有余额
let tkServer: Server // tokenrhythm 风格（json+account 登录 + 钱包 API）
let sub2Server: Server // Sub2API 风格（/api/v1/auth/login，登录响应即带余额）
let ocClients: FakeClient[] // OpenCode mock 客户端（Code AI describe 共用）
let max66Server: Server // max66 风格：paygo_balance + remaining_calls（多方案，不同 key）
let zeroServer: Server // 多计费字段但值为 0（未开通/无额度）：0 值方案不自动勾选
let newapiServer: Server // One-API / New-API 风格：json+username 登录 + Bearer token 余额接口
let aliyunServer: Server // 阿里云 QueryAccountBalance（校验 RPC V1 签名）
let aliyunBadServer: Server // 阿里云未授权
let volcServer: Server // 火山引擎 QueryBalanceAcct（校验火山签名）
let volcBadServer: Server // 火山引擎无权限
let clients: FakeClient[]

beforeAll(async () => {
  main = await startServer({
    '/v1/dashboard/billing/credit_grants': (_req, res) =>
      json(res, 200, {
        object: 'credit_grants',
        total_granted: 18,
        total_used: 10.5,
        total_available: 7.5,
        grants: { data: [{ expires_at: '2025-12-31T00:00:00Z' }] },
      }),
    '/user/balance': (_req, res) =>
      json(res, 200, {
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '16.71', granted_balance: '0.00', topped_up_balance: '16.71' },
        ],
      }),
    '/api/v1/auth/key': (_req, res) =>
      json(res, 200, {
        data: { label: 'test-key', credits: 12.34, usage: 1.66, limit: 14, is_free_tier: false },
      }),
    '/v1/api/openplatform/coding_plan/remains': (_req, res) =>
      json(res, 200, {
        model_remains: {
          'MiniMax-M2.5': { limit: 1000000, used: 234567, remains: 765433 },
          'MiniMax-H3': { limit: 500000, used: 0, remains: 500000 },
        },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    '/api/user/self': (_req, res) =>
      json(res, 200, {
        success: true,
        message: '',
        data: { id: 1, username: 'tester', quota: 4981234, used_quota: 18766, request_count: 123 },
      }),
    '/api/v1/auth/login': (_req, res) =>
      json(res, 200, {
        code: 0,
        message: 'success',
        data: { access_token: 'jwt-test-token', user: { id: 1 } },
      }),
    '/api/v1/user/profile': (_req, res) =>
      json(res, 200, {
        code: 0,
        message: 'success',
        data: { balance: 42.5, frozen_balance: 1.5, total_recharged: 100, username: 'maru' },
      }),
    '/api/v1/usage/stats': (_req, res) =>
      json(res, 200, {
        code: 0,
        message: 'success',
        data: { total_tokens: 123456, total_cost: 5.2, total_actual_cost: 5.2 },
      }),
  })

  errServer = await startServer({
    '/v1/dashboard/billing/credit_grants': (_req, res) =>
      json(res, 500, { error: { message: 'boom', type: 'server_error' } }),
    '/user/balance': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html>这不是 JSON</html>')
    },
    '/v1/api/openplatform/coding_plan/remains': (_req, res) =>
      json(res, 200, {
        model_remains: null,
        base_resp: { status_code: 2062, status_msg: 'no active token plan subscription' },
      }),
  })

  loginFail = await startServer({
    '/api/v1/auth/login': (_req, res) => json(res, 200, { code: 1, message: '邮箱或密码错误' }),
  })

  htmlServer = await startServer({
    '/api/login': (_req, res) => json(res, 200, { ok: true }),
    '/dashboard': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><body>
<div class="stats">
  <div class="stat"><div class="v">¥ 12.34</div><div class="l">账户余额</div></div>
  <div class="stat"><div class="v">¥ 55.00</div><div class="l">今日已用</div></div>
  <div class="stat"><div class="v">3</div><div class="l">剩余次数</div></div>
  <div class="stat"><div class="v">2024</div><div class="l">注册年份</div></div>
</div>
</body></html>`)
    },
    '/no-balance': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>欢迎回来</h1><p>登录成功</p></body></html>')
    },
    // 根路径：无余额（模拟真实站点首页），验证自动寻找控制台（必须放最后，避免 "/" 截胡其他路由）
    '/': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>欢迎回来</h1><p>请点击控制台查看余额</p></body></html>')
    },
  })

  // 仅账户页有余额的站点（控制台路径全部无余额）
  acctServer = await startServer({
    '/api/login': (_req, res) => json(res, 200, { ok: true }),
    '/account/account': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body><div>账户余额 <b>¥ 77.77</b></div></body></html>')
    },
  })

  // tokenrhythm 风格：json+account 登录 + 余额在 JSON API（非 HTML 页面）
  tkServer = await startServer({
    '/api/auth/login': (req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(body)
        } catch {
          // 非 JSON（form 探测）→ 404，让探测继续
          json(res, 404, { detail: 'Not Found' })
          return
        }
        if (parsed.account === 'user1' && parsed.password === 'pw') {
          res.setHeader('Set-Cookie', 'tr_session=abc123; Path=/')
          json(res, 200, { code: 0, message: 'ok', data: { user: { id: 1, username: 'user1' } } })
        } else {
          json(res, 200, { code: 1, message: '账号或密码错误' })
        }
      })
    },
    '/api/wallet/summary': (_req, res) =>
      json(res, 200, {
        code: 0,
        data: { availableBalanceCny: '88.5', giftAvailableCny: '1.5', rechargeBalanceCny: '87', currency: 'CNY' },
      }),
  })

  // Sub2API 框架同源站点（lvzhouai / poke2api / muteki 等）：
  // 登录接口就是标准 /api/v1/auth/login（JSON {email, password}），
  // 登录响应直接带 user.balance —— generic_login_html 自动探测后即可直接识别，
  // 无需专门的 Sub2API 适配器（该适配器已移除，见 registry.ts）
  sub2Server = await startServer({
    '/api/v1/auth/login': (req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          if (parsed.email === 'a@b.com' && parsed.password === 'pw') {
            json(res, 200, {
              code: 0,
              message: 'success',
              data: {
                access_token: 'jwt-sub2-token',
                refresh_token: 'rt-test',
                expires_in: 86400, // token 有效期（非包时套餐），不得误判为 duration
                token_type: 'Bearer',
                user: { id: 1, email: 'a@b.com', balance: 42.5, frozen_balance: 1.5, total_recharged: 100, username: 'maru' },
              },
            })
          } else {
            json(res, 200, { code: 1, message: '邮箱或密码错误' })
          }
        } catch {
          json(res, 400, { code: 400, message: 'bad json' })
        }
      })
    },
  })

  // max66 风格：form 登录，响应同时带 paygo_balance（按量）和 remaining_calls（按次）
  max66Server = await startServer({
    '/user/login': (_req, res) =>
      json(res, 200, {
        ok: true,
        api_key: 'sk-test',
        email_verified: true,
        remaining_calls: 120,
        paygo_balance: 9.63,
      }),
  })

  // 多计费字段但 times/duration 为 0（站点未开通/无额度/无时间）：0 值方案不自动勾选
  zeroServer = await startServer({
    '/user/login': (_req, res) =>
      json(res, 200, {
        ok: true,
        api_key: 'sk-zero',
        email_verified: true,
        paygo_balance: 12.5,
        remaining_calls: 0,
        duration: 0,
      }),
  })

  // One-API / New-API 风格（统一由 generic_login_html 自动识别接管）：
  // 登录字段是 username（email/account 组合全部返回失败），余额在 /api/user/self（需 Bearer token）
  newapiServer = await startServer({
    // 登录页（SPA）：用户可能把 login_url 填成这个（POST 返回 HTML，非成功登录）
    '/sign-in': (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><html lang="en"><body>sign-in page</body></html>')
    },
    '/api/user/login': (req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(body)
        } catch {
          json(res, 200, { message: 'Invalid parameters', success: false })
          return
        }
        if (parsed.username === 'user1' && parsed.password === 'pw') {
          json(res, 200, {
            success: true,
            data: { access_token: 'jwt-newapi-token', token_type: 'Bearer', user: { id: 1, username: 'user1' } },
          })
        } else {
          json(res, 200, { message: 'Invalid parameters', success: false })
        }
      })
    },
    // 余额接口：必须带 Bearer token（校验登录响应捕获的 token 是否正确传递）
    '/api/user/self': (req, res) => {
      const auth = req.headers.authorization || ''
      if (!auth.startsWith('Bearer jwt-newapi-token')) {
        json(res, 401, { code: 'AUTH_UNAUTHORIZED', message: 'Unauthorized, invalid access token', success: false })
        return
      }
      json(res, 200, {
        success: true,
        message: '',
        data: { id: 1, username: 'user1', quota: 250000, used_quota: 100000, request_count: 5 },
      })
    },
  })

  // 阿里云 QueryAccountBalance：用与适配器同款 Rules 重新签名校验真实签名
  const aliyunSecret = 'test-alibaba-secret'
  const enc = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  aliyunServer = await startServer({
    '/': (req, res) => {
      const url = new URL(req.url ?? '', 'http://x')
      const params = url.searchParams
      const provided = String(params.get('Signature') ?? '')
      params.delete('Signature')
      const canonical = [...params.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${enc(k)}=${enc(v)}`)
        .join('&')
      const stringToSign = `GET&${enc('/')}&${enc(canonical)}`
      const expected = createHmac('sha1', aliyunSecret + '&')
        .update(stringToSign, 'utf8')
        .digest('base64')
      if (provided !== expected) {
        json(res, 200, {
          RequestId: 'req-sig',
          Code: 'SignatureDoesNotMatch',
          Message: 'The request signature we calculated does not match the signature you provided.',
        })
        return
      }
      json(res, 200, {
        RequestId: 'req-1',
        Success: true,
        Code: '200',
        Data: {
          AvailableAmount: '100.00',
          AvailableCashAmount: '99.50',
          CreditAmount: '0.00',
          MybankCreditAmount: '0.00',
          Currency: 'CNY',
        },
      })
    },
  })
  aliyunBadServer = await startServer({
    '/': (_req, res) =>
      json(res, 200, {
        RequestId: 'req-bad',
        Code: 'NotAuthorized',
        Message: 'This API is not authorized for caller.',
      }),
  })

  // 火山引擎 QueryBalanceAcct：用 node:crypto 按火山签名规则重算校验
  const volcSecret = 'volc-test-secret'
  const volcSignVerify = (req: http.IncomingMessage): boolean => {
    const url = new URL(req.url ?? '', 'http://x')
    const auth = String(req.headers.authorization ?? '')
    const xdate = String(req.headers['x-date'] ?? '')
    const m = auth.match(/Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)/)
    if (!m) return false
    const [, ak, date, region, service, signedHeaders, expected] = m
    if (signedHeaders !== 'host;x-date') return false
    const host = req.headers.host ?? ''
    const qs = [...url.searchParams.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const emptyHash = createHash('sha256').update('', 'utf8').digest('hex')
    const canonicalRequest = ['GET', '/', qs, `host:${host}\nx-date:${xdate}\n`, 'host;x-date', emptyHash].join('\n')
    const credentialScope = `${date}/${region}/${service}/request`
    const stringToSign = ['HMAC-SHA256', xdate, credentialScope, createHash('sha256').update(canonicalRequest, 'utf8').digest('hex')].join('\n')
    const dig = (key: Buffer, d: string) => createHmac('sha256', key).update(d, 'utf8').digest()
    const kDate = dig(Buffer.from(volcSecret, 'utf8'), date)
    const kRegion = dig(kDate, region)
    const kService = dig(kRegion, service)
    const kSigning = dig(kService, 'request')
    const actual = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
    return actual === expected
  }
  volcServer = await startServer({
    '/': (req, res) => {
      if (!volcSignVerify(req)) {
        json(res, 200, {
          ResponseMetadata: { RequestId: 'r-sig', Error: { Code: 'InvalidAuthorization', Message: 'Invalid Authorization header' } },
        })
        return
      }
      json(res, 200, {
        ResponseMetadata: { RequestId: 'r-1' },
        Result: {
          AccountID: 2131245218,
          ArrearsBalance: '0',
          AvailableBalance: '88.55',
          CashBalance: '80.00',
          CreditLimit: '10.00',
          Currency: 'CNY',
          FreezeAmount: '1.50',
        },
      })
    },
  })
  volcBadServer = await startServer({
    '/': (_req, res) =>
      json(res, 200, {
        ResponseMetadata: { RequestId: 'r-bad', Error: { Code: 'AccessDenied', Message: 'no permission' } },
      }),
  })

  clients = [
    new FakeClient(`http://127.0.0.1:${portOf(main)}`),
    new FakeClient(`http://127.0.0.1:${portOf(errServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(loginFail)}`),
    new FakeClient(`http://127.0.0.1:${portOf(htmlServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(acctServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(tkServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(sub2Server)}`),
    new FakeClient(`http://127.0.0.1:${portOf(max66Server)}`),
    new FakeClient(`http://127.0.0.1:${portOf(zeroServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(aliyunServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(aliyunBadServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(volcServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(volcBadServer)}`),
    new FakeClient(`http://127.0.0.1:${portOf(newapiServer)}`),
  ]
})

afterAll(() => {
  main?.close()
  errServer?.close()
  loginFail?.close()
  htmlServer?.close()
  acctServer?.close()
  tkServer?.close()
  sub2Server?.close()
  max66Server?.close()
  zeroServer?.close()
  newapiServer?.close()
  aliyunServer?.close()
  aliyunBadServer?.close()
  volcServer?.close()
  volcBadServer?.close()
})

describe('OpenAI 兼容计费接口', () => {
  it('解析 credit_grants 结构', async () => {
    const info = await fetchEntry(
      entry('openai_compat', { base_url: clients[0].baseUrl(), api_key: 'sk-test' }),
      clients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.total).toBeCloseTo(18)
    expect(info.remaining).toBeCloseTo(7.5)
    expect(info.currency).toBe('CNY') // 默认强制 CNY
  })

  it('币种可由 display_currency 覆盖', async () => {
    const info = await fetchEntry(
      entry('openai_compat', { base_url: clients[0].baseUrl(), api_key: 'sk-test', display_currency: 'USD' }),
      clients[0],
    )
    expect(info.currency).toBe('USD')
  })
})

describe('DeepSeek 官方', () => {
  it('解析 balance_infos（剩余=总余额）', async () => {
    const info = await fetchEntry(
      entry('deepseek_official', { api_key: 'sk-test', api_base: clients[0].baseUrl() }),
      clients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.total).toBeCloseTo(16.71)
    expect(info.remaining).toBeCloseTo(16.71)
    expect(info.currency).toBe('CNY')
    expect(info.message).toContain('充值 16.71')
  })
})

describe('OpenRouter', () => {
  it('解析 auth/key（credits=剩余）', async () => {
    const info = await fetchEntry(
      entry('openrouter', { api_key: 'sk-or-test', api_base: clients[0].baseUrl() }),
      clients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(12.34)
    expect(info.total).toBeCloseTo(14)
    expect(info.currency).toBe('USD') // OpenRouter 官方 credits 即美元，保留标准币种
  })
})

describe('Sub2API 风格站点（通用自动识别接管）', () => {
  it('自动探测标准 /api/v1/auth/login（JSON email/password）并识别登录响应余额', async () => {
    // 只填主站根地址，不指定登录页/余额页 —— 完全依赖自动探测
    const info = await fetchEntry(
      entry('generic_login_html', { login_url: clients[6].baseUrl(), email: 'a@b.com', password: 'pw' }),
      clients[6],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    // 登录响应 user.balance 直接命中
    expect(info.remaining).toBeCloseTo(42.5)
    expect(info.currency).toBe('CNY')
    expect(info.message).toContain('自动识别')
    // 探测结果缓存（登录接口 + 余额来源）写回 config 供后续复用
    const dc = info.detectedConfig ?? {}
    expect(dc._detected_login).toMatchObject({ url: `${clients[6].baseUrl()}/api/v1/auth/login`, isJson: true })
    expect(dc._detected_balance).toMatchObject({ source: 'login' })
    // expires_in（token 有效期）不得误判为包时套餐；单方案（paygo）时 plans 也返回以便 worker 修正勾选
    expect(info.plans?.duration).toBeUndefined()
    expect(info.plans?.paygo).toBeDefined()
    expect(info.plans?.paygo?.remaining).toBeCloseTo(42.5)
    expect(info.remaining).toBeCloseTo(42.5)
    // 自动勾选：billingPlans 重写为识别结果（单方案 paygo）
    const dc2 = info.detectedConfig ?? {}
    expect(dc2.billingPlans).toEqual(['paygo'])
  })

  it('登录失败时返回明确错误', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', { login_url: clients[6].baseUrl(), email: 'x', password: 'y' }),
      clients[6],
    )
    expect(info.ok).toBe(false)
    // 通用探测不预设接口：密码错误 = 所有候选组合均登录失败 →「未找到可用的登录接口」
    expect(info.message).toContain('未找到可用的登录接口')
  })

  it('缓存余额来源为 404 路径时回退重探测（不把 404 错误体当余额）', async () => {
    // 模拟被污染的缓存：_detected_balance 指向 404 路径（如缺 /login 的 /api/v1/auth）
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[6].baseUrl(),
        email: 'a@b.com',
        password: 'pw',
        _detected_login: { url: `${clients[6].baseUrl()}/api/v1/auth/login`, isJson: true, emailField: 'email', passwordField: 'password' },
        _detected_balance: { source: 'page', url: `${clients[6].baseUrl()}/api/v1/auth` }, // 404 路径
      }),
      clients[6],
    )
    // 404 来源失效 → 回退全量探测 → 登录响应 user.balance 命中
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    expect(info.remaining).toBeCloseTo(42.5)
    expect(info.detectedConfig?._detected_balance).toMatchObject({ source: 'login' })
  })

  it('识别多种计费方式（不同 key）并自动勾选：paygo_balance + remaining_calls', async () => {
    // max66 风格：form 登录响应同时带 paygo_balance（按量）和 remaining_calls（按次）
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[7].baseUrl(), // 只填根地址，自动探测 /user/login
        email: 'a@b.com',
        password: 'pw',
      }),
      clients[7],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    // 主余额 = 按量 paygo_balance
    expect(info.remaining).toBeCloseTo(9.63)
    // 多方案数据：paygo + times 分别产出
    expect(info.plans?.paygo).toBeDefined()
    expect(info.plans?.times).toBeDefined()
    expect(info.plans?.times?.remaining).toBeCloseTo(120)
    // 自动勾选：worker 重写 billingPlans（主方案排前）并通过 detectedConfig 落库；主方案 = 主余额 paygo
    const dc = info.detectedConfig ?? {}
    expect(dc.billingPlans).toEqual(['paygo', 'times'])
    expect(dc.primaryPlan).toBe('paygo')
  })

  it('多计费字段但 times/duration 值为 0（未开通/无额度）→ 不自动勾选，仅按量', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[8].baseUrl(), // 只填根地址，自动探测 /user/login
        email: 'a@b.com',
        password: 'pw',
      }),
      clients[8],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    // 主余额 = paygo_balance（唯一有实际额度的方案）
    expect(info.remaining).toBeCloseTo(12.5)
    // 0 值 times/duration 不上报为方案：不产生「按次」「包时」卡片，也不自动勾选
    expect(info.plans?.times).toBeUndefined()
    expect(info.plans?.duration).toBeUndefined()
    expect(info.plans?.paygo?.remaining).toBeCloseTo(12.5)
    const dc = info.detectedConfig ?? {}
    expect(dc.billingPlans).toEqual(['paygo'])
  })

  it('阿里云 AccessKey 查询可用余额（QueryAccountBalance 签名 + 解析）', async () => {
    const info = await fetchEntry(
      entry('aliyun', {
        access_key_id: 'LTAI-test-id',
        access_key_secret: 'test-alibaba-secret',
        api_base: clients[9].baseUrl(),
      }),
      clients[9],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    expect(info.remaining).toBeCloseTo(100.0)
    expect(info.currency).toBe('CNY')
    expect(info.extra).toContain('现金余额 99.5')
  })

  it('阿里云 AK 未授权（NotAuthorized）→ 提示需要 BSS 只读权限', async () => {
    const info = await fetchEntry(
      entry('aliyun', {
        access_key_id: 'LTAI-test-id',
        access_key_secret: 'test-alibaba-secret',
        api_base: clients[10].baseUrl(),
      }),
      clients[10],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('NotAuthorized')
    expect(info.message).toContain('AliyunBSSReadOnlyAccess')
  })

  it('阿里云缺必需配置 → 明确报错', async () => {
    const info = await fetchEntry(entry('aliyun', {}), clients[9])
    expect(info.ok).toBe(false)
    expect(info.message).toContain('AccessKey')
  })

  it('火山引擎 AccessKey 查询可用余额（火山签名 + 解析）', async () => {
    const info = await fetchEntry(
      entry('volcengine', {
        access_key_id: 'AKLT-test',
        access_key_secret: 'volc-test-secret',
        api_base: clients[11].baseUrl(),
      }),
      clients[11],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    expect(info.remaining).toBeCloseTo(88.55)
    expect(info.currency).toBe('CNY')
    expect(info.extra).toContain('现金 80')
    expect(info.extra).toContain('信用 10')
    expect(info.extra).toContain('冻结 1.5')
  })

  it('火山引擎无权限（AccessDenied）→ 提示密钥权限', async () => {
    const info = await fetchEntry(
      entry('volcengine', {
        access_key_id: 'AKLT-test',
        access_key_secret: 'volc-test-secret',
        api_base: clients[12].baseUrl(),
      }),
      clients[12],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('AccessDenied')
  })
})

describe('One-API / New-API 风格（自动识别接管）', () => {
  it('自动探测 json+username 登录，Bearer token 查 /api/user/self 并按 500000:1 换算美元', async () => {
    // 只填主站根地址（域名非 URL 简写会直用？此处填完整 URL，走自动探测）
    const info = await fetchEntry(
      entry('generic_login_html', { login_url: clients[13].baseUrl(), email: 'user1', password: 'pw' }),
      clients[13],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    // quota 250000 → 250000/500000 = 0.5 USD → 默认 1:1 换算为 CNY 显示（数值不变）
    expect(info.remaining).toBeCloseTo(0.5, 4)
    expect(info.currency).toBe('CNY')
    expect(info.message).toContain('自动识别')
    // 探测结果：登录接口命中 /api/user/login + username 字段（email/account 组合全部失败后命中）
    const dc = info.detectedConfig ?? {}
    expect(dc._detected_login).toMatchObject({
      url: `${clients[13].baseUrl()}/api/user/login`,
      isJson: true,
      emailField: 'username',
    })
    // 余额来源：/api/user/self（带登录响应捕获的 Bearer token）
    expect(dc._detected_balance).toMatchObject({ source: 'api', url: `${clients[13].baseUrl()}/api/user/self` })
    // 自动勾选 paygo 方案（同样按 1:1 换算为 CNY）
    expect(info.plans?.paygo?.remaining).toBeCloseTo(0.5)
    expect(info.plans?.paygo?.currency).toBe('CNY')
  })

  it('自定义 USD→CNY 比例时按比例换算（usd_cny_rate=7.2 → 0.5×7.2=3.6）', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[13].baseUrl(),
        email: 'user1',
        password: 'pw',
        usd_cny_rate: 7.2,
      }),
      clients[13],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    expect(info.remaining).toBeCloseTo(3.6, 4)
    expect(info.currency).toBe('CNY')
    expect(info.plans?.paygo?.remaining).toBeCloseTo(3.6)
  })

  it('login_url 填登录页地址（/sign-in 返回 HTML）时自动回退探测登录接口', async () => {
    // 用户把登录页地址填进了 login_url（如 https://api.maomaoai.pro/sign-in）
    const info = await fetchEntry(
      entry('generic_login_html', { login_url: `${clients[13].baseUrl()}/sign-in`, email: 'user1', password: 'pw' }),
      clients[13],
    )
    // 直用 /sign-in POST 返回 HTML 失败 → 自动回退探测 /api/user/login json+username → 成功
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    expect(info.remaining).toBeCloseTo(0.5, 4)
    expect(info.currency).toBe('CNY')
    // 缓存写回的是探测到的真实登录接口（下次刷新直接复用，不再走 /sign-in）
    const dc = info.detectedConfig ?? {}
    expect(dc._detected_login).toMatchObject({
      url: `${clients[13].baseUrl()}/api/user/login`,
      isJson: true,
      emailField: 'username',
    })
    expect(dc._detected_balance).toMatchObject({ source: 'api', url: `${clients[13].baseUrl()}/api/user/self` })
  })
})

describe('通用 HTML 自动识别', () => {
  it('登录后从指定页面识别余额（关键词 + 币种）', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: `${clients[3].baseUrl()}/api/login`,
        email: 'a@b.com',
        password: 'pw',
        page_url: `${clients[3].baseUrl()}/dashboard`,
      }),
      clients[3],
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(12.34)
    expect(info.currency).toBe('CNY')
    expect(info.message).toContain('自动识别')
    // 返回候选列表供校准（含今日已用 ¥55）
    expect(info.candidates!.length).toBeGreaterThan(1)
    expect(info.candidates!.some((c) => c.value === 55)).toBe(true)
  })

  it('用户确认候选后优先匹配同一处的新数值（记住选择）', async () => {
    const base = {
      login_url: `${clients[3].baseUrl()}/api/login`,
      email: 'a@b.com',
      password: 'pw',
      page_url: `${clients[3].baseUrl()}/dashboard`,
    }
    const info1 = await fetchEntry(entry('generic_login_html', base), clients[3])
    // 默认 best 是账户余额 12.34
    expect(info1.remaining).toBeCloseTo(12.34)
    // 用户选择「今日已用 ¥55」候选（记住其上下文特征）
    const choice = info1.candidates!.find((c) => c.value === 55)
    expect(choice).toBeDefined()
    const info2 = await fetchEntry(
      entry('generic_login_html', {
        ...base,
        balance_choice: { value: 55, context: choice!.context },
      }),
      clients[3],
    )
    expect(info2.remaining).toBeCloseTo(55)
    expect(info2.message).toContain('已按你确认的数值识别')
  })

  it('余额页面地址留空时自动寻找控制台页面', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: `${clients[3].baseUrl()}/api/login`,
        email: 'a@b.com',
        password: 'pw',
      }),
      clients[3],
    )
    expect(info.ok).toBe(true)
    // 首页无余额 → 自动命中 /dashboard（或推断路径）上的余额
    expect(info.remaining).toBeCloseTo(12.34)
    expect(info.currency).toBe('CNY')
    expect(info.message).toContain('自动识别')
  })

  it('只填主站地址时自动探测登录接口', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[3].baseUrl(), // 只填主站根地址
        email: 'a@b.com',
        password: 'pw',
      }),
      clients[3],
    )
    expect(info.ok).toBe(true)
    // 自动探测到 /api/login → 登录 → 自动找控制台余额
    expect(info.remaining).toBeCloseTo(12.34)
    expect(info.currency).toBe('CNY')
  })

  it('控制台页面无果时命中账户页面', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[4].baseUrl(), // 只填主站根地址
        email: 'a@b.com',
        password: 'pw',
      }),
      clients[4],
    )
    expect(info.ok).toBe(true)
    // 控制台路径全部无余额 → 命中 /account/account
    expect(info.remaining).toBeCloseTo(77.77)
    expect(info.currency).toBe('CNY')
  })

  it('缓存优化：首次探测返回缓存配置，后续刷新直接复用（请求数大减）', async () => {
    const base = {
      login_url: `${clients[3].baseUrl()}/api/login`,
      email: 'a@b.com',
      password: 'pw',
      page_url: `${clients[3].baseUrl()}/dashboard`,
    }
    const c = new FakeClient(clients[3].baseUrl())
    // 首次：登录 + 全量探测（登录响应无余额 → API 探测 404 → 页面 /dashboard 命中）
    const info1 = await fetchEntry(entry('generic_login_html', base), c)
    expect(info1.ok).toBe(true)
    expect(info1.detectedConfig).toBeDefined()
    expect(info1.detectedConfig!._detected_balance).toBeDefined()
    const firstCount = c.count
    expect(firstCount).toBeGreaterThan(2) // 探测阶段多次请求

    // 第二次：携带缓存配置 → 直接复用（登录 1 次 + 余额来源 1 次）
    const cached = info1.detectedConfig!
    const info2 = await fetchEntry(entry('generic_login_html', { ...base, ...cached }), c)
    expect(info2.ok).toBe(true)
    expect(info2.remaining).toBeCloseTo(12.34)
    expect(info2.detectedConfig).toBeUndefined() // 已缓存，不再返回
    const secondCount = c.count - firstCount
    expect(secondCount).toBeLessThanOrEqual(3)
  })

  it('tokenrhythm 风格：自动探测 json+account 登录 + 从钱包 API 取余额', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: clients[5].baseUrl(), // 只填主站根
        email: 'user1',
        password: 'pw',
      }),
      clients[5],
    )
    expect(info.ok, `失败原因: ${info.message}`).toBe(true)
    expect(info.remaining).toBeCloseTo(88.5)
    expect(info.currency).toBe('CNY')
    expect(info.message).toContain('wallet.summary')
  })

  it('页面无余额数字时给出明确错误', async () => {
    const info = await fetchEntry(
      entry('generic_login_html', {
        login_url: `${clients[3].baseUrl()}/api/login`,
        email: 'a@b.com',
        password: 'pw',
        page_url: `${clients[3].baseUrl()}/no-balance`,
      }),
      clients[3],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('未能识别出余额')
  })
})

describe('错误处理', () => {
  it('HTTP 500 → ok=false 且不崩溃', async () => {
    const info = await fetchEntry(
      entry('openai_compat', { base_url: clients[1].baseUrl(), api_key: 'k' }),
      clients[1],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('HTTP 500')
  })

  it('响应不是 JSON → 明确报错', async () => {
    const info = await fetchEntry(
      entry('deepseek_official', { api_key: 'k', api_base: clients[1].baseUrl() }),
      clients[1],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('响应不是 JSON')
  })

  it('未知站点类型 → 明确报错', async () => {
    const info = await fetchEntry(entry('no_such_provider', {}), clients[0])
    expect(info.ok).toBe(false)
    expect(info.message).toContain('未知的站点类型')
  })

  it('缺少必填字段 → 明确报错', async () => {
    const info = await fetchEntry(entry('openai_compat', {}), clients[0])
    expect(info.ok).toBe(false)
    expect(info.message).toContain('缺少接口地址或 API Key')
  })

  it('代理配置注入到每个请求', async () => {
    let capturedProxy: string | undefined
    const spyClient: NetClient = {
      request: async (req) => {
        capturedProxy = req.proxy
        return clients[0].request(req) // 正常转发
      },
    }
    const info = await fetchEntry(
      entry('openai_compat', {
        base_url: clients[0].baseUrl(),
        api_key: 'sk-test',
        proxy: 'http://127.0.0.1:7890',
      }),
      spyClient,
    )
    expect(info.ok).toBe(true)
    expect(capturedProxy).toBe('http://127.0.0.1:7890')
  })
})

// ---------- OpenCode 适配器（Go 用量 API + Zen 余额 HTML） ----------
describe('OpenCode 适配器', () => {
  let oc: Server
  let oc403: Server // usage 接口 403（key 有效但无 Go 订阅）
  ocClients = [] as FakeClient[]

  beforeAll(async () => {
    oc = await startServer({
      // 官方未文档化接口：/zen/go/v1/usage（Bearer 鉴权）
      '/zen/go/v1/usage': (_req, res) =>
        json(res, 200, {
          usage: {
            rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
            weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
            monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
          },
        }),
      // Zen dashboard：SSR HTML 内联余额
      '/workspace/wrk_test': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><main>Current balance <b>$12.34</b></main></body></html>')
      },
    })
    oc403 = await startServer({
      // Go 403：key 有效但无 Go 订阅
      '/zen/go/v1/usage': (_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'no go subscription' } }))
      },
      '/workspace/wrk_test': (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><main>Current balance <b>$12.34</b></main></body></html>')
      },
    })
    ocClients = [
      new FakeClient(`http://127.0.0.1:${portOf(oc)}`),
      new FakeClient(`http://127.0.0.1:${portOf(oc403)}`),
    ]
  })

  afterAll(() => {
    oc?.close()
    oc403?.close()
  })

  it('Go 用量（API Key）→ plan 方案，自动勾选', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'opencode',  api_base: ocClients[0].baseUrl(), api_key: 'sk-oc' }),
      ocClients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(96) // 100 - rolling 4%
    expect(info.currency).toBe('%')
    expect(info.plans?.plan?.remaining).toBeCloseTo(96)
    // 三窗口逐行展示（5h → 周 → 月），每行「剩X% · 已用X% · 重置MM-DD」
    expect(info.extra).toContain('5h 剩96% · 已用4% · 重置08-13')
    expect(info.extra).toContain('周 剩97% · 已用3% · 重置08-17')
    expect(info.extra).toContain('月 剩99% · 已用1% · 重置09-13')
    expect(info.extra?.split('\n')).toHaveLength(3)
    expect(info.detectedConfig?.billingPlans).toEqual(['plan'])
  })

  it('Zen 余额（cookie + workspace）→ paygo 方案，自动勾选', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'opencode', 
        api_base: ocClients[0].baseUrl(),
        auth_cookie: 'abc',
        workspace_id: 'wrk_test',
      }),
      ocClients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(12.34)
    expect(info.currency).toBe('USD')
    expect(info.plans?.paygo?.remaining).toBeCloseTo(12.34)
    expect(info.detectedConfig?.billingPlans).toEqual(['paygo'])
  })

  it('两者都配置 → 两种计费方式（Zen 主显示）', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'opencode', 
        api_base: ocClients[0].baseUrl(),
        api_key: 'sk-oc',
        auth_cookie: 'abc',
        workspace_id: 'wrk_test',
      }),
      ocClients[0],
    )
    expect(info.plans?.paygo?.remaining).toBeCloseTo(12.34)
    expect(info.plans?.plan?.remaining).toBeCloseTo(96)
    expect(info.detectedConfig?.billingPlans).toEqual(['paygo', 'plan'])
    expect(info.remaining).toBeCloseTo(12.34)
  })

  it('Go 403（无订阅）→ 该方案无数据占位，Zen 正常', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'opencode', 
        api_base: ocClients[1].baseUrl(),
        api_key: 'sk-oc',
        auth_cookie: 'abc',
        workspace_id: 'wrk_test',
      }),
      ocClients[1],
    )
    expect(info.plans?.plan?.ok).toBe(false)
    expect(info.plans?.plan?.remaining).toBeNull()
    expect(info.plans?.paygo?.ok).toBe(true)
    expect(info.plans?.paygo?.remaining).toBeCloseTo(12.34)
  })

  it('无任何配置 → 明确报错', async () => {
    const info = await fetchEntry(entry('code_ai', { service: 'opencode', }), ocClients[0])
    expect(info.ok).toBe(false)
    expect(info.message).toContain('API Key')
  })

  it('只有 workspace 没有 cookie → 明确报错', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'opencode',  api_base: ocClients[0].baseUrl(), workspace_id: 'wrk_test' }),
      ocClients[0],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('auth Cookie')
  })

  it('旧 opencode id 别名兼容（getProvider 别名）', async () => {
    const info = await fetchEntry(
      entry('opencode', { service: 'opencode', api_base: ocClients[0].baseUrl(), api_key: 'sk-oc' }),
      ocClients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(96)
  })
})

// ---------- 自动识别（中转站）登录 Token 缓存机制 ----------
describe('登录 Token 缓存机制', () => {
  let cacheServer: Server // 登录返回 token + /api/user/self 返回余额（token 区分有效期）
  let limitServer: Server // 登录 409 AUTH_SESSION_LIMIT
  let cacheClient: FakeClient
  let limitClient: FakeClient

  class CountingClient implements NetClient {
    loginCount = 0
    constructor(private inner: NetClient) {}
    async request(req: NetRequest): Promise<NetResponse> {
      if (req.url.includes('/api/user/login')) this.loginCount += 1
      return this.inner.request(req)
    }
  }

  beforeAll(async () => {
    cacheServer = await startServer({
      '/api/user/login': (_req, res) =>
        json(res, 200, { token: 'tok-abc-123456', user: { name: 'u' }, code: 0 }),
      '/api/user/self': (req, res) => {
        const auth = req.headers.authorization || ''
        if (auth.includes('tok-expired')) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end('{"error":"invalid token"}')
          return
        }
        json(res, 200, { balance: 42.5, currency: 'CNY', code: 0 })
      },
    })
    limitServer = await startServer({
      '/api/user/login': (_req, res) =>
        json(res, 409, { code: 'AUTH_SESSION_LIMIT', message: 'Conflict', success: false }),
    })
    cacheClient = new FakeClient(`http://127.0.0.1:${portOf(cacheServer)}`)
    limitClient = new FakeClient(`http://127.0.0.1:${portOf(limitServer)}`)
  })

  afterAll(() => {
    cacheServer?.close()
    limitServer?.close()
  })

  const loginCfg = (base: string) => ({
    login_url: base,
    email: 'a@b.com',
    password: 'pw',
    _detected_login: {
      url: `${base}/api/user/login`,
      isJson: true,
      emailField: 'username',
      passwordField: 'password',
    },
  })

  it('首次登录：识别余额接口并缓存 token', async () => {
    const cc = new CountingClient(cacheClient)
    const info = await fetchEntry(entry('generic_login_html', loginCfg(cacheClient.baseUrl())), cc)
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(42.5)
    expect(cc.loginCount).toBe(1)
    expect(info.detectedConfig?._cached_token).toBe('tok-abc-123456')
    expect(info.detectedConfig?._detected_balance).toMatchObject({ source: 'api', url: `${cacheClient.baseUrl()}/api/user/self` })
  })

  it('Token 缓存命中：跳过登录直接查余额', async () => {
    const cc = new CountingClient(cacheClient)
    const info = await fetchEntry(
      entry('generic_login_html', {
        ...loginCfg(cacheClient.baseUrl()),
        _detected_balance: { source: 'api', url: `${cacheClient.baseUrl()}/api/user/self` },
        _cached_token: 'tok-abc-123456',
        _cached_token_at: Date.now(),
      }),
      cc,
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(42.5)
    expect(cc.loginCount).toBe(0) // 未重新登录
    expect(info.detectedConfig?._cached_token_at).toBeGreaterThan(Date.now() - 5000)
  })

  it('Token 失效（401）→ 自动清缓存并重新登录', async () => {
    const cc = new CountingClient(cacheClient)
    const info = await fetchEntry(
      entry('generic_login_html', {
        ...loginCfg(cacheClient.baseUrl()),
        _detected_balance: { source: 'api', url: `${cacheClient.baseUrl()}/api/user/self` },
        _cached_token: 'tok-expired',
        _cached_token_at: Date.now(),
      }),
      cc,
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(42.5)
    expect(cc.loginCount).toBe(1) // 缓存失效后重新登录
    expect(info.detectedConfig?._cached_token).toBe('tok-abc-123456') // 已刷新为新 token
  })

  it('会话数上限（409 AUTH_SESSION_LIMIT）→ 明确报错提示', async () => {
    const info = await fetchEntry(entry('generic_login_html', loginCfg(limitClient.baseUrl())), limitClient)
    expect(info.ok).toBe(false)
    expect(info.message).toContain('AUTH_SESSION_LIMIT')
    expect(info.message).toContain('退出旧会话')
  })
})

// ---------- Code AI 适配器：CommandCode（服务商下拉，API Key） ----------
describe('Code AI - CommandCode', () => {
  let cc: Server
  let ccClients: FakeClient[]
  let sawCliVersion = ''

  beforeAll(async () => {
    cc = await startServer({
      '/alpha/whoami': (_req, res) => json(res, 200, { org: { id: 'org_123' }, user: { name: 'u' } }),
      '/alpha/billing/credits': (req, res) => {
        sawCliVersion = String(req.headers['x-command-code-version'] || '')
        json(res, 200, {
          credits: {
            monthlyCredits: 25,
            purchasedCredits: 10,
            freeCredits: 5,
            premiumMonthlyCredits: 0,
          },
          windowLimits: {
            fiveHour: { cap: 100, used: 12, resetAt: '2026-08-30T12:00:00Z' },
            weekly: { cap: 500, used: 40, resetAt: '2026-08-31T00:00:00Z' },
          },
        })
      },
      '/alpha/billing/subscriptions': (_req, res) =>
        json(res, 200, {
          success: true,
          data: { planId: 'individual-pro', status: 'active', currentPeriodEnd: '2026-09-13T00:00:00.000Z' },
        }),
    })
    ccClients = [new FakeClient(`http://127.0.0.1:${portOf(cc)}`)]
  })

  afterAll(() => cc?.close())

  it('API Key → 月剩余额度 + 套餐信息', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'commandcode', api_base: ccClients[0].baseUrl(), api_key: 'cc-key' }),
      ccClients[0],
    )
    expect(info.ok).toBe(true)
    expect(info.remaining).toBeCloseTo(25)
    expect(info.currency).toBe('USD')
    expect(info.extra).toContain('套餐 Pro')
    expect(info.extra).toContain('$30/月')
    expect(info.extra).toContain('本期至 2026-09-13')
    expect(info.plans?.paygo?.remaining).toBeCloseTo(25)
    expect(info.detectedConfig?.billingPlans).toEqual(['paygo'])
    expect(sawCliVersion).toBe('0.52.1') // 官方 CLI 指纹头
  })

  it('免费用户（subscriptions data 为 null）→ 不报错，仅余额', async () => {
    // 临时把 subscriptions 换成 null 的服务器
    const free = await startServer({
      '/alpha/whoami': (_req, res) => json(res, 200, { org: { id: 'org_9' } }),
      '/alpha/billing/credits': (_req, res) =>
        json(res, 200, { credits: { monthlyCredits: 0, purchasedCredits: 0, freeCredits: 3 } }),
      '/alpha/billing/subscriptions': (_req, res) => json(res, 200, { success: true, data: null }),
    })
    try {
      const fc = new FakeClient(`http://127.0.0.1:${portOf(free)}`)
      const info = await fetchEntry(
        entry('code_ai', { service: 'commandcode', api_base: fc.baseUrl(), api_key: 'cc-key' }),
        fc,
      )
      expect(info.ok).toBe(true)
      expect(info.remaining).toBeCloseTo(3) // 免费额度兜底
      expect(info.extra).not.toContain('套餐')
    } finally {
      free.close()
    }
  })

  it('无 API Key → 明确报错', async () => {
    const info = await fetchEntry(
      entry('code_ai', { service: 'commandcode', api_base: ccClients[0].baseUrl() }),
      ccClients[0],
    )
    expect(info.ok).toBe(false)
    expect(info.message).toContain('CommandCode API Key')
  })
})

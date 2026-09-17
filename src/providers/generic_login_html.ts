// 通用「账号密码登录 + 自动识别 HTML 余额」适配器（实验性能力）
// 覆盖 max66.xyz / 基元律动 等没有开放 API Key、靠登录看网页的站点。
// 会话 cookie 由 Rust 侧网络层保持；启发式多策略识别余额数字，返回候选列表供用户在界面校准，
// 用户确认的候选（context 特征）会被记住，之后刷新优先匹配同一处的新数值。

import { num, ProviderError, type NetClient, type NetResponse, type Provider, type QuotaInfo } from './types'

const DEFAULT_KEYWORDS = ['余额', 'balance', 'credits', '额度', '剩余', 'available', 'account']

interface ScoredCandidate {
  value: number
  currency: string
  context: string
  score: number
  /** 识别出的计费方案（paygo/duration/times/plan），用于多方案自动勾选 */
  plan?: string
}

interface BalanceChoice {
  value?: number
  context?: string
}

export const genericLoginHtmlProvider: Provider = {
  id: 'generic_login_html',
  name: '自动识别(中转站用这个)',
  description:
    '通用能力（实验性）：填写登录接口与余额页面地址，自动从页面 HTML 中识别余额数字。识别到多个候选时会在「测试连接」结果里列出，请点选正确的余额，程序会记住你的选择。',
  websiteUrl: '',
  getWebsiteUrl(config) {
    // 从登录接口地址推断主站根（如 https://max66.xyz/user/login → https://max66.xyz）
    const loginUrl = String((config.login_url as string) || '').trim()
    try {
      const u = new URL(loginUrl)
      return u.origin
    } catch {
      return ''
    }
  },
  configSchema: [
    { key: 'login_url', label: '主站地址（或登录页面地址-login）', type: 'text', required: true, placeholder: '请尽量填写精确的登录页地址' },
    { key: 'email', label: '账号', type: 'text', required: true, placeholder: '登录账号' },
    { key: 'password', label: '密码', type: 'password', required: true, placeholder: '登录密码' },
    // —— 余额页面地址：非必填，展示在币种上方（用户指定优先，留空自动寻找）——
    { key: 'page_url', label: '余额页面地址', type: 'text', required: false, placeholder: '留空 = 自动寻找控制台/首页' },
    // —— 高级设置（登录细节微调）——
    { key: 'login_method', label: '登录方式', type: 'text', required: false, placeholder: 'form（默认）或 json', advanced: true },
    { key: 'email_field', label: '账号字段名', type: 'text', required: false, placeholder: '默认 email', advanced: true },
    { key: 'password_field', label: '密码字段名', type: 'text', required: false, placeholder: '默认 password', advanced: true },
    { key: 'keywords', label: '关键词', type: 'text', required: false, placeholder: '如：余额,balance（逗号分隔）', advanced: true },
    { key: 'usd_cny_rate', label: 'USD→CNY 换算比例（1 美元 = N 元）', type: 'number', required: false, placeholder: '默认 1（1:1 不换算）', advanced: true },
    { key: 'token_ttl_minutes', label: '登录 Token 缓存时长（分钟）', type: 'number', required: false, placeholder: '默认 30；0 = 每次重新登录', advanced: true },
  ],

  async fetch(client: NetClient, config: Record<string, unknown>): Promise<QuotaInfo> {
    const rawLogin = String(config.login_url || '').trim()
    const email = String(config.email || '')
    const password = String(config.password || '')
    if (!rawLogin || !email || !password) {
      throw new ProviderError('缺少主站地址、账号或密码。')
    }

    const cfgIsJson = String(config.login_method || 'form').trim().toLowerCase() === 'json'
    const cfgEmailField = String(config.email_field || 'email').trim() || 'email'
    const cfgPasswordField = String(config.password_field || 'password').trim() || 'password'

    // —— Token 缓存机制（_cached_token）：source=api 站登录鉴权 token 持久化到 config，
    //    刷新时若 token 未过期直接复用，跳过登录——避免每次刷新都重新登录
    //    （部分站点限制并发会话数 / 限流，如 api.maomaoai.pro 的 AUTH_SESSION_LIMIT）——
    const cachedToken = String((config._cached_token as string) || '').trim()
    const cachedTokenAt = num(config._cached_token_at) ?? 0
    const tokenTtlMs = (num(config.token_ttl_minutes) ?? 30) * 60_000
    const tokenFresh = cachedToken.length > 0 && Date.now() - cachedTokenAt < tokenTtlMs

    // —— 探测结果缓存（首次探测后存进 config，之后刷新直接复用，不再全量探测）——
    const cachedLogin = (config._detected_login ?? null) as
      | { url?: string; isJson?: boolean; emailField?: string; passwordField?: string }
      | null
    const cachedBalance = (config._detected_balance ?? null) as
      | { source?: string; url?: string }
      | null
    let detectedConfig: Record<string, unknown> | undefined

    // 解析登录接口：优先用缓存，否则探测（路径 × 字段名/方式组合）
    let login: LoginSpec
    let loginOrigin = ''
    let usedDirectLogin = false // login_url 填的是登录页地址（非接口）→ 登录失败时自动回退探测
    if (cachedLogin?.url) {
      login = {
        url: cachedLogin.url,
        isJson: cachedLogin.isJson ?? cfgIsJson,
        emailField: cachedLogin.emailField || cfgEmailField,
        passwordField: cachedLogin.passwordField || cfgPasswordField,
      }
    } else {
      // 仅当 rawLogin 不是合法 URL 才兜底当作登录接口直用；
      // probeLoginUrl 探测失败（ProviderError）必须抛出真实原因，
      // 不能 fallback 到根地址——否则会把 404 页面当登录响应，错误提示变成
      // 「登录响应是 JSON 但无余额字段」而非「未找到可用的登录接口」
      let origin = ''
      try {
        origin = new URL(rawLogin).origin
      } catch {
        origin = ''
      }
      if (origin) {
        loginOrigin = origin
        if (/\/login|\/signin|\/sign-in|\/auth\//i.test(rawLogin)) {
          // 填的是登录页地址（如 …/sign-in）：先直用；若 POST 响应不是成功登录
          // （SPA 页面返回 HTML），下方自动回退到 probeLoginUrl 探测真实登录接口
          login = { url: rawLogin, isJson: cfgIsJson, emailField: cfgEmailField, passwordField: cfgPasswordField }
          usedDirectLogin = true
        } else {
          login = await probeLoginUrl(client, origin, email, password, cfgIsJson, cfgEmailField, cfgPasswordField)
        }
        detectedConfig = { ...(detectedConfig ?? {}), _detected_login: login }
      } else {
        // 非 URL 输入（如域名简写）：原样当作登录接口直用
        login = { url: rawLogin, isJson: cfgIsJson, emailField: cfgEmailField, passwordField: cfgPasswordField }
        detectedConfig = { ...(detectedConfig ?? {}), _detected_login: login }
      }
    }
    const loginUrl = login.url

    // 余额页面地址：可留空，自动寻找（先试登录路径推断的控制台/用户页，再试常见路径）
    const pageUrlRaw = String(config.page_url || '').trim()
    const pageCandidates = pageUrlRaw ? [pageUrlRaw] : buildPageCandidates(loginUrl)

    // 0. Token 缓存快速通道：source=api 站且有新鲜缓存 token → 跳过登录直接查余额接口
    if (cachedBalance?.source === 'api' && cachedBalance.url && tokenFresh) {
      try {
        const resp = await client.request({
          method: 'GET',
          url: cachedBalance.url,
          headers: { Authorization: `Bearer ${cachedToken}` },
          timeoutMs: 20_000,
        })
        const found = resp.status >= 200 && resp.status < 300 ? extractFromLoginJson(resp.body) : []
        if (found.length > 0) {
          return buildInfo(found, `接口 ${cachedBalance.url}`, [], null, config, {
            ...(detectedConfig ?? {}),
            _cached_token: cachedToken,
            _cached_token_at: Date.now(),
          }, cachedToken, this.id)
        }
        if (resp.status === 401 || resp.status === 403) {
          // token 失效：清缓存，走下方正常登录流程重新获取
          detectedConfig = { ...(detectedConfig ?? {}), _cached_token: '', _cached_token_at: 0 }
        }
      } catch {
        // 网络异常：清缓存走正常登录流程（可能 token 或网络问题）
        detectedConfig = { ...(detectedConfig ?? {}), _cached_token: '', _cached_token_at: 0 }
      }
    }

    // 1. 登录（使用探测到的字段名/方式组合；cookie 由 Rust 侧保持）
    let loginResp = await client.request({
      method: 'POST',
      url: loginUrl,
      contentType: login.isJson ? 'application/json' : 'application/x-www-form-urlencoded',
      body: login.isJson
        ? JSON.stringify({ [login.emailField]: email, [login.passwordField]: password })
        : `${encodeURIComponent(login.emailField)}=${encodeURIComponent(email)}&${encodeURIComponent(login.passwordField)}=${encodeURIComponent(password)}`,
      timeoutMs: 30_000,
    })

    // 1.1 会话数达上限（409 AUTH_SESSION_LIMIT，如 api.maomaoai.pro）：先尝试登出旧会话
    //     （常见 logout 路径，带 cookie/Bearer；失败忽略），再重试登录一次；仍失败给明确提示
    const sessionLimited = loginResp.status === 409 || /AUTH_SESSION_LIMIT|SESSION_LIMIT/i.test(loginResp.body)
    if (sessionLimited) {
      await tryClearSessions(client, loginUrl, extractAuthToken(loginResp.body))
      loginResp = await client.request({
        method: 'POST',
        url: loginUrl,
        contentType: login.isJson ? 'application/json' : 'application/x-www-form-urlencoded',
        body: login.isJson
          ? JSON.stringify({ [login.emailField]: email, [login.passwordField]: password })
          : `${encodeURIComponent(login.emailField)}=${encodeURIComponent(email)}&${encodeURIComponent(login.passwordField)}=${encodeURIComponent(password)}`,
        timeoutMs: 30_000,
      })
      if (loginResp.status === 409 || /AUTH_SESSION_LIMIT/i.test(loginResp.body)) {
        throw new ProviderError(
          '站点会话数已达上限（AUTH_SESSION_LIMIT），自动登出清理仍失败。请登录站点网页控制台退出旧会话/设备后重试。',
        )
      }
    }

    // 1.2 自动修正：login_url 填的是登录页地址（/sign-in /login 等，SPA 页面 POST 返回 HTML）
    //     而非登录接口时，自动回退到标准登录接口探测（One-API/New-API 的
    //     /api/user/login json+username 等组合）。只针对「直用登录页地址」场景，
    //     不影响已探测成功/缓存命中的配置
    if (usedDirectLogin && !looksLikeLoginSuccess(loginResp) && loginOrigin) {
      try {
        const probed = await probeLoginUrl(
          client,
          loginOrigin,
          email,
          password,
          cfgIsJson,
          cfgEmailField,
          cfgPasswordField,
        )
        login = probed
        detectedConfig = { ...(detectedConfig ?? {}), _detected_login: login }
        loginResp = await client.request({
          method: 'POST',
          url: login.url,
          contentType: login.isJson ? 'application/json' : 'application/x-www-form-urlencoded',
          body: login.isJson
            ? JSON.stringify({ [login.emailField]: email, [login.passwordField]: password })
            : `${encodeURIComponent(login.emailField)}=${encodeURIComponent(email)}&${encodeURIComponent(login.passwordField)}=${encodeURIComponent(password)}`,
          timeoutMs: 30_000,
        })
      } catch {
        // 探测也失败：保留直用时的失败响应，走下方统一错误提示（「未能识别出余额」附登录响应说明）
      }
    }

    // 1.5 登录响应 JSON 里可能直接带余额（如 max66 的 paygo_balance）——最高优先级来源。
    // 注意：登录接口本身 4xx/5xx（密码错、路径错）不能作为余额来源（404 错误体里的数字是干扰）
    const loginCandidates = loginResp.status >= 200 && loginResp.status < 300 ? extractFromLoginJson(loginResp.body) : []
    // 1.6 捕获登录响应里的鉴权 token（access_token / token / api_key）：
    //     One-API / New-API 系的余额接口 /api/user/self 需要 Bearer token 鉴权
    const authToken = extractAuthToken(loginResp.body)

    const kwInput = String(config.keywords || '')
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const keywords = kwInput.length > 0 ? kwInput : DEFAULT_KEYWORDS

    // 2. 余额获取：有缓存按缓存来源（登录响应/余额API/页面）直接取；缓存失效或无缓存时全量探测
    let candidates: ScoredCandidate[] = []
    let usedPage = ''
    let lastPageHints: string[] = []

    if (cachedBalance?.source) {
      if (cachedBalance.source === 'login') {
        candidates = loginCandidates
        usedPage = '登录响应'
      } else if (cachedBalance.source === 'api' && cachedBalance.url) {
        try {
          const resp = await client.request({
            method: 'GET',
            url: cachedBalance.url,
            headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
            timeoutMs: 20_000,
          })
          // 非 2xx（如 404/401）：来源失效，不提取（错误体数字是干扰）
          candidates = resp.status >= 200 && resp.status < 300 ? extractFromLoginJson(resp.body) : []
          usedPage = `接口 ${cachedBalance.url}`
        } catch {
          candidates = []
        }
      } else if (cachedBalance.source === 'page' && cachedBalance.url) {
        try {
          const resp = await client.request({ method: 'GET', url: cachedBalance.url, timeoutMs: 30_000 })
          // 非 2xx：来源失效，不提取（404 页面数字可能是干扰）
          candidates = resp.status >= 200 && resp.status < 300 ? findCandidates(resp.body, keywords) : []
          usedPage = cachedBalance.url
        } catch {
          candidates = []
        }
      }
      if (candidates.length === 0) {
        // 缓存来源失效（站点改版/过期）→ 回退全量探测并刷新缓存
        cachedBalance.source = ''
      }
    }

    if (!candidates.length) {
      // 全量探测：登录响应 → 余额 API → 页面
      if (loginCandidates.length > 0) {
        candidates = loginCandidates
        usedPage = '登录响应'
        detectedConfig = {
          ...(detectedConfig ?? {}),
          _detected_balance: { source: 'login' },
        }
      } else {
        let apiOrigin = ''
        try {
          apiOrigin = new URL(loginUrl).origin
        } catch {
          /* 忽略 */
        }
        let apiUsed = ''
        if (apiOrigin) {
          const apiPaths = [
            '/api/wallet/summary',
            '/api/user/profile',
            '/api/user/balance',
            '/api/v1/user/profile',
            '/api/user/info',
            '/api/account/balance',
            '/api/user/wallet',
            '/api/wallet',
            '/api/balance',
            '/api/me',
            '/api/user/self', // One-API / New-API 系：需 Bearer token（登录响应已捕获）
          ]
          for (const p of apiPaths) {
            try {
              const resp = await client.request({
                method: 'GET',
                url: `${apiOrigin}${p}`,
                headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
                timeoutMs: 20_000,
              })
              // 非 2xx：接口不存在/未授权，跳过（404 错误体数字是干扰）
              if (resp.status < 200 || resp.status >= 300) continue
              const found = extractFromLoginJson(resp.body)
              if (found.length > 0) {
                candidates = found
                apiUsed = `${apiOrigin}${p}`
                break
              }
            } catch {
              // 该接口不可用，继续下一个
            }
          }
        }
        if (apiUsed) {
          usedPage = `接口 ${apiUsed}`
          detectedConfig = {
            ...(detectedConfig ?? {}),
            _detected_balance: { source: 'api', url: apiUsed },
          }
        } else {
          for (const p of pageCandidates) {
            try {
              const resp = await client.request({ method: 'GET', url: p, timeoutMs: 30_000 })
              // 非 2xx：404/403 页面不提取余额（错误页数字是干扰）
              const found = resp.status >= 200 && resp.status < 300 ? findCandidates(resp.body, keywords) : []
              lastPageHints.push(`${p} → ${extractPageHint(resp.body)}`)
              if (found.length > 0) {
                candidates = found
                usedPage = p
                break
              }
            } catch {
              lastPageHints.push(`${p} → 请求失败`)
            }
          }
          if (usedPage) {
            detectedConfig = {
              ...(detectedConfig ?? {}),
              _detected_balance: { source: 'page', url: usedPage },
            }
          }
        }
      }
    }

    if (candidates.length === 0) {
      const loginHint = /^\s*[{\[]/.test(loginResp.body)
        ? '登录响应是 JSON 但无余额字段'
        : '登录响应不是 JSON（登录接口地址可能填错，应为登录提交接口而非网站首页）'
      throw new ProviderError(
        `未能识别出余额：${loginHint}。已尝试 ${pageCandidates.length} 个页面：${lastPageHints
          .slice(-3)
          .join('；')}。请确认「登录接口地址」正确，或展开「高级设置」手动填写「余额页面地址」。`,
      )
    }

    return buildInfo(candidates, usedPage, lastPageHints, loginResp, config, detectedConfig, authToken, this.id)
  },
}

/** 登录方式规格：接口地址 + 提交方式 + 字段名 */
interface LoginSpec {
  url: string
  isJson: boolean
  emailField: string
  passwordField: string
}

/** 自动探测登录接口：常见路径 × 字段名/方式组合，POST 后判定成功特征 */
async function probeLoginUrl(
  client: NetClient,
  origin: string,
  email: string,
  password: string,
  cfgIsJson: boolean,
  cfgEmailField: string,
  cfgPasswordField: string,
): Promise<LoginSpec> {
  // Sub2API 框架部署（muteki/purefox/lvzhouai/poke2api 等同源）的标准登录路径排在前面，
  // JSON {email, password} 提交；其余为常见登录路径
  const paths = [
    '/api/v1/auth/login',
    '/user/login',
    '/login',
    '/api/login',
    '/api/auth/login',
    '/signin',
    '/user/signin',
    '/auth/login',
    '/api/user/login',
  ]
  // 组合：用户配置优先，其次常见备选（json+email、json+account、json+username、form+account、form+email）
  // json+email 提前：Sub2API 标准字段就是 email/password，优先命中可显著减少探测请求数；
  // json+username：One-API / New-API 系用 username 字段登录（无独立适配器，统一由本适配器接管）
  const combos: Array<Omit<LoginSpec, 'url'>> = [
    { isJson: cfgIsJson, emailField: cfgEmailField, passwordField: cfgPasswordField },
    { isJson: true, emailField: 'email', passwordField: 'password' },
    { isJson: true, emailField: 'account', passwordField: 'password' },
    { isJson: true, emailField: 'username', passwordField: 'password' },
    { isJson: false, emailField: 'account', passwordField: 'password' },
    { isJson: false, emailField: 'email', passwordField: 'password' },
  ]
  const seen = new Set<string>()
  const uniqCombos = combos.filter((c) => {
    const k = `${c.isJson}|${c.emailField}|${c.passwordField}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  for (const combo of uniqCombos) {
    for (const p of paths) {
      const url = `${origin}${p}`
      try {
        const body = combo.isJson
          ? JSON.stringify({ [combo.emailField]: email, [combo.passwordField]: password })
          : `${encodeURIComponent(combo.emailField)}=${encodeURIComponent(email)}&${encodeURIComponent(combo.passwordField)}=${encodeURIComponent(password)}`
        const resp = await client.request({
          method: 'POST',
          url,
          contentType: combo.isJson ? 'application/json' : 'application/x-www-form-urlencoded',
          body,
          timeoutMs: 15_000,
        })
        if (looksLikeLoginSuccess(resp)) {
          return { url, ...combo }
        }
      } catch {
        // 该组合/路径不可用，继续下一个
      }
    }
  }
  throw new ProviderError('未找到可用的登录接口。请展开「高级设置」手动填写「登录接口地址」。')
}

/** 判定登录响应是否为「成功」：JSON 且含 ok/code=0/success 或 token/api_key 等鉴权字段 */
function looksLikeLoginSuccess(resp: NetResponse): boolean {
  if (resp.status >= 400) return false
  const body = resp.body.trim()
  if (!body.startsWith('{') && !body.startsWith('[')) return false
  try {
    const data = JSON.parse(body)
    if (data && typeof data === 'object') {
      if (data.ok === true || data.success === true || data.code === 0 || String(data.code) === '0') {
        return true
      }
      let foundToken = false
      const walk = (obj: unknown) => {
        if (foundToken || typeof obj !== 'object' || obj === null) return
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const key = k.toLowerCase()
          if ((key.includes('token') || key.includes('api_key') || key.includes('session')) && v) {
            foundToken = true
            return
          }
          if (typeof v === 'object') walk(v)
        }
      }
      walk(data)
      return foundToken
    }
  } catch {
    return false
  }
  return false
}

/** 来源路径缩短：URL/路径只保留最后两级（/api/wallet/summary → wallet.summary） */
function shortSource(src: string): string {
  if (src === '登录响应') return src
  let path = src
  try {
    path = new URL(src).pathname
  } catch {
    // 已是路径字符串
  }
  const parts = path
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .slice(-2)
  return parts.length > 0 ? parts.join('.') : src
}

/** 页面特征摘要（title 或开头文本），用于错误诊断 */
function extractPageHint(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html)
  if (m && m[1].trim()) return `「${m[1].trim().slice(0, 40)}」`
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return `「${plain.slice(0, 60)}」`
}

/** 登录响应/JSON 接口里的余额字段提取，按 key 语义分类到计费方案（paygo/duration/times/plan）。
 *  不同方案的字段名不同（真实站点例：max66 的 paygo_balance=按量 + remaining_calls=按次；
 *  lvzhouai/poke2api 的 balance=按量；MiniMax 的 token_plan=套餐），据此自动识别多种计费方式 */
/** 从登录响应 JSON 中提取鉴权 token（access_token / token / api_key / *_token 的字符串值） */
function extractAuthToken(body: string): string {
  const trimmed = body.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return ''
  try {
    const data = JSON.parse(body)
    let found = ''
    const walk = (obj: unknown) => {
      if (found || typeof obj !== 'object' || obj === null) return
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const key = k.toLowerCase()
        if (
          (key === 'access_token' || key === 'token' || key === 'api_key' || key === 'session' || key.endsWith('_token')) &&
          typeof v === 'string' &&
          v.length > 8 &&
          !v.includes(' ')
        ) {
          found = v
          return
        }
        if (typeof v === 'object') walk(v)
      }
    }
    walk(data)
    return found
  } catch {
    return ''
  }
}

function extractFromLoginJson(body: string): ScoredCandidate[] {
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return []
  }
  const out: ScoredCandidate[] = []
  const walk = (obj: unknown) => {
    if (typeof obj !== 'object' || obj === null) return
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = k.toLowerCase()
      const numeric =
        typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      // 方案分类（按 key 语义，优先级：套餐 > 包时 > 按次 > 按量）
      let plan = ''
      if (
        key.includes('token_plan') || key.includes('plan_credit') || key.includes('subscription') ||
        key.includes('套餐') || key.includes('订阅')
      ) {
        plan = 'plan'
      } else if (
        // 包时：套餐/订阅的有效期。排除 token/会话过期字段（expires_in/expire_at/exp/token_expire 等是登录态有效期，非套餐）
        (key.includes('duration') || key.includes('valid_days') || key.includes('valid_until') ||
         key.includes('包时') || key.includes('到期') || key.includes('剩余天')) &&
        !/expires?(_in|_at|_time|_date)?$/.test(key) &&
        !key.startsWith('exp') &&
        !key.includes('token_expire')
      ) {
        plan = 'duration'
      } else if (
        key.includes('remaining_calls') || key.includes('total_calls') || key.includes('times') ||
        key.includes('call_count') || key.includes('次数') || key.includes('剩余次') || key.includes('调用次数')
      ) {
        plan = 'times'
      } else if (
        key.includes('paygo') || key.includes('balance') || key.includes('credits') ||
        key.includes('quota') || key.includes('amount') || key.includes('money') ||
        key.includes('余额') || key.includes('可用')
      ) {
        plan = 'paygo'
      }
      if (plan && Number.isFinite(numeric)) {
        let currency = ''
        if (key.includes('cny') || key.includes('rmb') || key.includes('yuan')) currency = 'CNY'
        else if (key.includes('usd') || key.includes('dollar')) currency = 'USD'
        // duration 方案统一单位为「秒」：valid_days/剩余天 类字段是「天」→ ×86400；
        // 其余 duration 字段（duration 等）按秒解释
        let val = numeric
        // One-API / New-API 系：精确 quota 字段是内部额度（500000 = 1 美元），换算为美元余额。
        // 仅精确 key === 'quota'（used_quota / aff_quota 等派生字段不换算，语义不同）。
        // 换算必须早于 isPlausible 检查：内部额度原始值（如 250000）是长整数，
        // 会被 isPlausible 当作「id/次数」过滤，换算后的 0.5 才是合理余额值
        if (key === 'quota' && plan === 'paygo') {
          val = numeric / 500000
          if (!currency) currency = 'USD'
        }
        if (plan === 'duration' && (key.includes('valid_days') || key.includes('剩余天'))) {
          val = numeric * 86400
        }
        if (isPlausible(val)) {
          out.push({ value: val, currency, context: `登录响应字段 ${k}`, score: 9, plan })
        }
      }
      if (typeof v === 'object') walk(v)
    }
  }
  walk(data)
  return out
}

/** 余额页面候选：控制台类优先 → 账户类其次 → 首页兜底 */
function buildPageCandidates(loginUrl: string): string[] {
  const out: string[] = []
  try {
    const u = new URL(loginUrl)
    const origin = u.origin
    // 1. 从登录路径推断 base（如 /user/login → /user），控制台子页优先
    let base = u.pathname.replace(/\/+$/, '')
    base = base.replace(/\/login(\/.*)?$/i, '')
    if (base && base !== '/') {
      for (const sub of ['/dashboard', '/panel', '/console', '', '/account', '/account/account']) {
        out.push(`${origin}${base}${sub}`)
      }
    }
    // 2. 常见控制台路径
    for (const p of ['/dashboard', '/console', '/panel', '/admin']) {
      if (!out.includes(`${origin}${p}`)) out.push(`${origin}${p}`)
    }
    // 3. 账户类路径（控制台无果后的第二优先级）
    for (const p of ['/account', '/user', '/account/account', '/account/profile', '/user/account', '/user/profile']) {
      if (!out.includes(`${origin}${p}`)) out.push(`${origin}${p}`)
    }
    // 4. 首页兜底（最后）
    out.push(`${origin}/`)
  } catch {
    out.push(loginUrl)
  }
  // 去重，最多 10 个
  return Array.from(new Set(out)).slice(0, 10)
}

// —— 启发式识别：关键词语境 / 货币符号 / 小数形态，按得分排序 ——
function findCandidates(html: string, keywords: string[]): ScoredCandidate[] {
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')

  const scored: ScoredCandidate[] = []

  // 策略 1：关键词附近 ±N 字符内的数字（得分最高）
  for (const kw of keywords) {
    let idx = -1
    let searchFrom = 0
    while ((idx = plain.toLowerCase().indexOf(kw.toLowerCase(), searchFrom)) !== -1) {
      const ctx = plain.slice(Math.max(0, idx - 40), idx + 140)
      for (const n of extractNumbers(ctx)) {
        if (!isPlausible(n.value)) continue
        scored.push({ ...n, context: summarizeContext(ctx, n.value), score: n.currency ? 6 : 4 })
      }
      searchFrom = idx + kw.length
      if (searchFrom > plain.length) break
    }
  }

  // 策略 2：货币符号 + 数字（全页）
  const moneyRe = /([¥$€£])\s*([0-9][0-9,]*\.?[0-9]*)/g
  let m: RegExpExecArray | null
  while ((m = moneyRe.exec(plain)) !== null) {
    const v = parseFloat(m[2].replace(/,/g, ''))
    if (!isPlausible(v)) continue
    const ctx = plain.slice(Math.max(0, m.index - 40), m.index + 60)
    scored.push({
      value: v,
      currency: m[1] === '¥' ? 'CNY' : m[1] === '$' ? 'USD' : 'CNY',
      context: summarizeContext(ctx, v, m[0]),
      score: 5,
    })
  }

  // 策略 3：形如 123.45 的带小数数字（全页，得分最低）
  const numRe = /\b([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,4})?|[0-9]+\.[0-9]{1,4})\b/g
  while ((m = numRe.exec(plain)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''))
    if (!isPlausible(v)) continue
    // 排除紧跟 % 的百分比
    const after = plain.slice(m.index + m[0].length, m.index + m[0].length + 3)
    if (after.trimStart().startsWith('%')) continue
    const ctx = plain.slice(Math.max(0, m.index - 40), m.index + 60)
    scored.push({ value: v, currency: '', context: summarizeContext(ctx, v, m[0]), score: 1 })
  }

  // 去重（同值不同币种/上下文保留，但去完全重复）+ 排序
  const seen = new Set<string>()
  const uniq = scored.filter((r) => {
    const k = `${r.currency}|${r.value}|${r.context}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  uniq.sort((a, b) => b.score - a.score || Math.abs(b.value - a.value))
  return uniq.slice(0, 8)
}

/** 数字合理性过滤：排除年份、超大 id、明显干扰 */
function isPlausible(v: number): boolean {
  if (!Number.isFinite(v) || v >= 1_000_000_000) return false
  if (v > 1900 && v < 2100 && Number.isInteger(v)) return false // 年份
  if (Number.isInteger(v) && v > 100000) return false // 长整数 id/次数
  return true
}

/** 候选上下文：数字周围文本摘要（供用户判断/匹配） */
function summarizeContext(ctx: string, value: number, token?: string): string {
  const cleaned = ctx.replace(/\s+/g, ' ').trim()
  // 定位数字 token 在上下文里的位置
  let pos = -1
  if (token) {
    pos = cleaned.indexOf(token)
  } else {
    const re = new RegExp(String(value).replace(/\./, '\\.'))
    const m = re.exec(cleaned)
    pos = m ? m.index : -1
  }
  if (pos === -1) return cleaned.slice(0, 60)
  const start = Math.max(0, pos - 12)
  return cleaned.slice(start, pos + 18).trim() || cleaned.slice(0, 60)
}

function extractNumbers(ctx: string): { value: number; currency: string }[] {
  const out: { value: number; currency: string }[] = []
  const re = /([¥$€£])?\s*([0-9][0-9,]*\.?[0-9]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(ctx)) !== null) {
    const v = parseFloat(m[2].replace(/,/g, ''))
    if (Number.isFinite(v) && v < 1_000_000_000) {
      out.push({
        value: v,
        currency: m[1] ? (m[1] === '¥' ? 'CNY' : m[1] === '$' ? 'USD' : 'CNY') : '',
      })
    }
  }
  return out
}

/** 上下文匹配：归一化后互相包含（页面数值变化但标签文字稳定的情况） */
function contextMatches(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, '')
  const nb = b.replace(/\s+/g, '')
  if (!na || !nb) return false
  if (na.length >= 6 && nb.length >= 6) return na.includes(nb) || nb.includes(na)
  return na === nb
}

/**
 * 由候选列表组装最终结果：主余额选择（用户确认优先 → paygo 组 → 首候选）+
 * 多方案分组 + USD→CNY 换算 + 登录 token 缓存写入（_cached_token/_cached_token_at）。
 * fetch 的 token 快速通道与正常登录流程共用。
 */
function buildInfo(
  candidates: ScoredCandidate[],
  usedPage: string,
  lastPageHints: string[],
  loginResp: NetResponse | null,
  config: Record<string, unknown>,
  detectedConfig: Record<string, unknown> | undefined,
  authToken: string,
  providerId: string,
): QuotaInfo {
  if (candidates.length === 0) {
    const loginHint =
      loginResp && /^\s*[{\[]/.test(loginResp.body)
        ? '登录响应是 JSON 但无余额字段'
        : '登录响应不是 JSON（登录接口地址可能填错，应为登录提交接口而非网站首页）'
    throw new ProviderError(
      `未能识别出余额：${loginHint}。已尝试 ${lastPageHints.length} 个页面：${lastPageHints
        .slice(-3)
        .join('；')}。请确认「登录接口地址」正确，或展开「高级设置」手动填写「余额页面地址」。`,
    )
  }

  // 4. 主余额选择：用户确认过的候选（context 特征）优先；否则取「按量余额」组（paygo）的候选，
  //    保持主余额语义稳定（多方案站点其余方案走 plans 分组展示）。
  //    paygo 组内优先非零候选：登录响应常同时带 quota（真实余额）与 aff_quota/used_quota 等
  //    派生零值字段，JS 键序（整数键在前）可能导致 0 值被选为主余额 → 优先 c.value > 0 的真实余额
  const choice = (config.balance_choice ?? {}) as BalanceChoice
  const choiceCtx = choice.context
  const paygoCandidates = candidates.filter((c) => (c.plan ?? 'paygo') === 'paygo')
  let chosen = paygoCandidates.find((c) => c.value > 0) ?? paygoCandidates[0] ?? candidates[0]
  let confirmed = false
  if (choiceCtx) {
    const matched = candidates.find((c) => contextMatches(c.context, choiceCtx))
    if (matched) {
      chosen = matched
      confirmed = true
    }
  }

  // 4.5 USD→CNY 换算（默认 1:1，即数值不变只换币种）：识别到美元余额时按比例转为人民币显示。
  //     比例由高级设置 usd_cny_rate 指定（1 美元 = N 元），默认 1
  const usdCnyRate = num(config.usd_cny_rate) ?? 1
  const toDisplay = (value: number, currency: string): { value: number; currency: string } => {
    if (currency === 'USD' && usdCnyRate > 0) {
      return { value: value * usdCnyRate, currency: 'CNY' }
    }
    return { value, currency: currency || 'CNY' }
  }
  const main = toDisplay(chosen.value, chosen.currency || 'CNY')

  // 5. 多方案：按候选的 plan 标注分组（如登录响应同时带 paygo_balance 和 duration 剩余），
  //    各方案取该组最优候选；供 worker 自动勾选 billingPlans 并在主卡/弹窗分方案展示。
  //    仅当至少一个候选带明确 plan 标注（JSON key 分类）时才产出——
  //    纯 HTML 页面识别的候选无 plan 标注，不做自动勾选（避免干扰用户勾选）
  const plansByType: Record<string, ScoredCandidate> = {}
  let hasExplicitPlan = false
  for (const c of candidates) {
    // 值为 0 的字段视为「未开通 / 无额度 / 无时间」：不参与方案分组与自动勾选
    if (!c.plan || c.value <= 0) continue
    hasExplicitPlan = true
    // 每组取 score 最高（同分取第一个）
    if (!plansByType[c.plan] || c.score > plansByType[c.plan].score) plansByType[c.plan] = c
  }
  const detectedPlans: Record<string, QuotaInfo> = {}
  if (hasExplicitPlan) {
    // 主方案（chosen 所属方案）排最前：worker 的主方案回退取 merged[0] 即主余额方案
    const mainPlan = chosen.plan || 'paygo'
    const ordered = [mainPlan, ...Object.keys(plansByType).filter((p) => p !== mainPlan)]
    for (const p of ordered) {
      const c = plansByType[p]
      const cv = toDisplay(c.value, c.currency || 'CNY')
      detectedPlans[p] = {
        ok: true,
        providerId,
        displayName: '',
        message: '',
        total: null,
        remaining: cv.value,
        currency: cv.currency,
        extra: '',
      }
    }
  }

  // 登录 token 缓存：登录响应里的鉴权 token 持久化，source=api 站下次刷新复用（跳过登录）
  let dc = detectedConfig
  if (authToken) {
    dc = { ...(dc ?? {}), _cached_token: authToken, _cached_token_at: Date.now() }
  }

  const info: QuotaInfo = {
    ok: true,
    providerId,
    displayName: '',
    message: confirmed
      ? '已按你确认的数值识别'
      : usedPage
        ? `自动识别（来源 ${shortSource(usedPage)}）`
        : '自动识别',
    total: null,
    remaining: main.value,
    currency: main.currency,
    extra: '',
    candidates: candidates.map((c) => ({
      value: c.value,
      currency: c.currency,
      context: c.context,
    })),
    // 多方案数据（识别出的计费方式，单方案也返回以便 worker 修正 billingPlans）：
    // worker 据此重写 billingPlans 并自动勾选
    plans: Object.keys(detectedPlans).length > 0 ? detectedPlans : undefined,
    detectedConfig: dc,
  }
  return info
}

/**
 * 会话数达上限（409 AUTH_SESSION_LIMIT）时尝试清理旧会话：
 * 依次 POST/GET 常见 logout 路径（带 cookie 由 Rust 侧保持；有 token 时附 Bearer），
 * 全部失败也无妨（调用方会给出明确提示）。
 */
async function tryClearSessions(
  client: NetClient,
  loginUrl: string,
  authToken: string,
): Promise<void> {
  let origin = ''
  try {
    origin = new URL(loginUrl).origin
  } catch {
    return
  }
  const paths = ['/api/user/logout', '/user/logout', '/api/logout', '/logout', '/api/auth/logout', '/signout']
  for (const p of paths) {
    try {
      await client.request({
        method: 'POST',
        url: `${origin}${p}`,
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
        timeoutMs: 8000,
      })
    } catch {
      /* 该路径不可用，继续下一个 */
    }
  }
}

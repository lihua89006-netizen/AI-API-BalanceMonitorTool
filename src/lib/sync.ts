// 跨设备手动同步：配置导出/导入的纯逻辑（剪贴板方案 A）
// 导出含明文 API Key —— 界面必须显著警示

import type { AppConfig, ProviderEntry } from './store'
import { encryptPayload } from './crypto'

export const SYNC_SCHEMA_VERSION = 1

export interface SyncPayload {
  schemaVersion: number
  exportedAt: string
  providers: ProviderEntry[]
}

/** 生成导出文本（含全部站点配置与凭据） */
export function buildExportPayload(cfg: AppConfig): string {
  const payload: SyncPayload = {
    schemaVersion: SYNC_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    providers: cfg.providers,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * 精简导出（二维码专用）：紧凑 JSON + 短字段名 + 剔除可重建冗余字段——
 * - `_` 开头的内部探测缓存（_detected_login / _detected_balance 等）：导入后自动重新探测
 * - `balance_choice` 用户余额校准：导入后重新识别候选即可
 * 字段名缩短（uid→u、providerId→pid、displayName→n、enabled→e、autoRefreshMinutes→m、
 * config 常用键 api_key→ak 等）可再省 50%+ 体积，让二维码保持低版本低密度、手机稳定识别。
 */
const COMPACT_SCHEMA_VERSION = 2

/** 标准 config 键 → 紧凑键 */
const CFG_KEY_MAP: Record<string, string> = {
  api_key: 'ak',
  base_url: 'bu',
  email: 'em',
  password: 'pw',
  login_url: 'lu',
  page_url: 'pu',
  login_method: 'lm',
  email_field: 'ef',
  password_field: 'pf',
  keywords: 'kw',
  proxy: 'px',
  display_currency: 'dc',
}
const CFG_KEY_UNMAP: Record<string, string> = Object.fromEntries(
  Object.entries(CFG_KEY_MAP).map(([k, v]) => [v, k]),
)

export function buildCompactPayload(cfg: AppConfig): string {
  const providers = cfg.providers.map((p) => {
    const c: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p.config || {})) {
      if (k.startsWith('_')) continue
      if (k === 'balance_choice') continue
      c[CFG_KEY_MAP[k] ?? k] = v
    }
    return {
      u: p.uid,
      pid: p.providerId,
      n: p.displayName,
      e: p.enabled,
      m: p.autoRefreshMinutes,
      c,
    }
  })
  return JSON.stringify({ z: COMPACT_SCHEMA_VERSION, p: providers })
}

// ===== 二维码压缩（deflate 二进制 + base64url 文本）=====
// 二维码容量有限（版本越高模块越密越难识别）。先把紧凑 JSON 用 deflate 压缩，
// 体积通常可再省 50%+，让二维码保持低版本、模块大、手机稳定识别。
// 生成侧优先用二进制 byte 模式（QR_BIN_PREFIX 魔数 + deflate 字节，无 base64 膨胀），
// 解析侧优先取 jsQR 的 binaryData；加密/剪贴板路径仍走 Z1:base64url 文本。
const QR_COMPRESS_PREFIX = 'Z1:'
/** 二进制前缀魔数（ASCII "Z1"），标记 deflate 原始字节 */
const QR_BIN_PREFIX = new Uint8Array([0x5a, 0x31])

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 压缩文本（二维码专用）：deflate → base64url，带 Z1: 前缀便于识别 */
export async function compressText(text: string): Promise<string> {
  return QR_COMPRESS_PREFIX + bytesToB64Url(await compressBytes(text))
}

/** 解压 Z1: 前缀文本；无前缀原样返回 */
export async function decompressText(text: string): Promise<string> {
  const t = text.trim()
  if (!t.startsWith(QR_COMPRESS_PREFIX)) return t
  return decompressBytes(b64UrlToBytes(t.slice(QR_COMPRESS_PREFIX.length)))
}

/** deflate 原始字节（带魔数前缀），供 QR byte 模式直接编码 */
export async function compressBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  const buf = await new Response(stream).arrayBuffer()
  const out = new Uint8Array(QR_BIN_PREFIX.length + buf.byteLength)
  out.set(QR_BIN_PREFIX, 0)
  out.set(new Uint8Array(buf), QR_BIN_PREFIX.length)
  return out
}

/** 解压带魔数前缀的 deflate 字节；无魔数按 UTF-8 文本返回 */
export async function decompressBytes(bytes: Uint8Array): Promise<string> {
  const hasMagic =
    bytes.length >= QR_BIN_PREFIX.length &&
    bytes[0] === QR_BIN_PREFIX[0] &&
    bytes[1] === QR_BIN_PREFIX[1]
  if (!hasMagic) return new TextDecoder().decode(bytes)
  const stream = new Blob([bytes.slice(QR_BIN_PREFIX.length)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Response(stream).text()
}

/** 二维码专用 payload：紧凑 JSON → deflate 压缩 → 二进制（QR byte 模式直接编码） */
export async function buildQRPayload(cfg: AppConfig): Promise<Uint8Array> {
  return compressBytes(buildCompactPayload(cfg))
}

/**
 * 剪贴板导出文本（2026-08 优化）：紧凑 JSON → deflate 压缩 → Z1:base64url 文本。
 * 比旧版标准 JSON 全文缩短约 70%（几个站点从 3000+ 字符降到 ~500 字符，聊天软件发得出去）；
 * 导入侧 parseAnyImportPayload 自动识别 Z1: 前缀解压，兼容性不变。
 */
export async function buildClipboardPayload(cfg: AppConfig): Promise<string> {
  return compressText(buildCompactPayload(cfg))
}

/**
 * 「导出配置文件」最终产物（2026-09/16 新增）：决定"复制到剪贴板的到底是明文还是密文"。
 * 口径集中在此处，界面只负责显示结果 —— 便于单测覆盖，避免"开关开了却复制出明文"这类静默降级。
 * - encrypt=false → `Z1:` 明文压缩文本（含明文 API Key，界面必须警示）
 * - encrypt=true  → `AQM2:` 密文（先压缩再加密；迭代次数写在密文头，见 crypto.ts）
 * ⚠️ encrypt=true 而口令为空/纯空白 → **抛错，绝不回退成明文**。
 */
export async function buildExportText(
  cfg: AppConfig,
  opts: { encrypt: boolean; password: string },
): Promise<string> {
  const compact = await buildClipboardPayload(cfg)
  if (!opts.encrypt) return compact
  const password = opts.password.trim()
  if (!password) throw new Error('口令不能为空')
  return encryptPayload(compact, password)
}

/**
 * 「导出配置文件」的**文件内容**（2026-09/16 改版：导出物是一个 .json 文件，见 `export_config_file`）。
 * 与 `buildExportText`（剪贴板/二维码用的压缩文本）分开，因为文件不受长度限制、且叫 .json 就该真是 JSON：
 * - encrypt=false → **标准 JSON**（`schemaVersion=1`，人类可读、可手动改；导入端本来就能解析）
 * - encrypt=true  → `AQM2:` 密文（内容是上面那份标准 JSON 的密文）
 * ⚠️ encrypt=true 而口令为空/纯空白 → **抛错，绝不静默回退成明文**。
 */
export async function buildExportFileText(
  cfg: AppConfig,
  opts: { encrypt: boolean; password: string },
): Promise<string> {
  const json = buildExportPayload(cfg)
  if (!opts.encrypt) return json
  const password = opts.password.trim()
  if (!password) throw new Error('口令不能为空')
  return encryptPayload(json, password)
}

/**
 * 导出文件名（本机时区）：`API余额通-配置_260916.1200.json`，与打包产物的 `yyMMdd.HHmm` 同风格。
 * ⚠️ 只是"建议名"，Rust 侧会再清洗一遍（防目录穿越 / 保留字符），不以这里的输出为安全边界。
 */
export function exportFileName(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  return `API余额通-配置_${yy}${p(d.getMonth() + 1)}${p(d.getDate())}.${p(d.getHours())}${p(d.getMinutes())}.json`
}

/** 解析任意格式导入文本（标准 / 紧凑二维码 / 压缩二维码），紧凑格式归一化后走标准校验 */
export async function parseAnyImportPayload(text: string): Promise<ImportResult> {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    // 可能为 deflate 压缩的二维码文本（Z1: 前缀），尝试解压后再解析
    if (text.trim().startsWith(QR_COMPRESS_PREFIX)) {
      try {
        const plain = await decompressText(text)
        data = JSON.parse(plain)
      } catch {
        return { ok: false, message: '不是有效的 JSON 文本', entries: [] }
      }
    } else {
      return { ok: false, message: '不是有效的 JSON 文本', entries: [] }
    }
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, message: '格式不正确：顶层应为对象', entries: [] }
  }
  const d = data as Record<string, unknown>
  if (d.z === COMPACT_SCHEMA_VERSION && Array.isArray(d.p)) {
    const providers = (d.p as unknown[]).map((item) => {
      const q = item as Record<string, unknown>
      const config: Record<string, unknown> = {}
      const rawCfg = q.c
      if (typeof rawCfg === 'object' && rawCfg !== null) {
        for (const [k, v] of Object.entries(rawCfg as Record<string, unknown>)) {
          config[CFG_KEY_UNMAP[k] ?? k] = v
        }
      }
      return {
        uid: String(q.u ?? ''),
        providerId: String(q.pid ?? ''),
        displayName: String(q.n ?? ''),
        enabled: q.e !== false,
        autoRefreshMinutes: Number(q.m) || 0,
        config,
      }
    })
    const normalized = JSON.stringify({
      schemaVersion: SYNC_SCHEMA_VERSION,
      exportedAt: '',
      providers,
    })
    return parseImportPayload(normalized)
  }
  return parseImportPayload(text)
}

export interface ImportResult {
  ok: boolean
  message: string
  entries: ProviderEntry[]
}

/** 校验导入文本，逐条过滤无效站点 */
export function parseImportPayload(text: string): ImportResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, message: '不是有效的 JSON 文本', entries: [] }
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, message: '格式不正确：顶层应为对象', entries: [] }
  }
  const d = data as Record<string, unknown>
  if (d.schemaVersion !== SYNC_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `不支持的版本（schemaVersion=${String(d.schemaVersion)}），请更新应用后重试`,
      entries: [],
    }
  }
  if (!Array.isArray(d.providers)) {
    return { ok: false, message: '格式不正确：缺少 providers 数组', entries: [] }
  }
  const entries: ProviderEntry[] = []
  let skipped = 0
  for (const item of d.providers) {
    if (typeof item !== 'object' || item === null) {
      skipped++
      continue
    }
    const p = item as Record<string, unknown>
    const uid = String(p.uid ?? '').trim()
    const providerId = String(p.providerId ?? '').trim()
    const displayName = String(p.displayName ?? '').trim()
    if (!uid || !providerId || !displayName) {
      skipped++
      continue
    }
    entries.push({
      uid,
      providerId,
      displayName,
      enabled: p.enabled !== false,
      autoRefreshMinutes: Number(p.autoRefreshMinutes) || 0,
      config:
        typeof p.config === 'object' && p.config !== null
          ? (p.config as Record<string, unknown>)
          : {},
    })
  }
  if (entries.length === 0) {
    return { ok: false, message: '没有有效的站点数据', entries: [] }
  }
  return {
    ok: true,
    message: `解析成功：${entries.length} 个站点${skipped > 0 ? `，${skipped} 个无效已跳过` : ''}`,
    entries,
  }
}

/** 合并：同 uid 覆盖（导入优先），新 uid 追加 */
export function mergeProviders(
  existing: ProviderEntry[],
  incoming: ProviderEntry[],
): ProviderEntry[] {
  const map = new Map<string, ProviderEntry>()
  for (const e of existing) map.set(e.uid, e)
  for (const e of incoming) map.set(e.uid, e)
  return [...map.values()]
}

// 配置导出加密：口令派生密钥（PBKDF2） + AES-GCM 加密
//
// 导出格式（2026-09/16 起）：
//   AQM2:<base64( ver(1) | iter(4, 大端) | salt(16) | iv(12) | ciphertext )>
//   —— **KDF 参数写进密文自身**：日后调整迭代次数（或算法）不会让旧文件/旧剪贴板打不开。
//      旧格式把迭代次数硬编码在代码里，一旦调整就永久解不开历史导出物，故升版。
//
// 旧格式 AQM1:<base64( salt(16) | iv(12) | ciphertext )>（固定 10 万次迭代）**仍可解密**，
// 仅不再产出（导入端 isEncryptedPayload / decryptPayload 两个前缀都认）。
//
// 口令不落盘。

const PREFIX_V2 = 'AQM2:'
const PREFIX_V1 = 'AQM1:'
/** 当前产出的格式版本（写入密文头第 1 字节） */
const FORMAT_VERSION = 2
/** 默认 KDF 迭代次数：旧格式 10 万偏低（离线爆破成本低），文件/剪贴板长期留存载体提到 60 万 */
const ITERATIONS = 600_000
/** 旧格式固定迭代次数（只用于解密 AQM1） */
const LEGACY_ITERATIONS = 100_000
/** 迭代次数的下界：低于此值一律判为损坏数据，避免被构造成 1 次迭代的弱 KDF */
const MIN_ITERATIONS = 1_000
const SALT_LEN = 16
const IV_LEN = 12
/** AQM2 头部长度：版本 1 字节 + 迭代次数 4 字节（大端） */
const HEADER_LEN = 5

export function isEncryptedPayload(text: string): boolean {
  const t = text.trim()
  return t.startsWith(PREFIX_V2) || t.startsWith(PREFIX_V1)
}

/** 当前导出使用的格式前缀（供界面文案/调试引用） */
export const ENCRYPT_PREFIX = PREFIX_V2

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim())
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function writeIterations(n: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

function readIterations(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false)
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptPayload(text: string, password: string): Promise<string> {
  if (!password) throw new Error('口令不能为空')
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
  const key = await deriveKey(password, salt, ITERATIONS)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text),
  )
  const out = new Uint8Array(HEADER_LEN + SALT_LEN + IV_LEN + encrypted.byteLength)
  out[0] = FORMAT_VERSION
  out.set(writeIterations(ITERATIONS), 1)
  out.set(salt, HEADER_LEN)
  out.set(iv, HEADER_LEN + SALT_LEN)
  out.set(new Uint8Array(encrypted), HEADER_LEN + SALT_LEN + IV_LEN)
  return PREFIX_V2 + bufToB64(out.buffer)
}

export async function decryptPayload(payload: string, password: string): Promise<string> {
  if (!password) throw new Error('口令不能为空')
  const text = payload.trim()

  if (text.startsWith(PREFIX_V2)) {
    const data = b64ToBytes(text.slice(PREFIX_V2.length))
    if (data.length <= HEADER_LEN + SALT_LEN + IV_LEN) throw new Error('加密数据已损坏')
    const version = data[0]
    if (version !== FORMAT_VERSION) {
      throw new Error(`不支持的加密格式版本（v${version}），请更新应用后重试`)
    }
    const iterations = readIterations(data, 1)
    if (iterations < MIN_ITERATIONS) throw new Error('加密数据已损坏')
    const salt = data.slice(HEADER_LEN, HEADER_LEN + SALT_LEN)
    const iv = data.slice(HEADER_LEN + SALT_LEN, HEADER_LEN + SALT_LEN + IV_LEN)
    const ciphertext = data.slice(HEADER_LEN + SALT_LEN + IV_LEN)
    // 迭代次数取自密文本身 → 将来提高/降低默认值不影响历史数据
    const key = await deriveKey(password, salt, iterations)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(decrypted)
  }

  if (text.startsWith(PREFIX_V1)) {
    // 旧格式：固定 10 万次迭代、无头部
    const data = b64ToBytes(text.slice(PREFIX_V1.length))
    if (data.length <= SALT_LEN + IV_LEN) throw new Error('加密数据已损坏')
    const salt = data.slice(0, SALT_LEN)
    const iv = data.slice(SALT_LEN, SALT_LEN + IV_LEN)
    const ciphertext = data.slice(SALT_LEN + IV_LEN)
    const key = await deriveKey(password, salt, LEGACY_ITERATIONS)
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(decrypted)
  }

  throw new Error('不是加密的配置文本')
}

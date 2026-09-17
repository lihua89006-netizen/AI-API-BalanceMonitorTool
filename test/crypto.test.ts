// 加密导出测试：AQM2 加密闭环 + KDF 参数自描述 + AQM1 旧格式向后兼容 + GCM 完整性

import { describe, expect, it } from 'vitest'
import { decryptPayload, encryptPayload, isEncryptedPayload } from '../src/lib/crypto'

/**
 * 旧格式 AQM1 的**真实密文**（由升级 AQM2 之前的实现产出，非手写）：
 * PBKDF2-SHA256 10 万次 + AES-GCM-256，salt = 00..0f、iv = a0..ab、口令 legacy-pwd、
 * 明文 {"schemaVersion":1,"providers":[{"uid":"legacy-1"}]}
 * 生成脚本（一次性，已删除）：node probe/gen-aqm1-fixture.mjs，脚本内自校验解密一致。
 * ⚠️ 这是"旧版导出的剪贴板/二维码还能不能导入"的回归护栏，不要因为格式升版就删掉。
 */
const LEGACY_AQM1 =
  'AQM1:AAECAwQFBgcICQoLDA0OD6ChoqOkpaanqKmqqyv/SGbLf8ppIP9s5H942aztSx9OEJI2KPv/fp3PmpNph+Y+lxjYswqvaVWHOvykMKlW/Fi9QRTjocfhZEtB0CCAVGqZ'
const LEGACY_PLAINTEXT = '{"schemaVersion":1,"providers":[{"uid":"legacy-1"}]}'
const LEGACY_PASSWORD = 'legacy-pwd'

/** 预期迭代次数（与 src/lib/crypto.ts 的 ITERATIONS 对齐） */
const EXPECTED_ITERATIONS = 600_000

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function b64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

describe('加密导出', () => {
  it('加密后可用同一口令解密还原（当前格式 AQM2）', async () => {
    const original = '{"schemaVersion":1,"providers":[{"uid":"p-1"}]}'
    const encrypted = await encryptPayload(original, 'mypassword')
    expect(encrypted.startsWith('AQM2:')).toBe(true)
    expect(isEncryptedPayload(encrypted)).toBe(true)
    const decrypted = await decryptPayload(encrypted, 'mypassword')
    expect(decrypted).toBe(original)
  })

  it('密文自带 KDF 参数：版本号与迭代次数写在头部且可读出', async () => {
    const encrypted = await encryptPayload('x', 'pwd')
    const data = b64ToBytes(encrypted.slice('AQM2:'.length))
    expect(data[0]).toBe(2) // 格式版本
    const iterations = new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0, false)
    expect(iterations).toBe(EXPECTED_ITERATIONS)
  })

  it('旧格式 AQM1 密文仍可解密（向后兼容：旧版导出的剪贴板/二维码可继续导入）', async () => {
    const decrypted = await decryptPayload(LEGACY_AQM1, LEGACY_PASSWORD)
    expect(decrypted).toBe(LEGACY_PLAINTEXT)
    expect(isEncryptedPayload(LEGACY_AQM1)).toBe(true)
  })

  it('旧格式 AQM1 用错口令同样失败（兼容路径也走真实校验）', async () => {
    await expect(decryptPayload(LEGACY_AQM1, 'wrong-pwd')).rejects.toThrow()
  })

  it('错误口令解密失败', async () => {
    const encrypted = await encryptPayload('secret-data', 'correct')
    await expect(decryptPayload(encrypted, 'wrong')).rejects.toThrow()
  })

  it('密文被篡改一个字节即解密失败（AES-GCM 完整性）', async () => {
    const encrypted = await encryptPayload('secret-data', 'correct')
    const data = b64ToBytes(encrypted.slice('AQM2:'.length))
    data[data.length - 1] ^= 0x01 // 翻转末尾密文 1 bit
    const tampered = 'AQM2:' + b64FromBytes(data)
    await expect(decryptPayload(tampered, 'correct')).rejects.toThrow()
  })

  it('同一口令每次加密结果不同（随机盐/IV）', async () => {
    const a = await encryptPayload('same', 'pwd')
    const b = await encryptPayload('same', 'pwd')
    expect(a).not.toBe(b)
  })

  it('未知格式版本给出明确报错', async () => {
    const encrypted = await encryptPayload('x', 'pwd')
    const data = b64ToBytes(encrypted.slice('AQM2:'.length))
    data[0] = 9 // 伪造一个未来版本号
    await expect(decryptPayload('AQM2:' + b64FromBytes(data), 'pwd')).rejects.toThrow(
      /不支持的加密格式版本/,
    )
  })

  it('加密数据被截断时报「已损坏」而非误报口令错误', async () => {
    const encrypted = await encryptPayload('x', 'pwd')
    const data = b64ToBytes(encrypted.slice('AQM2:'.length))
    const truncated = 'AQM2:' + b64FromBytes(data.slice(0, 10))
    await expect(decryptPayload(truncated, 'pwd')).rejects.toThrow(/已损坏/)
  })

  it('空口令报错', async () => {
    await expect(encryptPayload('x', '')).rejects.toThrow('口令不能为空')
    await expect(decryptPayload('AQM2:AAAA', '')).rejects.toThrow('口令不能为空')
  })

  it('isEncryptedPayload 只认两种加密前缀，明文/压缩文本判为否', async () => {
    expect(isEncryptedPayload('  AQM1:AAAA')).toBe(true)
    expect(isEncryptedPayload('AQM2:AAAA')).toBe(true)
    expect(isEncryptedPayload('Z1:eJxN')).toBe(false)
    expect(isEncryptedPayload('{"schemaVersion":1}')).toBe(false)
  })
})

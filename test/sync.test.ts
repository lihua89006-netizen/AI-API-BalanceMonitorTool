// 跨设备同步逻辑测试：导出 / 导入校验 / 合并

import { describe, expect, it } from 'vitest'
import {
  buildCompactPayload,
  buildExportFileText,
  buildExportPayload,
  buildExportText,
  exportFileName,
  mergeProviders,
  parseAnyImportPayload,
  parseImportPayload,
  SYNC_SCHEMA_VERSION,
} from '../src/lib/sync'
import { decryptPayload } from '../src/lib/crypto'
import type { AppConfig } from '../src/lib/store'

const cfg: AppConfig = {
  autoRefreshMinutes: 0,
  theme: 'light',
  providers: [
    {
      uid: 'p-a',
      providerId: 'deepseek_official',
      displayName: 'DeepSeek 官方',
      enabled: true,
      autoRefreshMinutes: 3,
      config: { api_key: 'sk-test' },
    },
    {
      uid: 'p-b',
      providerId: 'openai_compat',
      displayName: '中转站',
      enabled: true,
      autoRefreshMinutes: 0,
      config: { base_url: 'https://api.example.com', api_key: 'sk-x' },
    },
  ],
}

describe('导出', () => {
  it('生成含版本与 providers 的 JSON', () => {
    const text = buildExportPayload(cfg)
    const data = JSON.parse(text)
    expect(data.schemaVersion).toBe(SYNC_SCHEMA_VERSION)
    expect(Array.isArray(data.providers)).toBe(true)
    expect(data.providers.length).toBe(2)
  })

  it('精简导出：紧凑 JSON + 短字段名 + 剔除缓存字段，可被自动识别导入', async () => {
    const rich: AppConfig = {
      ...cfg,
      providers: [
        {
          ...cfg.providers[0],
          config: {
            api_key: 'sk-test',
            base_url: 'https://api.example.com',
            _detected_login: { url: 'https://x/login' },
            _detected_balance: { source: 'page', url: 'https://x/wallet' },
            balance_choice: { value: 12.34, context: '账户余额' },
          },
        },
      ],
    }
    const text = buildCompactPayload(rich)
    // 紧凑：无换行与缩进
    expect(text).not.toContain('\n')
    const data = JSON.parse(text)
    expect(data.z).toBe(2)
    expect(Array.isArray(data.p)).toBe(true)
    const site = data.p[0]
    expect(site.u).toBe('p-a')
    expect(site.pid).toBe('deepseek_official')
    expect(site.n).toBe('DeepSeek 官方')
    expect(site.c.ak).toBe('sk-test') // 短字段名
    expect(site.c.bu).toBe('https://api.example.com')
    expect(site.c._detected_login).toBeUndefined()
    expect(site.c.balance_choice).toBeUndefined()
    // 精简结果可被自动识别导入解析，并还原标准字段名
    const result = await parseAnyImportPayload(text)
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(1)
    expect(result.entries[0].config.api_key).toBe('sk-test')
    expect(result.entries[0].config.base_url).toBe('https://api.example.com')
  })

  it('自动识别导入兼容标准格式', async () => {
    const result = await parseAnyImportPayload(buildExportPayload(cfg))
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(2)
  })
})

// 「导出配置文件」按钮的产物口径（2026-09/16：复制形式 + 滑动开关控制是否加密）
describe('导出配置文件（复制形式）', () => {
  it('开关关闭 → 复制明文压缩文本（Z1:），且能被导入端直接解析', async () => {
    const text = await buildExportText(cfg, { encrypt: false, password: '' })
    expect(text.startsWith('Z1:')).toBe(true)
    const result = await parseAnyImportPayload(text)
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(2)
  })

  it('开关打开 → 复制 AQM2 密文，解密后与明文导出完全一致', async () => {
    const plain = await buildExportText(cfg, { encrypt: false, password: '' })
    const encrypted = await buildExportText(cfg, { encrypt: true, password: 'pwd-123' })
    expect(encrypted.startsWith('AQM2:')).toBe(true)
    expect(encrypted).not.toContain('sk-test') // 明文 API Key 不得出现在密文里
    const decrypted = await decryptPayload(encrypted, 'pwd-123')
    expect(decrypted).toBe(plain)
    const result = await parseAnyImportPayload(decrypted)
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(2)
  })

  it('开关打开但口令为空/纯空白 → 抛错，绝不静默回退成明文', async () => {
    await expect(buildExportText(cfg, { encrypt: true, password: '' })).rejects.toThrow(
      '口令不能为空',
    )
    await expect(buildExportText(cfg, { encrypt: true, password: '   ' })).rejects.toThrow(
      '口令不能为空',
    )
  })

  it('口令首尾空白被去除（用户多敲空格也能解开）', async () => {
    const encrypted = await buildExportText(cfg, { encrypt: true, password: '  pwd-9  ' })
    await expect(decryptPayload(encrypted, 'pwd-9')).resolves.toBeTypeOf('string')
  })
})

// 「导出配置文件」的**文件内容**（2026-09/16 改版：导出物是一个 .json 文件，见 export_config_file）
describe('导出配置文件（文件形式）', () => {
  it('未加密 → 标准 JSON（真 .json、可读，且导入端本来就能解析）', async () => {
    const text = await buildExportFileText(cfg, { encrypt: false, password: '' })
    const data = JSON.parse(text) // 必须能当 JSON 解析（这与剪贴板的 Z1: 压缩文本不同）
    expect(data.schemaVersion).toBe(SYNC_SCHEMA_VERSION)
    expect(data.providers.length).toBe(2)
    expect(text).toContain('sk-test')
    const result = parseImportPayload(text)
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(2)
  })

  it('加密 → AQM2 密文，解密后是同一份标准 JSON，且不含明文 Key', async () => {
    const plain = await buildExportFileText(cfg, { encrypt: false, password: '' })
    const encrypted = await buildExportFileText(cfg, { encrypt: true, password: 'pwd-abc' })
    expect(encrypted.startsWith('AQM2:')).toBe(true)
    expect(encrypted).not.toContain('sk-test')
    const back = await decryptPayload(encrypted, 'pwd-abc')
    expect(back).toBe(plain)
    expect(JSON.parse(back).providers.length).toBe(2)
  })

  it('加密但口令为空/纯空白 → 抛错，绝不回退成明文', async () => {
    await expect(buildExportFileText(cfg, { encrypt: true, password: '' })).rejects.toThrow(
      '口令不能为空',
    )
    await expect(buildExportFileText(cfg, { encrypt: true, password: '  ' })).rejects.toThrow(
      '口令不能为空',
    )
  })

  it('导出文件名：yyMMdd.HHmm 风格、补零、以 .json 结尾（与打包产物同风格）', () => {
    const d = new Date(2026, 8, 16, 12, 4) // 2026-09-16 12:04（月份从 0 起）
    expect(exportFileName(d)).toBe('API余额通-配置_260916.1204.json')
    const d2 = new Date(2026, 0, 5, 9, 30)
    expect(exportFileName(d2)).toBe('API余额通-配置_260105.0930.json')
  })
})

describe('导入校验', () => {
  it('合法文本解析成功', () => {
    const text = buildExportPayload(cfg)
    const result = parseImportPayload(text)
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(2)
    expect(result.message).toContain('2 个站点')
  })

  it('非法 JSON 报错', () => {
    const result = parseImportPayload('not json{{{')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('JSON')
  })

  it('版本不匹配报错', () => {
    const result = parseImportPayload(JSON.stringify({ schemaVersion: 99, providers: [] }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('版本')
  })

  it('缺失必填字段的条目被跳过', () => {
    const text = JSON.stringify({
      schemaVersion: SYNC_SCHEMA_VERSION,
      providers: [
        { uid: 'p-ok', providerId: 'deepseek_official', displayName: '好的', config: {} },
        { uid: '', providerId: 'x', displayName: '缺 uid' },
        { providerId: 'y', displayName: '缺 uid' },
        'not-an-object',
      ],
    })
    const result = parseImportPayload(text)
    expect(result.ok).toBe(true)
    expect(result.entries.length).toBe(1)
    expect(result.message).toContain('3 个无效已跳过')
  })
})

describe('合并', () => {
  it('同 uid 覆盖（导入优先）、新 uid 追加', () => {
    const existing = [
      { uid: 'p-a', providerId: 'deepseek_official', displayName: '旧名称', enabled: true, autoRefreshMinutes: 0, config: {} },
      { uid: 'p-keep', providerId: 'oneapi_newapi', displayName: '保留站', enabled: true, autoRefreshMinutes: 0, config: {} },
    ]
    const incoming = [
      { uid: 'p-a', providerId: 'deepseek_official', displayName: '新名称', enabled: true, autoRefreshMinutes: 5, config: { api_key: 'new' } },
      { uid: 'p-new', providerId: 'openrouter', displayName: '新增站', enabled: true, autoRefreshMinutes: 0, config: {} },
    ]
    const merged = mergeProviders(existing, incoming)
    expect(merged.length).toBe(3)
    const a = merged.find((m) => m.uid === 'p-a')
    expect(a?.displayName).toBe('新名称') // 覆盖
    expect(a?.autoRefreshMinutes).toBe(5)
    expect(merged.some((m) => m.uid === 'p-keep')).toBe(true) // 保留
    expect(merged.some((m) => m.uid === 'p-new')).toBe(true) // 新增
  })
})

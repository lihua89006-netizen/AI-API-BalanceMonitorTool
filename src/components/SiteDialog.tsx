// 添加 / 编辑站点对话框：按 configSchema 动态生成表单 + 测试连接 + 代理/币种/自动刷新

import { useMemo, useState } from 'react'
import MenuSelect from './MenuSelect'
import { fetchEntry } from '../lib/worker'
import { PROVIDERS } from '../providers/registry'
import { PLANS, PLAN_PRIORITY, entryPlans, entryPrimaryPlan } from '../lib/plans'
import type { PlanId } from '../lib/plans'
import type { ProviderEntry } from '../lib/store'
import type { QuotaInfo } from '../providers/types'
import { fmtMoney } from '../lib/fmt'

/** 安卓端不渲染 desktopOnly 字段（如「模拟浏览器登录」的账号密码——安卓为 WebView 手动登录） */
function isAndroidPlatform(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
}

/** 浏览器登录：Windows 自动无头 / 安卓内嵌 WebView 手动登录，两端均可用 */
const availableProviders = PROVIDERS

interface SiteDialogProps {
  entry?: ProviderEntry | null // 编辑时传入
  onCancel: () => void
  onSave: (entry: ProviderEntry) => void
}

let uidSeq = 0
function genUid(): string {
  uidSeq += 1
  return `p-${Date.now().toString(36)}-${uidSeq}`
}

/**
 * 站点类型的**默认显示名称**（2026-09/16 用户要求）：
 * 选到 DeepSeek 官方时把显示名称默认填成「DeepSeek官方」，省一次手输。
 * ⚠️ 只在"名字还空着"或"名字还是我们自动填的那个"时才改 —— 用户自己敲过的名字不会被覆盖；
 *    切到别的类型时再把自动填的值清掉，避免留下一个与类型不符的名字。
 */
const DEFAULT_DISPLAY_NAMES: Record<string, string> = {
  deepseek_official: 'DeepSeek官方',
}

export default function SiteDialog({ entry, onCancel, onSave }: SiteDialogProps) {
  const editing = Boolean(entry)
  const [providerId, setProviderId] = useState(entry?.providerId ?? availableProviders[0].id)
  const initialProviderId = entry?.providerId ?? availableProviders[0].id
  const [displayName, setDisplayName] = useState(
    entry?.displayName ?? DEFAULT_DISPLAY_NAMES[initialProviderId] ?? '',
  )
  // 当前显示名是否还是"我们自动填的默认值"（用户一改就置 false，此后不再自动覆盖）
  const [nameIsAuto, setNameIsAuto] = useState(!entry && Boolean(DEFAULT_DISPLAY_NAMES[initialProviderId]))
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    if (entry) {
      for (const [k, v] of Object.entries(entry.config || {})) out[k] = String(v ?? '')
    }
    return out
  })
  const [proxy, setProxy] = useState(String(entry?.config?.proxy ?? ''))
  const [currency, setCurrency] = useState(String(entry?.config?.display_currency ?? ''))
  const [billingPlans, setBillingPlans] = useState<PlanId[]>(() => entryPlans(entry?.config))
  const [primaryPlan, setPrimaryPlan] = useState<PlanId>(() => entryPrimaryPlan(entry?.config))
  const [autoMin, setAutoMin] = useState(entry?.autoRefreshMinutes ?? 3)
  const [enabled, setEnabled] = useState(entry?.enabled ?? true)
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 用户确认的余额候选（用于 generic_login_html 校准）
  const [balanceChoice, setBalanceChoice] = useState<{ value: number; context: string } | null>(() => {
    const bc = entry?.config?.balance_choice
    if (bc && typeof bc === 'object') {
      const v = Number((bc as Record<string, unknown>).value)
      const c = String((bc as Record<string, unknown>).context || '')
      if (Number.isFinite(v) && c) return { value: v, context: c }
    }
    return null
  })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<QuotaInfo | null>(null)
  const [error, setError] = useState('')
  // 字段级校验错误：{ 字段key: 提示 }，输入框红色高亮 + 字段下方小字（inline 提示）
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  // 对话框内容是否已下滑（scrollTop > 0）：标题行显示分割线以直观提示
  const [scrolled, setScrolled] = useState(false)

  const provider = useMemo(() => availableProviders.find((p) => p.id === providerId) ?? availableProviders[0], [providerId])

  function buildEntry(requireValid: boolean): ProviderEntry | null {
    const errors: Record<string, string> = {}
    const name = displayName.trim()
    if (!name) errors.name = '请填写显示名称。'
    const config: Record<string, unknown> = {}
    for (const f of provider.configSchema) {
      // 安卓端隐藏字段（desktopOnly）不参与校验与保存
      if (isAndroidPlatform() && f.desktopOnly) continue
      const v = fields[f.key] ?? ''
      if (f.required && !v.trim()) {
        if (requireValid) errors[f.key] = `请填写「${f.label}」。`
        continue
      }
      if (v !== '') config[f.key] = f.type === 'number' ? Number(v) : v
    }
    if (requireValid && Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      setError(Object.values(errors)[0])
      return null
    }
    setFieldErrors({})
    if (proxy.trim()) config.proxy = proxy.trim()
    if (currency.trim()) config.display_currency = currency.trim()
    // 多方案：写入支持列表 + 主显示方案（主方案确保在支持列表内）
    config.billingPlans = billingPlans
    delete config.billingPlan // 旧单值字段不再写
    config.primaryPlan = billingPlans.includes(primaryPlan) ? primaryPlan : billingPlans[0]
    if (balanceChoice) config.balance_choice = balanceChoice
    // 保留内部缓存字段（以下划线开头，如自动识别探测结果），编辑保存不丢缓存；
    // 但 _auto_billing_plans 是「自动勾选」标记：用户手动保存即视为人工勾选，清除标记
    for (const [k, v] of Object.entries(entry?.config ?? {})) {
      if (k.startsWith('_') && k !== '_auto_billing_plans' && !(k in config)) config[k] = v
    }
    return {
      uid: entry?.uid ?? genUid(),
      providerId: provider.id,
      displayName: name,
      enabled,
      autoRefreshMinutes: Math.max(0, autoMin),
      config,
    }
  }

  async function handleTest() {
    const e = buildEntry(false)
    if (!e) return
    setTesting(true)
    setTestResult(null)
    setError('')
    try {
      const info = await fetchEntry(e)
      setTestResult(info)
    } catch (err) {
      setError(`测试异常：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  function handleSave() {
    const e = buildEntry(true)
    if (!e) return
    onSave(e)
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}
      >
        <div className={`dialog-title-row site-sticky-title ${scrolled ? 'scrolled' : ''}`}>
          <h2 className="dialog-title">{editing ? '编辑站点' : '添加站点'}</h2>
          {!editing && (
            <span className="dialog-title-tip">
              乱七八糟的站请尽量选择自动识别接口，因为大部分站都没有余额查询接口
            </span>
          )}
        </div>
        <label className="field-label">显示名称</label>
        <input
          className={`field-input ${fieldErrors.name ? 'field-error' : ''}`}
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value)
            setNameIsAuto(false) // 用户手动改过 → 之后不再被类型默认值覆盖
            if (fieldErrors.name) {
              setFieldErrors((prev) => {
                const next = { ...prev }
                delete next.name
                return next
              })
            }
          }}
          placeholder="例如：我的中转站（仅界面显示用）"
          aria-invalid={!!fieldErrors.name}
        />
        {fieldErrors.name && (
          <p className="field-error-text" role="alert">
            {fieldErrors.name}
          </p>
        )}

        <label className="field-label">站点类型</label>
        <MenuSelect
          align="left"
          value={providerId}
          disabled={editing}
          options={availableProviders.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(id) => {
            setProviderId(id)
            setFields({})
            // 站点类型的默认显示名（见 DEFAULT_DISPLAY_NAMES）：空着、或还是自动填的值时才改
            const next = DEFAULT_DISPLAY_NAMES[id] ?? ''
            if (nameIsAuto || displayName.trim() === '') {
              setDisplayName(next)
              setNameIsAuto(next !== '')
            }
          }}
          title={editing ? '站点类型创建后不可更改，请删除后重新添加。' : undefined}
        />

        {provider.description && <p className="field-hint">{provider.description}</p>}

        {/* 普通字段（非高级设置；安卓端隐藏 desktopOnly 字段） */}
        {provider.configSchema
          .filter((f) => !f.advanced && !(isAndroidPlatform() && f.desktopOnly))
          .map((f) => (
            <div key={f.key}>
              <label className="field-label">
                {f.label}
                {f.required ? <span className="req"> *</span> : null}
              </label>
              {f.type === 'select' && f.options ? (
                <MenuSelect
                  align="left"
                  value={fields[f.key] ?? f.options[0]?.value ?? ''}
                  options={f.options}
                  onChange={(v) => {
                    setFields((prev) => ({ ...prev, [f.key]: v }))
                    if (fieldErrors[f.key]) {
                      setFieldErrors((prev) => {
                        const next = { ...prev }
                        delete next[f.key]
                        return next
                      })
                    }
                  }}
                />
              ) : (
                <input
                  className={`field-input ${fieldErrors[f.key] ? 'field-error' : ''}`}
                  type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  value={fields[f.key] ?? ''}
                  onChange={(e) => {
                    setFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                    // 输入后清除该字段错误（inline 即时反馈）
                    if (fieldErrors[f.key]) {
                      setFieldErrors((prev) => {
                        const next = { ...prev }
                        delete next[f.key]
                        return next
                      })
                    }
                  }}
                  placeholder={f.placeholder}
                  aria-invalid={!!fieldErrors[f.key]}
                />
              )}
              {fieldErrors[f.key] && (
                <p className="field-error-text" role="alert">
                  {fieldErrors[f.key]}
                </p>
              )}
            </div>
          ))}

        <label className="field-label">计费方式（可多选）</label>
        <div className="plan-check-group">
          {PLANS.map((p) => {
            const checked = billingPlans.includes(p.id)
            return (
              <label key={p.id} className={`plan-check-item ${checked ? 'checked' : ''}`}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...billingPlans, p.id]
                      : billingPlans.filter((x) => x !== p.id)
                    setBillingPlans(next.length > 0 ? next : [p.id])
                    // 主方案被取消勾选时，自动改到仍勾选且优先级最高的那个
                    if (!next.includes(primaryPlan)) {
                      const sorted = [...next].sort(
                        (a, b) => PLAN_PRIORITY[a] - PLAN_PRIORITY[b],
                      )
                      setPrimaryPlan(sorted[0] ?? p.id)
                    }
                  }}
                />
                <span>{p.label}</span>
              </label>
            )
          })}
        </div>
        {billingPlans.length > 1 && (
          <>
            <label className="field-label">主卡片显示（卡片默认展示的方案）</label>
            <MenuSelect
              align="left"
              value={primaryPlan}
              options={billingPlans.map((id) => ({
                value: id,
                label: PLANS.find((p) => p.id === id)?.label ?? id,
              }))}
              onChange={setPrimaryPlan}
              title="主界面卡片默认展示该方案的数据；其他方案收纳为可展开的次级卡片"
            />
          </>
        )}
        <p className="field-hint">勾选该站点支持的计费方式，用于主界面「方案筛选」归类；多个时可展开切换</p>

        <label className="field-label">币种（可选）</label>
        <input
          className="field-input"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          placeholder="留空默认 CNY（如 USD）"
        />

        {/* —— 高级设置折叠区（默认收起）—— */}
        <div className="advanced-section">
          <button
            type="button"
            className="advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            高级设置
            <span className="advanced-arrow">{showAdvanced ? '▾' : '▸'}</span>
          </button>
          {showAdvanced && (
            <div className="advanced-body">
              {provider.configSchema
                .filter((f) => f.advanced && !(isAndroidPlatform() && f.desktopOnly))
                .map((f) => (
                  <div key={f.key}>
                    <label className="field-label">{f.label}</label>
                    {f.type === 'select' && f.options ? (
                      <MenuSelect
                        align="left"
                        value={fields[f.key] ?? f.options[0]?.value ?? ''}
                        options={f.options}
                        onChange={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))}
                      />
                    ) : (
                      <input
                        className="field-input"
                        type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                        value={fields[f.key] ?? ''}
                        onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                      />
                    )}
                  </div>
                ))}
              <label className="field-label">代理（可选）</label>
              <input
                className="field-input"
                value={proxy}
                onChange={(e) => setProxy(e.target.value)}
                placeholder="如 http://127.0.0.1:7890（访问国外站点需代理时填写）"
              />
            </div>
          )}
        </div>

        <label className="field-label">自动刷新间隔</label>
        <input
          className="field-input"
          type="number"
          min={0}
          max={1440}
          value={autoMin}
          onChange={(e) => setAutoMin(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
        />
        <p className="field-hint">分钟（0 = 关闭该站点的自动刷新）</p>

        <label className="field-label check-label">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用该站点（取消勾选可暂停刷新，无需删除）
        </label>

        {error && <p className="field-error">{error}</p>}

        {testResult && (
          <div className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok
              ? `连接成功！剩余 ${fmtMoney(testResult.remaining ?? testResult.total, testResult.currency)}${
                  testResult.extra ? ` · ${testResult.extra}` : ''
                }`
              : `连接失败：${testResult.message}`}
          </div>
        )}

        {/* 候选校准：识别到多个候选时点选正确的余额 */}
        {testResult?.ok && testResult.candidates && testResult.candidates.length > 1 && (
          <div className="candidate-list">
            <p className="field-hint">
              识别到 {testResult.candidates.length} 个候选数字，请点选<b>正确的余额</b>（程序会记住你的选择）：
            </p>
            {testResult.candidates.map((c, i) => {
              const selected =
                balanceChoice?.value === c.value && balanceChoice?.context === c.context
              return (
                <button
                  key={i}
                  type="button"
                  className={`candidate-item ${selected ? 'selected' : ''}`}
                  onClick={() => setBalanceChoice({ value: c.value, context: c.context })}
                >
                  <b className="candidate-value mono-num">
                    {c.currency}
                    {c.value.toFixed(2)}
                  </b>
                  <span className="candidate-ctx">{c.context || '（无上下文）'}</span>
                </button>
              )
            })}
            {balanceChoice && (
              <button
                type="button"
                className="candidate-clear"
                onClick={() => setBalanceChoice(null)}
              >
                清除选择（恢复自动识别）
              </button>
            )}
          </div>
        )}

        <div className="dialog-actions site-sticky-actions">
          <button className="btn secondary" onClick={handleTest} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <span className="spacer" />
          <button className="btn secondary" onClick={onCancel}>
            取消
          </button>
          <button className="btn primary" onClick={handleSave}>
            {editing ? '保存' : '添加'}
          </button>
        </div>
      </div>
    </div>
  )
}

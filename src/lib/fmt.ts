// 金额 / 时间格式化（统一两位小数；对齐原 Python 版 fmt_money 的大数格式）

/** 拆分金额：币种前缀（符号）与数字主体。
 *  用途：调用方需要「符号与数字之间留可调间隙」时（如挂件「今日已用」行）分别渲染两段；
 *  其余场景直接用 fmtMoney，结果完全一致。 */
export function fmtMoneyParts(v: number | null | undefined, currency: string): { prefix: string; rest: string } {
  if (v === null || v === undefined || !Number.isFinite(v)) return { prefix: '', rest: '-' }
  const value = Object.is(v, -0) ? 0 : v
  const s = value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const symbol: Record<string, string> = { CNY: '¥', RMB: '¥', USD: '$', EUR: '€', GBP: '£' }
  const c = (currency || '').trim().toUpperCase()
  const sym = symbol[c] ?? ''
  if (sym) return { prefix: sym, rest: s }
  // 配额百分比（如 OpenCode Go 用量 %）与数字紧贴，不留空格（用户要求）——这是后缀而非前缀
  if (c === '%') return { prefix: '', rest: `${s}%` }
  return { prefix: '', rest: `${s} ${c}`.trim() }
}

export function fmtMoney(v: number | null | undefined, currency: string): string {
  const { prefix, rest } = fmtMoneyParts(v, currency)
  // 币种符号与数字紧贴（对齐 Python 版 fmt_amount：f"{symbol}{s}"）
  return `${prefix}${rest}`
}

/** 币种符号与数字之间留一个可调间隙（挂件「今日已用」行专用；2026-09/15 用户要求「加一点点间隙」）。
 *  间隙由 `thinSpace` 字符承载而非 CSS margin——宽度可量测、可单独调，且不影响既有排版；
 *  对没有前缀符号的币种（`%` 配额、未知币种）自动退化为与 fmtMoney 完全一致的输出。 */
export function fmtMoneySpaced(
  v: number | null | undefined,
  currency: string,
  thinSpace = ' ',
): string {
  const { prefix, rest } = fmtMoneyParts(v, currency)
  return prefix ? `${prefix}${thinSpace}${rest}` : rest
}

/** 次数/整数计数格式化：无数据或非法值显示「—」，整数千分位 */
export function fmtCount(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('zh-CN')
}

/** 剩余时长格式化：秒 → 友好中文时长（如 4800 → 「1小时20分钟」，含秒时显示到秒）。
 *  约定：duration（包时）方案的 remaining/total 单位为「秒」。
 *  分级：天级带小时、小时级带分钟和秒、分钟级带秒，不足一分钟显示秒 */
export function fmtDuration(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const s = Math.max(0, Math.round(v))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return h > 0 ? `${d}天${h}小时` : `${d}天`
  if (h > 0) return `${h}小时${m}分钟${sec > 0 ? `${sec}秒` : ''}`
  if (m > 0) return sec > 0 ? `${m}分钟${sec}秒` : `${m}分钟`
  return `${sec}秒`
}

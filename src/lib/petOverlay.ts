// 桌宠（安卓端系统悬浮窗）的数据组装（2026-09/19）。
//
// 把主界面**已有**的刷新结果 + 当日余额账本，折算成悬浮层要显示的四行文字：
//   站名（+「余额」小字后缀）／ 余额大字 ／ 状态（优先「今日已用」）／ 峰谷徽标 + 倒计时
//
// ⚠️ **口径唯一**（方案 §四「数据通路」的第 (i) 条）：这里不新造任何口径，每一行都调用桌面挂件
//    `widget/WidgetApp.tsx` 用的同一批函数（`fmt` / `usage` / `deepseekPeak`）。
//    安卓端原生层（`PetCanvasView`）只负责把字符串画出来 —— 两端因此**不可能**出现两个矛盾的数字，
//    也不需要把网络层与 Key 复制到原生侧。
//
// ⚠️ 这里的函数都是**纯函数**（时间可注入），便于单测；副作用（invoke / 定时器）留在 App.tsx。

import type { QuotaInfo } from '../providers/types'
import type { AppConfig, ProviderEntry } from './store'
import { fmtMoney, fmtMoneySpaced } from './fmt'
import { todayUsed, type UsageBaseline } from './usage'
import {
  DEEPSEEK_PEAK_INFO,
  deepseekNextChange,
  deepseekPeakNow,
  fmtPeakCountdownRemaining,
} from './deepseekPeak'

/** 状态行配色口径（对齐 `widget.css` 的 `.widget-status.*`） */
export type PetStatusKind = 'ok' | 'err' | 'busy' | 'used'
/** 峰谷徽标配色口径（对齐 `.widget-peak-peak` / `.widget-peak-valley`） */
export type PetPeakKind = 'peak' | 'valley' | ''

export interface PetPayload {
  uid: string
  name: string
  balance: string
  status: string
  statusKind: PetStatusKind
  peakLabel: string
  peakText: string
  peakKind: PetPeakKind
}

/** 站名（与桌面挂件同口径：去掉所有空白字符；「余额」后缀由原生层用小字号补上） */
export function petName(entry: Pick<ProviderEntry, 'displayName'>): string {
  return entry.displayName.replace(/\s+/g, '') || '未命名站点'
}

/** 余额行：remaining 优先、退化到 total；无数据时与桌面挂件一样是 '-' */
export function petBalance(info: QuotaInfo | null | undefined): string {
  const v = info?.remaining ?? info?.total
  return fmtMoney(v ?? null, info?.currency ?? '')
}

/**
 * 状态行：有「今日已用」就优先显示它（与桌面挂件同一取舍），否则回退到状态文案。
 * 无数据时没有「点击任意位置刷新」这个入口可用（悬浮窗整窗穿透、点不到鲸鱼），故文案是「等待刷新…」。
 */
export function petStatus(
  info: QuotaInfo | null | undefined,
  baseline: UsageBaseline | null | undefined,
): { text: string; kind: PetStatusKind } {
  const used = todayUsed(baseline, info?.currency)
  if (used !== null) {
    return {
      // 币种符号与数字之间用 U+2009 细空格（与挂件同一处理，2026-09/15 用户要求）
      text: `今日已用 ${fmtMoneySpaced(used, info?.currency ?? '', '\u2009')}`,
      kind: 'used',
    }
  }
  if (!info) return { text: '等待刷新…', kind: 'busy' }
  if (info.ok) return { text: '数据正常', kind: 'ok' }
  return { text: info.message || '查询失败', kind: 'err' }
}

/** 峰谷行：只有 DeepSeek 官方站有（与主卡片 `.ds-peak`、挂件 `.widget-peak` 同一套判断） */
export function petPeak(
  providerId: string,
  now: Date = new Date(),
): { label: string; text: string; kind: PetPeakKind } {
  if (providerId !== 'deepseek_official') return { label: '', text: '', kind: '' }
  const kind = deepseekPeakNow(now)
  return {
    label: DEEPSEEK_PEAK_INFO[kind].label,
    text: fmtPeakCountdownRemaining(deepseekNextChange(now).seconds),
    kind,
  }
}

/**
 * 峰谷倒计时的刷新节奏（毫秒）：与主卡片 / 挂件同一阈值 ——
 * 剩余 **< 2 小时**时文案带秒 → 1 秒一跳；否则分钟级 → 10 秒一跳。
 * 非 DeepSeek 站没有必要刷新（返回 0）。
 */
export function petPeakTickMs(providerId: string, now: Date = new Date()): number {
  if (providerId !== 'deepseek_official') return 0
  return deepseekNextChange(now).seconds < 7200 ? 1000 : 10_000
}

/** 组装悬浮层要的一整份文字 */
export function buildPetPayload(
  entry: Pick<ProviderEntry, 'uid' | 'displayName' | 'providerId'>,
  info: QuotaInfo | null | undefined,
  baseline: UsageBaseline | null | undefined,
  now: Date = new Date(),
): PetPayload {
  const st = petStatus(info, baseline)
  const pk = petPeak(entry.providerId, now)
  return {
    uid: entry.uid,
    name: petName(entry),
    balance: petBalance(info),
    status: st.text,
    statusKind: st.kind,
    peakLabel: pk.label,
    peakText: pk.text,
    peakKind: pk.kind,
  }
}

/**
 * 桌宠默认展示哪个站点：**上次展示过的**（`lastWidgetUid`，与桌面挂件共用同一个记忆字段）→
 * 找不到就退回**列表第一张卡**（"置顶站点"）。
 * 返回 null 表示一个站点都没有（前端据此提示「先添加站点」）。
 */
export function pickPetUid(cfg: AppConfig | null): string | null {
  if (!cfg || cfg.providers.length === 0) return null
  const last = cfg.lastWidgetUid
  if (last && cfg.providers.some((p) => p.uid === last)) return last
  return cfg.providers[0].uid
}

/**
 * 菜单里「切换站点」：按配置顺序循环到下一个（`current` 不在列表里时回到第一个）。
 * 只在地点列表里循环（不跳过异常站点）——异常站点也应能看到它的失败原因。
 */
export function nextPetUid(cfg: AppConfig | null, current: string | null): string | null {
  if (!cfg || cfg.providers.length === 0) return null
  const i = cfg.providers.findIndex((p) => p.uid === current)
  if (i < 0) return cfg.providers[0].uid
  return cfg.providers[(i + 1) % cfg.providers.length].uid
}

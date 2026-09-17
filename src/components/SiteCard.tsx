// 站点玻璃卡片：左侧内容 + 右侧操作按钮块（垂直居中）
// 第一行：标识 + 名称 + 打开网站
// 第二行：余额 + 状态
// 第三行：详情
// 右侧：按钮块（↑ ↻刷新 ▣展示 / ↓ ✎编辑 ×删除，三列等宽，垂直居中）
// Android 紧凑版：隐藏详情行与上移/下移/展示，长按拖拽排序
//
// 多方案：站点支持多种计费方式时，主卡展示主方案（primaryPlan）数据，
// 底部「收纳条」提示其他方案；点开后可展开次级卡片（每个方案一张），
// 次级卡上可「设为主卡」即时切换主显示方案。

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import ProviderIcon from './ProviderIcon'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { ProviderEntry } from '../lib/store'
import { PROVIDERS } from '../providers/registry'
import type { QuotaInfo } from '../providers/types'
import { PLANS, entryPlans, entryPrimaryPlan } from '../lib/plans'
import type { PlanId } from '../lib/plans'
import PlanValue from './PlanValue'
import { Pencil, RefreshCw, Trash2, Waves } from 'lucide-react'
import { DEEPSEEK_PEAK_INFO, deepseekNextChange, deepseekPeakNow, fmtPeakCountdown } from '../lib/deepseekPeak'

/** 运行时判断平台（渲染时读取，确保 main.tsx 已设置 data-platform） */
function isAndroidPlatform(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
}

interface SiteCardProps {
  entry: ProviderEntry
  info?: QuotaInfo
  refreshing?: boolean
  onRefresh: (entry: ProviderEntry) => void
  onEdit: (entry: ProviderEntry) => void
  onDelete: (entry: ProviderEntry) => void
  onShow?: (entry: ProviderEntry) => void // 展示窗口（鲸鱼娘挂件，阶段 3）
  /** 切换主显示方案（持久化 primaryPlan） */
  onSetPrimary?: (uid: string, plan: PlanId) => void
  /** 安卓端：单击卡片打开操作弹窗（按钮与多方案移入弹窗） */
  onOpenActions?: (entry: ProviderEntry) => void
  delay?: number
}

const MARKS: Record<string, [string, string]> = {
  deepseek_official: ['DS', 'blue'],
  openai_compat: ['OA', 'cyan'],
  openrouter: ['OR', 'coral'],
  aliyun: ['AL', 'yellow'],
  volcengine: ['VE', 'violet'],
  code_ai: ['OC', 'blue'],
  browser_login: ['BL', 'cyan'],
}

// 站名左侧色块颜色：DeepSeek 官方固定蓝、阿里云固定黄，其余挂载时随机取一色（刷新不跳变）
const FIXED_ACCENT: Record<string, string> = {
  deepseek_official: 'blue',
  aliyun: 'yellow',
}
const ACCENT_POOL = ['violet', 'coral', 'cyan'] as const

// 使用官方品牌图标（而非文字缩写）的 provider
const BRAND_ICON_PROVIDERS = new Set(['deepseek_official', 'aliyun', 'volcengine'])

/** 渲染单个方案的数据行（主卡数区 / 次级卡复用）：金额 or 无数据占位 */

export default function SiteCard({
  entry,
  info,
  refreshing,
  onRefresh,
  onEdit,
  onDelete,
  onShow,
  onSetPrimary,
  onOpenActions,
  delay = 0,
}: SiteCardProps) {
  const [entered, setEntered] = useState(false)
  const [expanded, setExpanded] = useState(false)
  // DeepSeek 官方站的峰谷倒计时：本地计算显示（不依赖网络），每 10 秒刷新一次，
  // 无需每秒渲染；站点数据核对仍按各自 autoRefreshMinutes（默认 3 分钟）进行
  const [dsPeak, setDsPeak] = useState<'peak' | 'valley' | null>(null)
  const [dsCountdown, setDsCountdown] = useState('')
  useEffect(() => {
    if (entry.providerId !== 'deepseek_official') return
    // 离下一时段切换 < 2 小时时每秒跳动（显示秒），≥ 2 小时 10 秒一次（分钟级）
    let timer: ReturnType<typeof setInterval> | null = null
    const tick = () => {
      if (timer) clearInterval(timer)
      const now = new Date()
      setDsPeak(deepseekPeakNow(now))
      const next = deepseekNextChange(now)
      setDsCountdown(`${fmtPeakCountdown(next.seconds)}后→${DEEPSEEK_PEAK_INFO[next.next].label}价`)
      timer = setInterval(tick, next.seconds < 7200 ? 1000 : 10000)
    }
    tick()
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [entry.providerId])

  useEffect(() => {
    const t = setTimeout(() => setEntered(true), delay)
    return () => clearTimeout(t)
  }, [delay])

  const provider = PROVIDERS.find((p) => p.id === entry.providerId)
  // OpenCode Go 套餐徽标：Code AI 适配器 + service=opencode + 填了 API Key（Go 用量查询）
  const isOpenCodeGo =
    entry.providerId === 'code_ai' &&
    String((entry.config.service as string) || 'opencode').trim().toLowerCase() === 'opencode' &&
    Boolean(String((entry.config.api_key as string) || '').trim())
  // 缩写：官方已知表未命中时用站点名首 1-2 字符（避免固定显示 "API"）
  const [mark] = MARKS[entry.providerId] ?? [
    (entry.displayName ?? '').trim().slice(0, 2) || 'API',
    'violet',
  ]
  // 固定色（DeepSeek 蓝 / 阿里云黄）或挂载时随机取色
  const [accent] = useState(
    () => FIXED_ACCENT[entry.providerId] ?? ACCENT_POOL[Math.floor(Math.random() * ACCENT_POOL.length)],
  )

  // 抓取站点图标：Rust 后端抓首页 HTML 解析候选 URL（优先 rel=icon、含 logo 的图片、og:image）
  const [favSources, setFavSources] = useState<readonly string[]>([])
  const [favOk, setFavOk] = useState<boolean | null>(null) // null=未尝试/无源, true=成功, false=全部失败
  const [favIdx, setFavIdx] = useState(0)
  // 第一步：请求 Rust 端解析候选图标地址
  useEffect(() => {
    // 官方三站（DeepSeek/阿里云/火山引擎）用 lobehub 内置图标，无需抓取
    if (BRAND_ICON_PROVIDERS.has(entry.providerId)) return
    let cancelled = false
    try {
      const baseUrl = provider?.websiteUrl ?? ''
      const url = provider?.getWebsiteUrl ? provider.getWebsiteUrl(entry.config) : baseUrl
      if (!/^https?:\/\//i.test(url)) {
        setFavOk(false)
        return
      }
      const host = new URL(url).hostname
      invoke<string[]>('fetch_site_icons', { host })
        .then((list) => {
          if (cancelled) return
          if (!list || list.length === 0) {
            setFavOk(false)
            return
          }
          setFavSources(list)
          setFavIdx(0)
        })
        .catch(() => {
          if (!cancelled) setFavOk(false)
        })
    } catch {
      setFavOk(false)
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.uid])

  // 第二步：预加载探测候选图标，成功才切换显示（避免加载中白块 / 缩写闪烁）
  useEffect(() => {
    if (favSources.length === 0) return
    let cancelled = false
    const img = new Image()
    img.referrerPolicy = 'no-referrer'
    const tryNext = () => {
      if (cancelled) return
      if (favIdx < favSources.length - 1) setFavIdx(favIdx + 1)
      else setFavOk(false)
    }
    img.onload = () => {
      if (!cancelled && img.naturalWidth > 0) setFavOk(true)
      else tryNext()
    }
    img.onerror = tryNext
    img.src = favSources[favIdx]
    return () => {
      cancelled = true
    }
  }, [favSources, favIdx])

  // —— 计费方案 ——
  const plans = entryPlans(entry.config)
  const primary = entryPrimaryPlan(entry.config)
  const otherPlans = plans.filter((p) => p !== primary)
  const multi = plans.length > 1

  // 分方案数据：适配器返回 plans 时用 plans；否则单份数据视为「按量余额」方案的数据
  // （余额接口天然是 paygo 语义）。主卡只显示所选方案的数据，取不到就占位，不拿整体数据顶替。
  const planData: Record<string, QuotaInfo> | undefined = info?.plans ?? (info ? { paygo: info } : undefined)
  const mainInfo = planData?.[primary]

  // 信息性无数据（ok=false 且无值，如「无套餐订阅」）→ 中性灰 ○；真失败（ok=false 有值或报错）→ 红 ❌
  const noData =
    !!mainInfo &&
    !mainInfo.ok &&
    (mainInfo.remaining === null || mainInfo.remaining === undefined) &&
    (mainInfo.total === null || mainInfo.total === undefined)
  const statusKey = refreshing ? 'busy' : !mainInfo || noData ? 'idle' : mainInfo.ok ? 'ok' : 'err'
  // 状态只保留 emoji（合并到方案标签旁显示），文字由 title 悬浮提示承担
  const statusEmoji = refreshing ? '⚠️' : !mainInfo || noData ? '○' : mainInfo.ok ? '✅' : '❌'
  const statusTip = !mainInfo ? '' : mainInfo.ok || noData ? '' : mainInfo.message
  const detail = mainInfo
    ? mainInfo.ok
      ? mainInfo.extra || (mainInfo.message && mainInfo.message !== 'ok' ? mainInfo.message : '')
      : noData
        ? ''
        : mainInfo.message
    : ''

  // DeepSeek 官方站的左下角文字：距下一时段切换的倒计时（如「1小时20分钟→谷」）
  const isDeepSeek = entry.providerId === 'deepseek_official'
  const bottomText = isDeepSeek && dsPeak ? dsCountdown : detail

  // 打开官网：仅 Windows 端支持点击站名/图标进入；Android 端移入操作弹窗（按钮）
  const showOpenSite =
    !isAndroidPlatform() && Boolean(provider?.websiteUrl || provider?.getWebsiteUrl?.(entry.config))

  const handleOpenSite = () => {
    const url = provider?.getWebsiteUrl
      ? provider.getWebsiteUrl(entry.config)
      : provider?.websiteUrl ?? ''
    if (/^https?:\/\//i.test(url)) {
      openUrl(url)
    }
  }

  // 拖拽排序（dnd-kit）
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.uid,
  })
  const dragStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    // 拖动时保持高亮（不虚隐）：不透明 + 浮起投影 + 轻微放大 + 提升到最上层
    ...(isDragging
      ? {
          opacity: 1,
          boxShadow: '0 12px 28px rgba(0, 0, 0, 0.22)',
          scale: '1.02',
          position: 'relative' as const,
          zIndex: 1000,
        }
      : {}),
  }

  return (
    <div
      className={`site-card ${entered ? 'entered' : ''} ${isAndroidPlatform() && onOpenActions ? 'card-clickable' : ''}`}
      ref={setNodeRef}
      style={dragStyle}
      {...attributes}
      {...listeners}
      onClick={
        isAndroidPlatform() && onOpenActions
          ? (e) => {
              // 避免点击内部操作元素时冒泡触发弹窗（安卓弹窗外部无卡内按钮，但站名打开网站等需排除）
              if ((e.target as HTMLElement).closest('.card-no-bubble')) return
              onOpenActions(entry)
            }
          : undefined
      }
      title={isAndroidPlatform() ? '点击查看操作 · 长按拖动排序' : undefined}
    >
      {/* 左侧内容 */}
      <div className="card-body">
        <div className="card-header">
          <span
            className={`provider-mark ${
              BRAND_ICON_PROVIDERS.has(entry.providerId) || (favSources.length > 0 && favOk === true)
                ? 'mark-neutral'
                : `mark-${accent}`
            } ${showOpenSite ? 'clickable card-no-bubble' : ''}`}
            title={showOpenSite ? '打开网站' : undefined}
            onClick={showOpenSite ? handleOpenSite : undefined}
            role={showOpenSite ? 'button' : undefined}
            aria-label={showOpenSite ? `打开 ${entry.displayName} 网站` : undefined}
          >
            {BRAND_ICON_PROVIDERS.has(entry.providerId) ? (
              <ProviderIcon providerId={entry.providerId} />
            ) : favSources.length > 0 && favOk === true ? (
              <img
                className="provider-favicon"
                src={favSources[favIdx]}
                alt=""
                width={20}
                height={20}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              mark
            )}
          </span>
          <div className="card-title-box">
            <span
              className={`card-name ${showOpenSite ? 'openable card-no-bubble' : ''}`}
              title={showOpenSite ? entry.displayName + '（点击打开网站）' : entry.displayName}
              onClick={showOpenSite ? handleOpenSite : undefined}
              role={showOpenSite ? 'button' : undefined}
            >
              {entry.displayName}
            </span>
            {entry.providerId === 'deepseek_official' && dsPeak && (
              <span
                className={`ds-peak ds-peak-${dsPeak}`}
                title={DEEPSEEK_PEAK_INFO[dsPeak].title}
              >
                {DEEPSEEK_PEAK_INFO[dsPeak].label}
              </span>
            )}
            {isOpenCodeGo && (
              <span className="go-badge" title="OpenCode Go 套餐用量（API Key）">
                Go
              </span>
            )}
          </div>
        </div>

        <div className="card-main">
          <PlanValue
            plan={primary}
            q={mainInfo}
            big
            statusEmoji={statusEmoji}
            statusKey={statusKey}
            statusTip={statusTip}
            statusText={refreshing ? '刷新中' : undefined}
          />
        </div>

        {bottomText && (
          <div className="card-detail" title={bottomText}>
            {isDeepSeek && dsPeak ? bottomText : multi ? `[${PLANS.find((p) => p.id === primary)?.label}] ${bottomText}` : bottomText}
          </div>
        )}
      </div>

      {/* 右侧操作按钮块（垂直居中）—— 仅 Windows：安卓端按钮已移入单击弹出的操作弹窗 */}
      {!isAndroidPlatform() && (
        <div className="card-side-actions">
          <div className="actions-row">
            <button
              className="card-btn refresh"
              onClick={() => onRefresh(entry)}
              disabled={refreshing}
              aria-label="刷新该站点"
            >
              <RefreshCw size={13} strokeWidth={2.2} /> 刷新
            </button>
            <button
              className="card-btn show tip"
              data-tip="打开鲸鱼娘挂件"
              onClick={() => onShow?.(entry)}
              disabled={!onShow}
              aria-label="展示窗口"
            >
              <Waves size={13} strokeWidth={2.2} /> 展示
            </button>
          </div>
          <div className="actions-row">
            <button className="card-btn edit" onClick={() => onEdit(entry)} aria-label="编辑站点">
              <Pencil size={13} strokeWidth={2.2} /> 编辑
            </button>
            <button className="card-btn danger" onClick={() => onDelete(entry)} aria-label="删除站点">
              <Trash2 size={13} strokeWidth={2.2} /> 删除
            </button>
          </div>
        </div>
      )}

      {/* —— 多方案收纳条 + 次级卡片：仅 Windows。安卓端已移入单击弹出的操作弹窗 —— */}
      {!isAndroidPlatform() && multi && (
        <div className={`plan-stack ${expanded ? 'open' : ''}`}>
          <button
            type="button"
            className="plan-stack-bar"
            onClick={(e) => {
              e.stopPropagation()
              setExpanded((v) => !v)
            }}
          >
            <span className="plan-stack-hint">
              {expanded ? '▾ 收起' : `⧉ 还有 ${otherPlans.length} 种方案`}
            </span>
            <span className="plan-stack-labels">
              {otherPlans.map((p) => (
                <span key={p} className={`plan-tag plan-tag-${p}`}>
                  {PLANS.find((x) => x.id === p)?.label ?? p}
                </span>
              ))}
            </span>
          </button>
          {expanded && (
            <div className="plan-subcards">
              {otherPlans.map((p) => {
                const q = planData?.[p]
                const subStatusKey = !q ? 'idle' : q.ok ? 'ok' : 'err'
                const subEmoji = !q ? '○' : q.ok ? '✅' : '❌'
                const subTip = q && !q.ok ? q.message : ''
                const isMain = p === primary
                return (
                  <div key={p} className={`plan-subcard ${isMain ? 'is-main' : ''}`}>
                    <PlanValue
                      plan={p}
                      q={q}
                      statusEmoji={subEmoji}
                      statusKey={subStatusKey}
                      statusTip={subTip}
                    />
                    {q?.extra ? (
                      <div className="plan-subcard-detail" title={q.extra}>
                        {q.extra}
                      </div>
                    ) : null}
                    {isMain ? (
                      <span className="plan-main-badge">当前展示</span>
                    ) : (
                      onSetPrimary && (
                        <button
                          type="button"
                          className="plan-set-main"
                          onClick={(e) => {
                            e.stopPropagation()
                            onSetPrimary(entry.uid, p)
                            setExpanded(false)
                          }}
                        >
                          展示
                        </button>
                      )
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
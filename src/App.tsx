// 主窗口：Apple 风格（极光背景 + Bento 网格 + 玻璃卡片）—— 阶段 2

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove } from '@dnd-kit/sortable'
import './styles/theme.css'
import './app.css'
import AuroraBackground from './components/AuroraBackground'
import ConfirmDialog from './components/ConfirmDialog'
import PlanFilterDialog from './components/PlanFilterDialog'
import SettingsDialog from './components/SettingsDialog'
import SiteCard from './components/SiteCard'
import SiteActionsDialog from './components/SiteActionsDialog'
import Toast, { type ToastData } from './components/Toast'
import SiteDialog from './components/SiteDialog'
import SyncDialog from './components/SyncDialog'
import { getConfig, removeProvider, saveConfig, upsertProvider, type AppConfig, type ProviderEntry, type AutoWidgetMode } from './lib/store'
import { autoWidgetMode, pickAutoOpenUid } from './lib/autoWidget'
import { mergeProviders } from './lib/sync'
import { fetchEntry } from './lib/worker'
import { recordUsageBaseline } from './lib/usage'
import { buildPetPayload, nextPetUid, petPeakTickMs, pickPetUid } from './lib/petOverlay'
import { applyTheme, watchSystemTheme, type ThemeChoice } from './lib/theme'
import { fmtCount, fmtMoney, fmtDuration } from './lib/fmt'
import { PLANS, entryPlans } from './lib/plans'
import type { PlanId } from './lib/plans'
import { PROVIDERS } from './providers/registry'
import type { QuotaInfo } from './providers/types'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Loader2, Plus, RefreshCw, Search, Settings, Tags, Upload } from 'lucide-react'

const APP_TITLE = 'API余额通'
const AUTO_TICK_MS = 30_000

/** 安卓端判定（与 SiteDialog/SiteCard 同口径）：挂件窗等桌面端能力据此跳过 */
function isAndroidPlatform(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
}

export default function App() {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [results, setResults] = useState<Record<string, QuotaInfo>>({})
  const [refreshingAll, setRefreshingAll] = useState(false)
  const [refreshingUids, setRefreshingUids] = useState<Set<string>>(new Set())
  const [theme, setTheme] = useState<ThemeChoice>('light')
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<{ mode: 'add' } | { mode: 'edit'; entry: ProviderEntry } | null>(null)
  // 打开添加/编辑弹窗时主窗口置顶（弹窗操作期间不被其它窗口遮挡）；
  // 关闭弹窗后恢复正常层级。弹窗打开时若存在启动竞态残留的置顶标志也会被顺带修正。
  useEffect(() => {
    void getCurrentWindow().setAlwaysOnTop(Boolean(dialog))
  }, [dialog])
  const [confirmDelete, setConfirmDelete] = useState<ProviderEntry | null>(null)
  // 安卓端：单击卡片打开的操作弹窗（按钮 + 全部计费方案）
  const [actionsEntry, setActionsEntry] = useState<ProviderEntry | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  const [planFilter, setPlanFilter] = useState<string[]>([])
  const [planFilterOpen, setPlanFilterOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Toast：轻量操作反馈（保存/删除/同步成功失败），2.4s 自动消失
  const [toast, setToast] = useState<ToastData | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = (kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2400)
  }
  const [overview, setOverview] = useState({ ok: 0, fail: 0 })
  // —— 安卓端「鲸鱼娘桌宠」（系统悬浮窗）：状态一律**向 Rust 查**，不做本地 toggle 缓存 ——
  // 桌宠可以被它自己的原生菜单关掉（或它的缩放/拖动改变几何），本地缓存一定会和真实状态走散；
  // 每次点击都查一次是最省事且不会错的做法（一次 IPC，代价可忽略）。
  const [petSupported, setPetSupported] = useState(false)
  const [petPermitted, setPetPermitted] = useState(false)
  const [petShowing, setPetShowing] = useState(false)
  const [petBusy, setPetBusy] = useState(false)
  // 刷新序号：丢弃陈旧请求的结果（编辑保存 vs 旧配置自动刷新的竞态）
  const refreshSeq = useRef(0) // 全部刷新的批次序号
  // 单站刷新的序号（按 uid 隔离，避免不同站点并发刷新互相丢弃结果）
  const refreshSeqByUid = useRef<Record<string, number>>({})
  const bumpUidSeq = (uid: string) =>
    (refreshSeqByUid.current[uid] = (refreshSeqByUid.current[uid] ?? 0) + 1)
  // 最近刷新时间戳放 ref：轮询定时器常驻不重建，避免 tick 漂移
  const lastRefreshRef = useRef<Record<string, number>>({})
  // 拖拽排序传感器：平台区分激活方式
  // - Android：长按 250ms 后触发（触屏需与滚动/点击区分，位移容差 8px）
  // - 桌面：按住移动即拖（distance 8px 激活）——历史 bug：delay 250ms 在鼠标上
  //   要求按下后静止 250ms 不动，用户"按住就拖"在 250ms 内置内位移必超容差，
  //   被当作点击取消，导致拖拽从未激活（"拖动不生效"）
  const isAndroid = document.documentElement.dataset.platform === 'android'
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isAndroid
        ? { delay: 250, tolerance: 8 }
        : { distance: 8 },
    }),
  )

  // 可见站点（按搜索 + 方案筛选过滤；搜索与方案为 AND 关系）
  // 多方案语义：站点支持的方式里「任意一个」命中筛选即显示
  const visibleEntries = useMemo(() => {
    if (!cfg) return []
    const q = search.trim().toLowerCase()
    const hasPlanFilter = planFilter.length > 0
    return cfg.providers.filter((e) => {
      if (q) {
        const p = PROVIDERS.find((p) => p.id === e.providerId)
        const hit =
          e.displayName.toLowerCase().includes(q) || (p?.name ?? '').toLowerCase().includes(q)
        if (!hit) return false
      }
      // 缺失 billingPlan/plans 的站点视为按量余额（entryPlans 兜底）
      if (hasPlanFilter && !entryPlans(e.config).some((pid) => planFilter.includes(pid))) return false
      return true
    })
  }, [cfg, search, planFilter])

  // 各计费方案的站点数（多方案站点每个支持方案各计一次；供筛选弹窗计数显示）
  const planCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of PLANS) counts[p.id] = 0
    for (const e of cfg?.providers ?? []) {
      for (const plan of entryPlans(e.config)) {
        counts[plan] = (counts[plan] ?? 0) + 1
      }
    }
    return counts
  }, [cfg])

  // 拖拽排序结束：重排 providers 并持久化
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!cfg) return
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = visibleEntries.findIndex((e) => e.uid === active.id)
      const newIndex = visibleEntries.findIndex((e) => e.uid === over.id)
      if (oldIndex < 0 || newIndex < 0) return
      // 可见列表重排后的 uid 顺序
      const newVisibleUids = arrayMove(
        visibleEntries.map((e) => e.uid),
        oldIndex,
        newIndex,
      )
      // 重建 providers：可见项按新序，未过滤的其余项保持原相对顺序
      const visibleSet = new Set(newVisibleUids)
      const rest = cfg.providers.filter((p) => !visibleSet.has(p.uid))
      const byUid = new Map(cfg.providers.map((p) => [p.uid, p]))
      const newProviders = [
        ...newVisibleUids.map((uid) => byUid.get(uid)).filter((p): p is ProviderEntry => Boolean(p)),
        ...rest,
      ]
      const next = { ...cfg, providers: newProviders }
      setCfg(next)
      saveConfig(next).catch((e) => console.error('保存排序失败：', e))
    },
    [cfg, visibleEntries],
  )

  // —— 初始化：加载配置 + 主题 + 壁纸 ——
  useEffect(() => {
    getConfig()
      .then((c) => {
        setCfg(c)
        const t = (c.theme as ThemeChoice) || 'light'
        setTheme(t)
        applyTheme(t)
        // 壁纸：aurora（默认）/ plain / custom（旧 anime 配置自动映射为 aurora）
        const rawWp = c.wallpaper || 'aurora'
        const wp = rawWp === 'anime' ? 'aurora' : rawWp
        document.documentElement.dataset.wallpaper = wp
        if (wp === 'custom' && c.wallpaperFile) {
          document.documentElement.style.setProperty(
            '--custom-wallpaper-url',
            `url("${convertFileSrc(c.wallpaperFile)}")`,
          )
        }
      })
      .catch((e) => console.error('加载配置失败：', e))
  }, [])

  useEffect(() => {
    applyTheme(theme)
    // 跟随系统时监听系统主题变化
    if (theme === 'system') {
      return watchSystemTheme((dark) => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      })
    }
  }, [theme])

  // —— 刷新 ——
  // 保存适配器返回的探测缓存（如自动识别站点的登录接口/余额来源），写回 config 供后续复用
  const persistDetected = useCallback(async (entry: ProviderEntry, info: QuotaInfo) => {
    if (!info.detectedConfig || Object.keys(info.detectedConfig).length === 0) return
    const merged = { ...entry.config, ...info.detectedConfig }
    try {
      const next = await upsertProvider({ ...entry, config: merged })
      setCfg(next)
    } catch (e) {
      console.error('保存探测缓存失败：', e)
    }
  }, [])

  // —— 桌宠数据推送（P1）：主界面每轮刷新后，把「当前展示的那个站点」的四行文字推给悬浮层 ——
  // 设计要点：**不新增任何数据通路** —— 用的仍是主界面已有的 results（resultsRef）+ 当日账本
  // （config.usageBaselines），只是把它们折算成文字推过去（折算规则全在 lib/petOverlay.ts，
  // 与桌面挂件同一批函数）。安卓原生层只负责画字符串，因此两端数字不可能不一致。
  const petShowingRef = useRef(false)
  const petUidRef = useRef<string | null>(null)

  /**
   * 组装并推送桌宠文字。
   * `freshBaseline=true` 时先回读一次配置：刚用 recordUsageBaseline 写过观测账本，
   * 「今日已用」要用**写完之后**的值（否则这一轮会推出上一轮的数字）。
   */
  const pushPet = useCallback(async (uid?: string, freshBaseline = false) => {
    if (!isAndroidPlatform() || !petShowingRef.current) return
    const targetUid = uid ?? petUidRef.current ?? pickPetUid(cfgRef.current)
    if (!targetUid) return
    const entry = cfgRef.current?.providers.find((p) => p.uid === targetUid)
    if (!entry) return
    let baseline = cfgRef.current?.usageBaselines?.[targetUid]
    if (freshBaseline) {
      try {
        baseline = (await getConfig()).usageBaselines?.[targetUid]
      } catch (e) {
        console.error('桌宠回读当日记录失败：', e)
      }
    }
    try {
      const r = await invoke<{ ok: boolean }>('overlay_update', {
        payload: buildPetPayload(entry, resultsRef.current[targetUid], baseline),
      })
      // 桌宠可能已被它自己那份原生菜单关掉（那条路径不经过前端）→ 顺带自愈前端状态，
      // 免得按钮一直显示「关闭桌宠」而实际什么都没有
      if (!r.ok) {
        petShowingRef.current = false
        setPetShowing(false)
      }
    } catch (e) {
      console.error('推送桌宠数据失败：', e)
    }
  }, [])

  // 结果落库：更新界面 + 同步到 Rust 侧缓存（挂件打开时直接复用，不再重复网络请求）
  // resultsRef：同步镜像，供失败保留逻辑读取「上次成功结果」
  const resultsRef = useRef<Record<string, QuotaInfo>>({})
  const commitResult = useCallback((uid: string, info: QuotaInfo) => {
    resultsRef.current = { ...resultsRef.current, [uid]: info }
    setResults((prev) => ({ ...prev, [uid]: info }))
    void invoke('widget_set_result', { uid, info }).catch(() => {})
    // 「今日已用」当日基准：所有成功结果都经这里落库，故在此统一上报（Rust 侧当天只记第一次，
    // 之后调用是无副作用的 no-op）。失败/无值/配额百分比站点会被 recordUsageBaseline 自行跳过。
    void recordUsageBaseline(uid, info).then(() => {
      // 账本写完再推桌宠：正显示这个站点时把新数字送过去（每轮刷新都会走到）
      if (uid === petUidRef.current) void pushPet(uid, true)
    })
  }, [pushPet])

  // 清除缓存（站点配置变更/删除时调用，避免挂件显示过期数据）
  const clearResultCache = useCallback((uid: string) => {
    void invoke('widget_set_result', { uid, info: null }).catch(() => {})
  }, [])

  const refreshOne = useCallback(
    async (entry: ProviderEntry) => {
      const seq = bumpUidSeq(entry.uid)
      setRefreshingUids((prev) => new Set(prev).add(entry.uid))
      try {
        const info = await fetchEntry(entry)
        if (seq !== refreshSeqByUid.current[entry.uid]) return // 该站点已有更新的刷新，丢弃陈旧结果
        // 失败且无值（如接口限流/临时网络错误）：保留上次成功数值显示（识别为 0 就继续显示 0，
        // 不闪横线），状态保持失败（❌）以便从悬浮提示看到失败原因；
        // 从未成功过（无上次值）时照常显示失败横线
        if (!info.ok && info.remaining == null && info.total == null) {
          const prev = resultsRef.current[entry.uid]
          if (prev?.ok && (prev.remaining != null || prev.total != null)) {
            commitResult(entry.uid, { ...info, remaining: prev.remaining, total: prev.total })
            lastRefreshRef.current = { ...lastRefreshRef.current, [entry.uid]: Date.now() }
            return
          }
        }
        commitResult(entry.uid, info)
        lastRefreshRef.current = { ...lastRefreshRef.current, [entry.uid]: Date.now() }
        if (!info.ok) return
        await persistDetected(entry, info)
      } finally {
        // 仅当此请求仍是该站点的活跃请求时清理 busy 状态
        if (seq === refreshSeqByUid.current[entry.uid]) {
          setRefreshingUids((prev) => {
            const next = new Set(prev)
            next.delete(entry.uid)
            return next
          })
        }
      }
    },
    [persistDetected, commitResult],
  )

  const refreshAllSites = useCallback(async () => {
    if (!cfg || cfg.providers.length === 0) return
    const seq = ++refreshSeq.current
    const entries = cfg.providers.filter((p) => p.enabled)
    // 作废各站点的在途单站请求（全部刷新接管）
    for (const e of entries) bumpUidSeq(e.uid)
    setRefreshingAll(true)
    let done = 0
    // 逐个刷新、完成即显示：不用 Promise.all 一次性返回，
    // 否则所有站点结果要等最慢站点（默认 30s 超时）完成才显示
    for (const e of entries) {
      void (async () => {
        // 站点粒度刷新状态：该站点完成立即显示数据，不被全局 refreshingAll 覆盖
        setRefreshingUids((prev) => new Set(prev).add(e.uid))
        try {
          const info = await fetchEntry(e)
          if (seq !== refreshSeq.current) return // 丢弃陈旧批次（新批次自己管理状态）
          commitResult(e.uid, info)
          const now = Date.now()
          lastRefreshRef.current = { ...lastRefreshRef.current, [e.uid]: now }
          if (info.ok) await persistDetected(e, info)
        } catch (err) {
          console.error('刷新失败：', err)
        } finally {
          done += 1
          setRefreshingUids((prev) => {
            const next = new Set(prev)
            next.delete(e.uid)
            return next
          })
          // 只有当前批次仍是活跃批次时才复位，避免误关新批次的状态
          if (seq === refreshSeq.current && done === entries.length) {
            setRefreshingAll(false)
          }
        }
      })()
    }
  }, [cfg, commitResult, persistDetected])

  // 启动后自动刷新一次（仅首次加载触发，cfg 后续变化不重复全刷）
  const bootedRef = useRef(false)
  useEffect(() => {
    if (!cfg || bootedRef.current) return
    bootedRef.current = true
    // 先恢复 Rust 侧上次结果缓存（上次成功识别的数值，含 0），
    // 卡片启动即有值（不闪横线），随后 900ms 的全量刷新再更新为最新
    invoke<Record<string, QuotaInfo>>('widget_get_all_results')
      .then((cached) => {
        for (const [uid, info] of Object.entries(cached ?? {})) {
          if (info && typeof info === 'object') commitResult(uid, info as QuotaInfo)
        }
      })
      .catch(() => {})
    if (cfg.providers.length > 0) {
      const t = setTimeout(() => refreshAllSites(), 900)
      return () => clearTimeout(t)
    }
  }, [cfg, refreshAllSites, commitResult])

  // 「自动打开鲸鱼娘窗口」：启动时自动打开鲸鱼娘挂件窗（设置页开关，仅桌面端）
  // —— 只在首次加载判定一次；延迟 1200ms 让主界面的启动全刷先发出，
  //    这样挂件打开时能直接复用已缓存的结果（否则会显示「点击任意位置刷新」）
  // ⚠️ 依赖必须是 `[]` + 从 ref 读配置（2026-09/15 实测踩坑）：若写成依赖 `[cfg]`，
  //    挂件还没打开时 `cfg` 就会被后续动作改掉（写入当日基准/探测缓存 → setCfg），
  //    React 在 cleanup 里 `clearTimeout` 把这颗定时器取消 → **挂件永远打不开**，
  //    且表现为"开关没反应"而非报错。诊断手段：`#__aqm_autoopen` 标记（probe measure 可读）。
  const cfgRef = useRef<AppConfig | null>(null)
  cfgRef.current = cfg
  const autoWidgetDoneRef = useRef(false)
  useEffect(() => {
    let disposed = false
    // 诊断标记（dev）：探针 measure `#__aqm_autoopen` 可读其 textContent
    const mark = (s: string) => {
      if (!import.meta.env.DEV) return
      let el = document.getElementById('__aqm_autoopen')
      if (!el) {
        el = document.createElement('i')
        el.id = '__aqm_autoopen'
        el.style.cssText = 'position:fixed;left:-9999px;top:0'
        document.body.appendChild(el)
      }
      el.textContent = s
    }
    const t = setTimeout(() => {
      if (disposed || autoWidgetDoneRef.current) return
      autoWidgetDoneRef.current = true
      const c = cfgRef.current
      if (!c) {
        mark('skip:cfg-null')
        return
      }
      if (isAndroidPlatform()) {
        // 安卓端的「桌宠模式」= 系统悬浮窗（§4.11）。设置项文案本来就是「启动时自动打开桌宠模式」，
        // 此前这里直接 skip（安卓端没实现挂件），现在接到桌宠上：沿用**同一套**站点选择纯函数
        // （autoWidgetMode / pickAutoOpenUid），模式为「关闭自动」时不打开。
        const mode = autoWidgetMode(c)
        if (mode === 'off') {
          mark('skip:android-off')
          return
        }
        const uid = pickAutoOpenUid(c)
        if (!uid) {
          mark('skip:no-provider')
          return
        }
        mark(`pet-open:${mode}:uid=${uid}`)
        void openPet(uid, { silent: true })
          .then((ok) => mark(ok ? `pet-ok:uid=${uid}` : 'pet-skip:no-permission'))
          .catch((e) => {
            mark(`pet-error:${String(e)}`)
            console.error('启动自动打开桌宠失败：', e)
          })
        return
      }
      // 站点选择与模式判定都在纯函数里（lib/autoWidget.ts，有单测）：
      //   关闭自动 → 不打开；上次站点 → lastWidgetUid；置顶站点 → 列表第一张卡
      const mode = autoWidgetMode(c)
      const uid = pickAutoOpenUid(c)
      if (!uid) {
        mark(mode === 'off' ? 'skip:off' : 'skip:no-provider')
        return
      }
      mark(`invoking:${mode}:uid=${uid}`)
      invoke('open_widget', { uid })
        .then(() => mark(`ok:uid=${uid}`))
        .catch((e) => {
          mark(`error:${String(e)}`)
          console.error('启动自动打开挂件失败：', e)
        })
    }, 1200)
    return () => {
      disposed = true
      clearTimeout(t)
    }
  }, [])

  // —— 仅 dev 的调试钩子：URL 带 `?settings=1` / `?sync=1` 时自动打开对应弹窗 ——
  // 用途：这些弹窗的排版改动需要能量测（probe 的元素量测/点击要窗口处于可见状态），
  // 而它们平时只能手点 ⚙️ / 导出·导入 打开。`import.meta.env.DEV` 在生产构建中被静态求值为 false，
  // 整段会被摇树移除（与 probe 的 apply:'serve' 同思路，见交接文档 §4.10）。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const q = new URLSearchParams(location.search)
    if (q.get('settings') === '1') {
      setSettingsOpen(true)
    }
    if (q.get('sync') === '1') {
      setSyncOpen(true)
    }
  }, [])

  // —— 自动刷新轮询（30s tick 常驻，读取 ref 中的最近刷新时间）——
  // 抽成回调是因为**后台也要用它**：主应用切后台后 Chromium 会停掉页面的 JS 定时器，
  // 桌宠那边用原生定时器每分钟把 JS「戳一下」（见 PetOverlay.pokeRunnable），
  // 戳的就是这个 tick —— 判断"哪些站点该刷了"的口径仍只有这一份。
  const tickDueRefreshes = useCallback(() => {
    const c = cfgRef.current
    if (!c) return
    const now = Date.now()
    const lr = lastRefreshRef.current
    for (const e of c.providers) {
      if (!e.enabled) continue
      const interval = e.autoRefreshMinutes > 0 ? e.autoRefreshMinutes : c.autoRefreshMinutes
      if (interval <= 0) continue
      if (now - (lr[e.uid] ?? 0) >= interval * 60_000) {
        refreshOne(e)
      }
    }
  }, [refreshOne])

  useEffect(() => {
    const timer = setInterval(() => tickDueRefreshes(), AUTO_TICK_MS)
    return () => clearInterval(timer)
  }, [tickDueRefreshes])

  // —— 概览统计 ——
  useEffect(() => {
    if (!cfg) return
    let ok = 0
    let fail = 0
    for (const e of cfg.providers) {
      const info = results[e.uid]
      if (!info) continue
      if (info.ok) ok += 1
      else fail += 1
    }
    setOverview({ ok, fail })
  }, [cfg, results])

  const totalByCurrency = useMemo(() => {
    const totals: Record<string, number> = {}
    if (!cfg) return totals
    for (const e of cfg.providers) {
      const info = results[e.uid]
      if (!info?.ok) continue
      const v = info.remaining ?? info.total
      if (v === null || v === undefined || !Number.isFinite(v)) continue
      const c = (info.currency || 'CNY').toUpperCase()
      // 配额百分比（如 OpenCode Go 用量 %）不是金额，不计入「可用总额」
      if (c === '%') continue
      totals[c] = (totals[c] ?? 0) + v
    }
    return totals
  }, [cfg, results])

  // —— 站点操作 ——
  const handleSave = async (entry: ProviderEntry) => {
    try {
      const next = await upsertProvider(entry)
      setCfg(next)
      setDialog(null)
      setResults((prev) => {
        const copy = { ...prev }
        delete copy[entry.uid] // 配置已变，旧结果作废
        return copy
      })
      clearResultCache(entry.uid)
      showToast('ok', `已保存「${entry.displayName}」`)
      void refreshOne(entry) // 刷新后台进行，不阻塞保存反馈
    } catch (e) {
      setDialog(null)
      console.error('保存失败：', e)
      showToast('err', '保存失败，请重试')
    }
  }

  const handleDelete = async (entry: ProviderEntry) => {
    try {
      const next = await removeProvider(entry.uid)
      setCfg(next)
      setResults((prev) => {
        const copy = { ...prev }
        delete copy[entry.uid]
        return copy
      })
      clearResultCache(entry.uid)
      showToast('ok', `已删除「${entry.displayName}」`)
    } catch (e) {
      console.error('删除失败：', e)
      showToast('err', '删除失败，请重试')
    } finally {
      setConfirmDelete(null)
    }
  }

  // 鲸鱼娘挂件（阶段 3）：打开独立置顶小窗展示单站点余额
  const handleShow = async (entry: ProviderEntry) => {
    try {
      await invoke('open_widget', { uid: entry.uid })
      // 记住这次打开的站点：「自动打开鲸鱼娘窗口」下次启动时还原它（写失败不影响打开动作）
      if (cfg) {
        const next = { ...cfg, lastWidgetUid: entry.uid }
        setCfg(next)
        saveConfig(next).catch((e) => console.error('记录挂件站点失败：', e))
      }
    } catch (e) {
      console.error('打开挂件失败：', e)
    }
  }

  // ══ 鲸鱼娘桌宠（安卓端**系统悬浮窗**，2026-09/19，方案 1）══
  // 桌面端的「🐳 展示」= 独立置顶小窗（open_widget，复用 index.html）；
  // 安卓端只有一个 WebView 窗口（没有第二个窗口可用），对应能力是**系统悬浮窗**：
  // 用 TYPE_APPLICATION_OVERLAY 把鲸鱼娘盖在所有 App 之上，入口因此是全局的、不是卡片级的。
  // （`petUidRef` / `petShowingRef` / `pushPet` 在文件上方「桌宠数据推送」一段里声明——
  //   那里要能被 commitResult 引用，所以位置比这一节更早。）

  /** 查桌宠真实状态（平台支持 / 特殊授权 / 是否在显示）——一律问 Rust，不做本地缓存 */
  const refreshPetState = useCallback(async () => {
    if (!isAndroidPlatform()) return
    try {
      const st = await invoke<{ supported: boolean; permitted: boolean; showing: boolean }>('overlay_status')
      setPetSupported(st.supported)
      setPetPermitted(st.permitted)
      setPetShowing(st.showing)
      // 显示着但前端不知道是哪个站点（例如 WebView 重载后）：按默认站点补齐，
      // 否则刷新推送会因为 uid 为空而静默停掉
      if (st.showing && !petUidRef.current) petUidRef.current = pickPetUid(cfgRef.current)
    } catch (e) {
      console.error('查询桌宠状态失败：', e)
    }
  }, [])

  useEffect(() => {
    void refreshPetState()
  }, [refreshPetState])

  // petShowing 的同步镜像：pushPet 要在**不重建回调**的前提下读到最新值（IPC 里被调用得很频繁）
  useEffect(() => {
    petShowingRef.current = petShowing
  }, [petShowing])

  // 峰谷倒计时刷新：按与主卡片/挂件**同一阈值**推（< 2 小时每秒，否则 10 秒）。
  //
  // ⚠️ 用**自调度 setTimeout** 而不是固定 setInterval（2026-09/19 实测踩到）：阈值是**随时间变化**的，
  //    固定间隔会在跨过 2 小时边界后继续按旧节奏推 —— 那时文案已经带秒，却是 10 秒才更新一次，
  //    秒数"跳着走"（实测：把设备时钟调到距切换 2 分钟，两张隔 3 秒的截图**逐字节相同**）。
  //    自调度 = 每推完一次都重新算 petPeakTickMs，换挡自然发生。
  // ⚠️ 依赖里**不放 cfg**（用 cfgRef 读）：cfg 会随每次落盘换引用，那样定时器会被反复重建；
  //    非 DeepSeek 站点没有会变的行 → 用一个 30 秒的空转间隔活着，这样菜单切到 DeepSeek 站时
  //    下一次 tick 就能自己换挡（否则切站后倒计时永远不动）。
  useEffect(() => {
    if (!petShowing) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const tick = () => {
      if (disposed) return
      void pushPet().finally(() => {
        if (disposed) return
        const entry = cfgRef.current?.providers.find((p) => p.uid === (petUidRef.current ?? ''))
        const ms = entry ? petPeakTickMs(entry.providerId) : 0
        timer = setTimeout(tick, ms > 0 ? ms : 30_000)
      })
    }
    timer = setTimeout(tick, 1000)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [petShowing, pushPet])

  /**
   * 桌宠**原生菜单**的动作（Kotlin 通过 `evaluateJavascript` 调 `window.__aqmPetAction`）。
   * 为什么走这条路：站名/余额/当日账本/站点列表全在前端，原生层不认识它们 ——
   * 菜单只负责"说出用户想干什么"，口径一律回前端执行（与「口径唯一」同一原则）。
   */  const handlePetAction = useCallback(
    async (action: string) => {
      const currentUid = petUidRef.current ?? pickPetUid(cfgRef.current)
      if (!currentUid) return
      if (action === 'nextSite') {
        const next = nextPetUid(cfgRef.current, currentUid)
        if (!next) return
        petUidRef.current = next
        const nextEntry = cfgRef.current?.providers.find((p) => p.uid === next) ?? null
        // 先把这一站的旧数字/占位推过去（立即有反馈），再触发一次刷新补最新值
        await pushPet(next)
        if (nextEntry) void refreshOne(nextEntry)
        const c = cfgRef.current
        if (c) {
          const updated = { ...c, lastWidgetUid: next }
          setCfg(updated)
          saveConfig(updated).catch((e) => console.error('记录桌宠站点失败：', e))
        }
        return
      }
      if (action === 'refresh') {
        const entry = cfgRef.current?.providers.find((p) => p.uid === currentUid) ?? null
        if (entry) void refreshOne(entry)
        return
      }
      // 桌宠显示期间由**原生侧**每分钟戳一次（见 PetOverlay.pokeRunnable）：
      // 主应用切后台后 JS 定时器会被 Chromium 停掉，但被戳醒的脚本照样能跑 —— 于是
      // "哪些站点该刷了"仍由前端这套判断决定，后台数据不会一直停着。
      if (action === 'tick') {
        tickDueRefreshes()
      }
    },
    [pushPet, refreshOne, tickDueRefreshes],
  )

  useEffect(() => {
    if (!isAndroidPlatform()) return
    const w = window as unknown as { __aqmPetAction?: (action: string) => void }
    w.__aqmPetAction = (action: string) => void handlePetAction(action)
    return () => {
      delete w.__aqmPetAction
    }
  }, [handlePetAction])

  // 位置/大小记忆：拖动与缩放是在**原生把手/菜单**里改的（前端不知情），故桌宠显示期间定期
  // 把几何落盘（关闭时 Rust 侧也会存一次兜底）。15 秒一次 = 用户拖完最多 15 秒内落盘，
  // 比"只在关闭时保存"稳（应用被系统杀掉也不丢）。
  useEffect(() => {
    if (!petShowing) return
    const save = () => void invoke('overlay_save_geometry').catch(() => {})
    save()
    const timer = setInterval(save, 15_000)
    return () => clearInterval(timer)
  }, [petShowing])

  /**
   * 打开桌宠并切到指定站点（供「🐳 桌宠」按钮与「启动时自动打开桌宠模式」共用）。
   * 返回 false = 没打开（无授权 / 平台不支持 / 被静默跳过）。`silent` = 启动自动打开时不要弹 toast。
   */
  const openPet = useCallback(
    async (uid: string, opts: { silent?: boolean } = {}): Promise<boolean> => {
      const c = cfgRef.current
      const entry = c?.providers.find((p) => p.uid === uid) ?? null
      if (!entry) return false
      const st = await invoke<{ supported: boolean; permitted: boolean; showing: boolean }>('overlay_status')
      setPetSupported(st.supported)
      setPetPermitted(st.permitted)
      if (!st.supported) {
        if (!opts.silent) showToast('err', '当前平台没有桌宠悬浮窗')
        return false
      }
      // 悬浮窗是**特殊授权**（不能弹窗申请）→ 跳系统设置页；该页永远回"取消"，
      // 所以结果只能靠回读权限状态（Rust/Kotlin 已处理），这里只看 granted。
      if (!st.permitted) {
        if (opts.silent) return false // 启动自动打开时不打断用户（按钮路径才引导授权）
        showToast('ok', '请在系统页面打开「允许显示在其他应用上层」')
        const p = await invoke<{ granted: boolean; message: string }>('overlay_request_permission')
        setPetPermitted(p.granted)
        if (!p.granted) {
          showToast('err', p.message)
          return false
        }
      }
      petUidRef.current = entry.uid
      await invoke('overlay_open', {
        payload: buildPetPayload(entry, resultsRef.current[entry.uid], c?.usageBaselines?.[entry.uid]),
      })
      setPetShowing(true)
      // 记住这次展示的站点：与桌面挂件共用 lastWidgetUid，下次打开还是它（写失败不影响打开）
      if (c) {
        const next = { ...c, lastWidgetUid: entry.uid }
        setCfg(next)
        saveConfig(next).catch((e) => console.error('记录桌宠站点失败：', e))
      }
      if (!opts.silent) showToast('ok', '桌宠已打开：拖把手可移动，点/长按把手出菜单')
      return true
    },
    [],
  )

  /** 打开／关闭桌宠（按钮只做一件事：切到相反状态；真实状态每次都现查） */
  const handlePetToggle = async () => {
    if (petBusy || !cfg) return
    setPetBusy(true)
    try {
      const st = await invoke<{ supported: boolean; permitted: boolean; showing: boolean }>('overlay_status')
      setPetSupported(st.supported)
      setPetPermitted(st.permitted)
      if (!st.supported) {
        showToast('err', '当前平台没有桌宠悬浮窗')
        return
      }
      if (st.showing) {
        await invoke('overlay_close')
        setPetShowing(false)
        showToast('ok', '桌宠已关闭')
        return
      }
      const uid = pickPetUid(cfg)
      if (!uid) {
        showToast('err', '先添加一个站点，桌宠才有余额可显示')
        return
      }
      await openPet(uid)
    } catch (e) {
      console.error('切换桌宠失败：', e)
      showToast('err', String(e))
    } finally {
      setPetBusy(false)
    }
  }

  // 切换主显示方案：更新站点 primaryPlan 并持久化（次级卡片上「设为主卡」）
  const handleSetPrimary = async (uid: string, plan: PlanId) => {
    if (!cfg) return
    const next: AppConfig = {
      ...cfg,
      providers: cfg.providers.map((e) =>
        e.uid === uid
          ? { ...e, config: { ...e.config, primaryPlan: plan, billingPlans: [plan, ...entryPlans(e.config).filter((p) => p !== plan)] } }
          : e,
      ),
    }
    setCfg(next)
    // 安卓操作弹窗持有 entry 快照：同步刷新同 uid 的 entry，
    // 让弹窗内「当前展示」标注与方案列表立即更新（避免"点了没反应"的误解）
    if (actionsEntry?.uid === uid) {
      const updated = next.providers.find((p) => p.uid === uid)
      if (updated) setActionsEntry(updated)
    }
    try {
      await saveConfig(next)
    } catch (e) {
      console.error('保存主方案失败：', e)
    }
  }

  const handleTheme = async (t: ThemeChoice) => {
    setTheme(t)
    if (!cfg) return
    const next = { ...cfg, theme: t }
    setCfg(next)
    try {
      await saveConfig(next)
    } catch {
      // 保存失败不阻断切换
    }
  }

  // 全局默认自动刷新间隔（分钟，0 = 不强制，站点各自决定）
  const handleAutoRefresh = async (minutes: number) => {
    if (!cfg) return
    const next = { ...cfg, autoRefreshMinutes: minutes }
    setCfg(next)
    try {
      await saveConfig(next)
    } catch (e) {
      console.error('保存自动刷新间隔失败：', e)
    }
  }

  // 「启动时自动打开桌宠模式」：off / last（上次站点）/ pinned（置顶站点）
  // ⚠️ 同时回写老布尔字段 `autoOpenWidget`（mode !== 'off'）：老版本/文档里的语义保持不变，
  //    判定统一由 lib/autoWidget.ts 的 autoWidgetMode() 完成（它以 mode 字段为准）。
  const handleAutoWidgetMode = async (mode: AutoWidgetMode) => {
    if (!cfg) return
    const next = { ...cfg, autoOpenWidgetMode: mode, autoOpenWidget: mode !== 'off' }
    setCfg(next)
    try {
      await saveConfig(next)
    } catch (e) {
      console.error('保存「启动时自动打开桌宠模式」失败：', e)
    }
  }

  // 背景壁纸：aurora（极光渐变，默认）/ plain（纯色）/ custom（自定义图片）
  const handleWallpaper = async (wp: string) => {
    document.documentElement.dataset.wallpaper = wp
    if (!cfg) return
    const next = { ...cfg, wallpaper: wp }
    setCfg(next)
    try {
      await saveConfig(next)
    } catch (e) {
      console.error('保存壁纸失败：', e)
    }
  }

  // 应用自定义壁纸：保存图片文件 → 记录路径并切换到 custom
  const handleCustomWallpaper = async (file: File) => {
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(new Error('读取图片失败'))
        r.readAsDataURL(file)
      })
      const path = await invoke<string>('save_wallpaper', { data: dataUrl })
      document.documentElement.dataset.wallpaper = 'custom'
      // ?t= 时间戳：替换壁纸时文件路径不变（wallpapers/custom.png），
      // 不带 query 会被 WebView2 缓存旧图导致"替换不生效"
      document.documentElement.style.setProperty(
        '--custom-wallpaper-url',
        `url("${convertFileSrc(path)}?t=${Date.now()}")`,
      )
      if (cfg) {
        const next = { ...cfg, wallpaper: 'custom', wallpaperFile: path }
        setCfg(next)
        await saveConfig(next)
      }
    } catch (e) {
      console.error('设置自定义壁纸失败：', e)
    }
  }

  // 同步导入：合并站点配置并保存
  const handleApplyImport = async (incoming: ProviderEntry[]) => {
    if (!cfg) return
    const merged = mergeProviders(cfg.providers, incoming)
    const next = { ...cfg, providers: merged }
    setCfg(next)
    try {
      await saveConfig(next)
    } catch (e) {
      console.error('保存导入配置失败：', e)
    }
  }

  const totalText = useMemo(() => {
    const parts = Object.entries(totalByCurrency)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([c, v]) => fmtMoney(v, c))
    return parts.length ? parts.join('  ·  ') : '等待首次刷新'
  }, [totalByCurrency])

  // 分方案的剩余汇总（无适配器数据时为 null → 显示「—」）：包时 duration / 按次 times
  const planRemain = useMemo(() => {
    const out: { duration: number | null; times: number | null } = { duration: null, times: null }
    if (!cfg) return out
    for (const e of cfg.providers) {
      const info = results[e.uid]
      if (!info?.ok || !info.plans) continue
      const d = info.plans.duration
      if (d?.ok) {
        const v = d.remaining ?? d.total
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          out.duration = (out.duration ?? 0) + v
        }
      }
      const t = info.plans.times
      if (t?.ok) {
        const v = t.remaining ?? t.total
        if (v !== null && v !== undefined && Number.isFinite(v)) {
          out.times = (out.times ?? 0) + v
        }
      }
    }
    return out
  }, [cfg, results])

  return (
    <div className="app-shell">
      <AuroraBackground />

      <div className="content">
        {/* —— Big Type 标题区 —— */}
        <header className="title-row">
          <div className="title-left">
            <h1 className="app-title">{APP_TITLE}</h1>
          </div>
          <div className="title-right">
            <div className="title-status">
              <div className="activity-row">
                <span
                  className={`activity ${
                    !cfg || cfg.providers.length === 0 ? 'warn' : overview.fail ? 'err' : 'ok'
                  }`}
                >
                  {!cfg || cfg.providers.length === 0
                    ? 'ⓧ 未运行'
                    : overview.fail
                      ? '⚠️ 需要处理'
                      : '✅ 监控运行中'}
                </span>
              </div>
              <span className="summary">
                {cfg ? (
                  <>
                    {cfg.providers.length} 个站点 · {overview.ok} 正常 ·{' '}
                    <span className={overview.fail > 0 ? 'fail-count' : ''}>
                      {overview.fail} 异常
                    </span>
                  </>
                ) : (
                  '加载中…'
                )}
              </span>
            </div>
            <button
              type="button"
              className="settings-btn"
              onClick={() => setSettingsOpen(true)}
              aria-label="设置"
            >
              <Settings size={15} strokeWidth={2.2} /> 设置
            </button>
          </div>
        </header>

        {/* —— Bento 概览卡：可用总额 + 剩余包时 + 剩余次数（无数据时显示 0）—— */}
        <div className="bento-row">
          <div className="stat-card wide overview-card">
            <div className="overview-item">
              <span className="stat-cap">可用总额</span>
              <span className="stat-value mono-num overview">{totalText}</span>
            </div>
            <div className="overview-divider" />
            <div className="overview-item">
              <span className="stat-cap">剩余包时</span>
              <span className="stat-value mono-num">{fmtDuration(planRemain.duration)}</span>
            </div>
            <div className="overview-divider" />
            <div className="overview-item">
              <span className="stat-cap">剩余次数</span>
              <span className="stat-value mono-num">
                {planRemain.times ? `${fmtCount(planRemain.times)}次` : '—'}
              </span>
            </div>
          </div>
        </div>

        {/* —— 操作行：导出/导入 + 方案筛选 + 全部刷新 + 添加站点 —— */}
        <div className="action-row">
          <button
            className="btn export-btn tip"
            data-tip="导出/导入站点数据"
            onClick={() => setSyncOpen(true)}
          >
            {/* 图标与弹窗里的「导出配置文件」保持一致（2026-09/16 用户要求）：Upload */}
            <Upload size={14} strokeWidth={2.2} /> 导出/导入
          </button>
          <button
            className={`btn export-btn tip tip-below ${planFilter.length > 0 ? 'active' : ''}`}
            data-tip="按照您的付费方式筛选站点"
            onClick={() => setPlanFilterOpen(true)}
          >
            <Tags size={14} strokeWidth={2.2} /> 方案筛选{planFilter.length > 0 ? ` · ${planFilter.length}` : ''}
          </button>
          <button
            className="btn export-btn"
            onClick={refreshAllSites}
            disabled={refreshingAll || !cfg?.providers.length}
          >
            {refreshingAll ? (
              <>
                <Loader2 size={14} className="spin" /> 刷新中…
              </>
            ) : (
              <>
                <RefreshCw size={14} strokeWidth={2.2} /> 全部刷新
              </>
            )}
          </button>
          <button
            className="btn export-btn"
            onClick={() => setDialog({ mode: 'add' })}
          >
            <Plus size={14} strokeWidth={2.2} /> 添加站点
          </button>
          {/* 桌宠（仅安卓端；桌面端的能力是卡片上的「🐳 展示」独立小窗，见 handleShow） */}
          {isAndroid && (
            <button
              className="btn export-btn"
              onClick={handlePetToggle}
              disabled={petBusy}
              title={
                !petSupported
                  ? '当前平台没有桌宠悬浮窗'
                  : petShowing
                    ? '关闭鲸鱼娘桌宠'
                    : petPermitted
                      ? '把鲸鱼娘显示在所有应用之上'
                      : '需要先授予「显示在其他应用上层」权限'
              }
            >
              {petBusy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
                  🐳
                </span>
              )}{' '}
              {petShowing ? '关闭桌宠' : '桌宠'}
            </button>
          )}
        </div>

        {/* —— 工具栏：搜索框一行（左侧放大镜）—— */}
        <div className="toolbar">
          <div className="search-wrap">
            <Search size={14} className="search-icon search-icon-left" aria-hidden />
            <input
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索站点或接口类型"
            />
          </div>
        </div>



        {/* —— 站点卡片网格（可拖拽排序；滚动容器内）—— */}
        <div className="cards-scroll">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={visibleEntries.map((e) => e.uid)}>
              <main className="card-grid">
                {!cfg || cfg.providers.length === 0 ? (
                  <div className="empty-hint">
                    还没有配置任何站点。
                    <br />
                    点击「＋ 添加站点」开始配置。
                  </div>
                ) : visibleEntries.length === 0 ? (
                  <div className="empty-hint">没有匹配的站点</div>
                ) : (
                  visibleEntries.map((entry, index) => (
                    <SiteCard
                      key={entry.uid}
                      entry={entry}
                      info={results[entry.uid]}
                      refreshing={refreshingUids.has(entry.uid)}
                      onRefresh={refreshOne}
                      onEdit={(e) => setDialog({ mode: 'edit', entry: e })}
                      onDelete={(e) => setConfirmDelete(e)}
                      onShow={handleShow}
                      onSetPrimary={handleSetPrimary}
                      onOpenActions={setActionsEntry}
                      delay={index * 45}
                    />
                  ))
                )}
              </main>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {dialog && (
        <SiteDialog
          entry={dialog.mode === 'edit' ? dialog.entry : null}
          onCancel={() => setDialog(null)}
          onSave={handleSave}
        />
      )}

      {/* 安卓端：站点操作弹窗（单击卡片打开；按钮 + 全部计费方案） */}
      {actionsEntry && (
        <SiteActionsDialog
          key={actionsEntry.uid}
          entry={actionsEntry}
          info={results[actionsEntry.uid]}
          refreshing={refreshingUids.has(actionsEntry.uid)}
          onRefresh={refreshOne}
          onEdit={(e) => {
            setActionsEntry(null)
            setDialog({ mode: 'edit', entry: e })
          }}
          onDelete={(e) => {
            setActionsEntry(null)
            setConfirmDelete(e)
          }}
          onSetPrimary={handleSetPrimary}
          onClose={() => setActionsEntry(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="确认删除"
          message={`确定删除站点「${confirmDelete.displayName}」？\n（配置会被移除，不会影响网站上的账户）`}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {syncOpen && cfg && (
        <SyncDialog
          cfg={cfg}
          onClose={() => setSyncOpen(false)}
          onApplyProviders={handleApplyImport}
        />
      )}

      {planFilterOpen && (
        <PlanFilterDialog
          value={planFilter}
          counts={planCounts}
          onChange={setPlanFilter}
          onClose={() => setPlanFilterOpen(false)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          onChangeTheme={handleTheme}
          wallpaper={cfg?.wallpaper === 'anime' ? 'aurora' : cfg?.wallpaper || 'aurora'}
          onChangeWallpaper={handleWallpaper}
          onCustomWallpaper={handleCustomWallpaper}
          autoRefreshMinutes={cfg?.autoRefreshMinutes ?? 0}
          onChangeAutoRefresh={handleAutoRefresh}
          autoWidgetMode={autoWidgetMode(cfg)}
          onChangeAutoWidgetMode={handleAutoWidgetMode}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <Toast toast={toast} />
    </div>
  )
}

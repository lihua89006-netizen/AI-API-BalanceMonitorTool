// 配置存储：包装 Rust 侧 config.json 读写命令

import { invoke } from '@tauri-apps/api/core'
import type { UsageBaselines } from './usage'

export interface ProviderEntry {
  uid: string
  providerId: string
  displayName: string
  enabled: boolean
  autoRefreshMinutes: number
  config: Record<string, unknown>
}

/** 启动自动打开桌宠（挂件）的模式（2026-09/16 用户口径，设置页下拉框三选一） */
export type AutoWidgetMode = 'off' | 'last' | 'pinned'

export interface AppConfig {
  autoRefreshMinutes: number
  theme: string
  providers: ProviderEntry[]
  /** 背景壁纸：anime（动漫图，默认）/ aurora（极光渐变）/ plain（纯色）/ custom（自定义图片） */
  wallpaper?: string
  /** 自定义壁纸的本地文件路径（wallpaper=custom 时有效），前端用 convertFileSrc 加载 */
  wallpaperFile?: string | null
  /** 挂件窗口大小（逻辑像素宽×高）；由 Rust 侧维护，前端保存配置时原样保留 */
  showWidgetSize?: [number, number] | null
  /** 主窗口位置（逻辑像素左上角）；由 Rust 侧维护 */
  mainWindowPos?: [number, number] | null
  /** 主窗口大小（逻辑像素宽×高）；由 Rust 侧维护 */
  mainWindowSize?: [number, number] | null
  /** 「今日已用」的当日余额基准（按站点 uid）；由 Rust 侧 record_usage_baseline 写入，
   *  前端保存配置时原样回传（不在界面上出现） */
  usageBaselines?: UsageBaselines
  /** 启动自动打开桌宠（挂件）的模式：off / last（上次站点）/ pinned（置顶站点）。
   *  ⚠️ 老配置可能没有这个字段，只有布尔 `autoOpenWidget` —— 判定统一走 `lib/autoWidget.ts`
   *  的 `autoWidgetMode()`（它以本字段为准，空则回退到旧布尔值） */
  autoOpenWidgetMode?: AutoWidgetMode | string
  /** ⚠️ 老字段（早期只有这个开关）：现在只作兼容读取与同步回写，判断一律看 `autoOpenWidgetMode` */
  autoOpenWidget?: boolean
  /** 上次打开的挂件站点 uid：「上次站点」模式启动时用它还原上次那个挂件；null = 还没开过 */
  lastWidgetUid?: string | null
}

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>('get_config')
}

export async function saveConfig(cfg: AppConfig): Promise<void> {
  await invoke('save_config_cmd', { cfg })
}

export async function upsertProvider(entry: ProviderEntry): Promise<AppConfig> {
  return invoke<AppConfig>('upsert_provider', { entry })
}

export async function removeProvider(uid: string): Promise<AppConfig> {
  return invoke<AppConfig>('remove_provider', { uid })
}

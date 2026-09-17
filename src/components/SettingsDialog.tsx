// 设置对话框：主题（三按钮横向）+ 背景壁纸（同一行）+ 启动自动打开挂件 + 反馈 Q 群（置顶）
// 「全局默认自动刷新间隔」已收纳进底部「高级设置」折叠区（2026-09/15 用户要求）
// 结构沿用其他对话框（overlay + dialog + 标题 + 内容 + 底部操作）

import { useRef, useState } from 'react'
import MenuSelect from './MenuSelect'
import { AUTO_WIDGET_MODES } from '../lib/autoWidget'
import type { AutoWidgetMode } from '../lib/store'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import type { ThemeChoice } from '../lib/theme'

/** 项目反馈 Q 群号 */
const QQ_GROUP = '1109402164'

/** 安卓端不渲染桌面端专属项（挂件窗只有桌面端有） */
function isAndroidPlatform(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
}

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

interface SettingsDialogProps {
  theme: ThemeChoice
  onChangeTheme: (t: ThemeChoice) => void
  /** 背景壁纸：aurora / plain / custom */
  wallpaper: string
  onChangeWallpaper: (wp: string) => void
  /** 选择自定义壁纸图片（File） */
  onCustomWallpaper: (file: File) => void
  /** 全局默认自动刷新间隔（分钟） */
  autoRefreshMinutes: number
  onChangeAutoRefresh: (minutes: number) => void
  /** 启动自动打开桌宠（挂件）的模式：off / last（上次站点）/ pinned（置顶站点） */
  autoWidgetMode: AutoWidgetMode
  onChangeAutoWidgetMode: (m: AutoWidgetMode) => void
  onClose: () => void
}

// 壁纸下拉用短标签：这一行要与主题按钮组共用宽度，长标签在小窗口下会挤
const WALLPAPERS = [
  { value: 'aurora', label: '🌌 极光' },
  { value: 'plain', label: '⬜ 纯色' },
  { value: 'custom', label: '🖼 自定义' },
]

export default function SettingsDialog({
  theme,
  onChangeTheme,
  wallpaper,
  onChangeWallpaper,
  onCustomWallpaper,
  autoRefreshMinutes,
  onChangeAutoRefresh,
  autoWidgetMode,
  onChangeAutoWidgetMode,
  onClose,
}: SettingsDialogProps) {
  const [minutes, setMinutes] = useState(
    autoRefreshMinutes > 0 ? String(autoRefreshMinutes) : '',
  )
  const [showAdvanced, setShowAdvanced] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const [copied, setCopied] = useState(false)

  /** 一键复制 Q 群号到剪贴板（成功短暂显示「已复制」） */
  const copyQqGroup = async () => {
    try {
      await writeText(QQ_GROUP)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* 剪贴板不可用时静默（不阻塞设置页） */
    }
  }

  const applyAutoRefresh = () => {
    const v = Math.max(0, Math.floor(Number(minutes) || 0))
    // 0 = 不使用全局默认（站点各自决定）；空输入视为 0
    onChangeAutoRefresh(v)
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      {/* settings-dialog：设置页专属作用域类（用于把「设置标题」的字体统一成与「高级设置」同款） */}
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">设置</h2>

        {/* —— 置顶：反馈 Q 群（一键复制群号） —— */}
        <div className="feedback-row">
          <span className="feedback-text">
            反馈可加入项目Q群哦：<b className="feedback-qq">{QQ_GROUP}</b>
          </span>
          <button
            type="button"
            className="btn secondary feedback-copy-btn"
            onClick={copyQqGroup}
            disabled={copied}
          >
            {copied ? '已复制 ✓' : '复制'}
          </button>
        </div>

        {/* 行间「立体」分割线（2026-09/16 用户要求：设置里每一行加一条） */}
        <div className="settings-divider" />

        {/* —— 主题（三按钮横向）与背景壁纸同一行：主题在左、壁纸在右 —— */}
        <div className="settings-row">
          <div className="settings-col theme-col">
            <label className="field-label">主题</label>
            <div className="theme-group" role="group" aria-label="主题">
              {THEME_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={`theme-opt ${theme === o.value ? 'active' : ''}`}
                  aria-pressed={theme === o.value}
                  onClick={() => onChangeTheme(o.value)}
                  title={
                    o.value === 'system'
                      ? '随系统深浅色自动切换'
                      : `使用${o.label}主题`
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-col wallpaper-col">
            <label className="field-label">背景壁纸</label>
            <MenuSelect
              align="left"
              className="wp-select"
              value={wallpaper === 'custom' ? 'custom' : wallpaper}
              options={WALLPAPERS}
              onChange={(wp) => {
                if (wp === 'custom') {
                  // 打开文件选择器；选图后由父组件处理（onCustomWallpaper）
                  fileRef.current?.click()
                } else {
                  onChangeWallpaper(wp)
                }
              }}
              title="主界面背景：极光渐变 / 纯色 / 自定义图片"
            />
          </div>
        </div>

        {/* 自定义壁纸时：当前行下方出现「选择图片」替换按钮 + 说明 */}
        {wallpaper === 'custom' && (
          <div className="wallpaper-row">
            <button
              type="button"
              className="btn secondary wp-replace-btn"
              onClick={() => fileRef.current?.click()}
            >
              🖼 选择图片
            </button>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onCustomWallpaper(f)
            e.target.value = ''
          }}
        />
        {/* 提示语：2026-09/16 按用户要求删掉「选择主界面背景样式，立即生效」这句
            （非自定义壁纸时不再有提示行）；自定义壁纸时保留下面这句，它说明了怎么换图 */}
        {wallpaper === 'custom' && (
          <p className="field-hint">当前使用自定义壁纸，可点「选择图片」替换</p>
        )}

        <div className="settings-divider" />

        {/* —— 启动自动打开桌宠（挂件）—— 2026-09/16 用户口径：文案改为「启动时自动打开桌宠模式」，
            右侧控件由滑动开关换成**下拉框三选一**：关闭自动 / 上次站点 / 置顶站点
            （判定与站点选择见 lib/autoWidget.ts，那边有单测） —— */}
        {!isAndroidPlatform() && (
          <div className="switch-row">
            <span className="switch-label">启动时自动打开桌宠模式</span>
            <MenuSelect
              className="auto-widget-select"
              align="right"
              title="启动时自动打开挂件窗，以及打开哪个站点"
              value={autoWidgetMode}
              options={AUTO_WIDGET_MODES}
              onChange={onChangeAutoWidgetMode}
            />
          </div>
        )}

        <div className="settings-divider" />

        {/* —— 高级设置（折叠，默认收起）：全局默认自动刷新间隔 —— */}
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
              <label className="field-label">全局默认自动刷新间隔（分钟）</label>
              <input
                className="field-input"
                type="number"
                min={0}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                placeholder="默认 3；0 = 站点各自决定"
              />
              <p className="field-hint">
                新建站点的默认刷新间隔；已有站点的间隔不受影响（0 表示不强制）
              </p>
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={applyAutoRefresh}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

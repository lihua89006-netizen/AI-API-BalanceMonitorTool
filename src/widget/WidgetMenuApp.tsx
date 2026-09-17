// 挂件 ☰ 面板 —— **独立窗口**（label=widget-menu，2026-09/16）
//
// **为什么独立**：面板原先内嵌在挂件窗口里（绝对定位于画布右上角外侧），而挂件窗口最小可缩到
// 160×180、面板固定 178 宽 → 缩小后被裁掉。现由 Rust（`widget_menu.rs`）创建**独立无边框透明窗口**，
// 恒定位于挂件**正上方**、与其**右对齐**；本组件只负责内容，并把量测到的高度回报给 Rust
// （`widget_menu_resize`）—— 高度变化时由 Rust 保证**底边与右边缘不动**（面板向上生长）。
//
// ⚠️ 2026-09/16 换模型后本面板**暂时没有任何设置项**：「今日充值金额」随「消费只由下降构成」
// 一起删除 —— 消费不再需要用户登记任何金额（充值不会污染它，见 `lib/usage.ts`）。
// 面板与 ☰ 按钮按用户要求**保留**，作为后续功能的落点。

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './widget.css'
import './widget-menu.css'
import '../styles/theme.css'

export default function WidgetMenuApp() {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const reportedH = useRef(0)

  /** 收起面板（Rust：隐藏窗口 + 通知挂件同步 ☰ 状态） */
  const close = useCallback(() => {
    void invoke('widget_menu_close').catch((e) => console.error('关闭面板失败：', e))
  }, [])

  /**
   * 把量测到的高度回报给 Rust：窗口高度 = 根节点高度（含给 CSS 投影留的内边距）。
   * useLayoutEffect（绘制前上报）+ ResizeObserver（内容行增减、文字换行都会触发）。
   * ⚠️ 根节点**不能用 `inset:0`/`height:100%`**——那样量到的是窗口高度而非内容高度，
   * 会形成"窗口变高 → 内容变高 → 再变高"的自激循环。
   */
  const reportHeight = useCallback(() => {
    const el = rootRef.current
    if (!el) return
    const h = Math.ceil(el.getBoundingClientRect().height)
    if (h <= 0 || Math.abs(h - reportedH.current) < 1) return
    reportedH.current = h
    void invoke('widget_menu_resize', { height: h }).catch((e) =>
      console.error('面板高度回报失败：', e),
    )
  }, [])

  useLayoutEffect(() => {
    reportHeight()
  })

  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => reportHeight())
    ro.observe(el)
    return () => ro.disconnect()
  }, [reportHeight])

  // Esc 收起
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <div className="wm-root" ref={rootRef}>
      <div className="widget-menu-panel">
        <div className="wmp-title">设置</div>
        <p className="wmp-empty">暂无设置项，这个面板留给后续功能。</p>
        <div className="wmp-actions">
          <button type="button" className="wmp-btn" onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

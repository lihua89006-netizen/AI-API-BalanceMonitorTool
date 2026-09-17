//! 挂件「今日充值金额」面板 —— **独立窗口**（2026-09/16）
//!
//! **为什么独立（用户口径）**：面板原先内嵌在挂件窗口里（`.widget-menu-panel`，绝对定位于
//! 画布右上角外侧）。挂件窗口最小可缩到 160×180，而面板固定 178 宽 + 约 130 高
//! → **窗口越小越会被裁掉**（用户反馈「鲸鱼娘窗口缩小后设置界面显示不全」）。
//! 现改为**独立无边框透明窗口**：恒定位于挂件窗口**正上方**、与挂件窗口**右对齐**（见 `menu_origin`），
//! 高度由内容决定（前端量测后回报 `widget_menu_resize`，面板向上生长、底边不动），
//! 因此挂件缩到多小都不会裁到面板。
//!
//! **跟随**：挂件可拖动 / 滚轮缩放 / 边缘缩放，面板必须跟着走 —— 由挂件那条约 60Hz 的
//! 命中检测轮询线程顺带调用 `sync_menu_pos`（只在目标位置与当前位置差 ≥0.5px 时才动窗口，
//! 因此拖动这种系统级移动也能跟上，而静止时不产生任何系统调用）。
//!
//! **架构沿用挂件的成熟决策**：复用 `index.html` 入口（前端按窗口 label 分流）、
//! `visible(false)` 创建 → 页面加载完成后再 show、`prevent_close() + hide()` 常驻复用
//! （避免 close() 异步销毁期间句柄仍在的竞态）。

#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
use tauri::webview::PageLoadEvent;
#[cfg(desktop)]
use tauri::{Emitter, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

#[cfg(desktop)]
use crate::widget::{set_bounds_atomic, WIDGET_LABEL};

/// 面板窗口 label（前端 `main.tsx` 据此分流渲染 `WidgetMenuApp`）。
/// ⚠️ 以下常量与 `menu_origin` **只在桌面端使用**，必须 `#[cfg(desktop)]` 门控：
/// 2026-09/16 打安卓整包时实测，未门控的桌面专用符号会在安卓 release 构建里刷一屏
/// `never used` 警告（本模块当时贡献了 6 条）。
#[cfg(desktop)]
pub const MENU_LABEL: &str = "widget-menu";
/// 面板窗口宽度（逻辑 px；与前端 `.wm-root` 的固定宽度一致）
#[cfg(desktop)]
const MENU_W: f64 = 224.0;
/// 首次创建时的兜底高度 —— 前端挂载后立刻量测真实高度并回报（`widget_menu_resize`）
#[cfg(desktop)]
const MENU_H_FALLBACK: f64 = 132.0;
/// 面板底边与挂件窗口顶边之间的间隙（逻辑 px）
#[cfg(desktop)]
const MENU_GAP: f64 = 6.0;
/// 前端回报高度的合法区间（防御异常值把窗口拉成一条线或撑满屏幕）
#[cfg(desktop)]
const MENU_H_MIN: f64 = 60.0;
#[cfg(desktop)]
const MENU_H_MAX: f64 = 420.0;

/// 面板目标左上角（逻辑 px）：与挂件**右对齐**、贴在挂件**正上方**（间隔 `MENU_GAP`）。
///
/// 上方空间不足（面板会越过 `top_bound`，即挂件所在显示器的顶边）时改放**挂件下方**
/// （同样右对齐）——宁可换到下面，也不能把面板推到屏幕外让用户点不到。
///
/// 纯函数：生产与单测共用同一份口径（`menu_origin` 的四个用例钉住"右对齐 / 贴上方 /
/// 越界翻转 / 高度变化时底边不动"四条不变量）。
#[cfg(desktop)]
fn menu_origin(wx: f64, wy: f64, ww: f64, wh: f64, mw: f64, mh: f64, top_bound: f64) -> (f64, f64) {
    let x = wx + ww - mw;
    let above = wy - MENU_GAP - mh;
    if above >= top_bound {
        (x, above)
    } else {
        (x, wy + wh + MENU_GAP)
    }
}

/// 切换面板（挂件右上角 ☰ 调用）：**已显示 → 隐藏；否则显示并对齐到挂件上方**。
///
/// 必须是 async command：同步命令在主线程执行，而 `build()` 建窗需要 dispatch 回主线程
/// → 主线程被占用会死锁挂起（挂件 `open_widget` 踩过同一个坑，这里沿用其写法）。
/// 返回切换后的可见状态（前端另有一条 `widget:menu-state` 事件做权威同步）。
#[tauri::command]
pub async fn widget_menu_toggle(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        if let Some(win) = app.get_webview_window(MENU_LABEL) {
            if win.is_visible().unwrap_or(false) {
                hide_menu(&app);
                return Ok(false);
            }
        }
        show_menu(&app)?;
        Ok(true)
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        Err("仅桌面端支持挂件面板".to_string())
    }
}

/// 关闭面板（面板里的「取消」/「确定」/Esc 调用）。只是隐藏，不销毁（下次秒开）。
/// 隐藏时向挂件发 `widget:menu-state=false`，挂件据此重读「今日已用」记录
/// （登记充值后状态行要从「设置今日充值金额」恢复为「今日已用 ¥X」）。
#[tauri::command]
pub fn widget_menu_close(app: tauri::AppHandle) {
    #[cfg(desktop)]
    hide_menu(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// 前端量测面板内容高度后回报（逻辑 px）。**底边与右边缘固定**，面板向上生长。
#[tauri::command]
pub fn widget_menu_resize(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let win = app
            .get_webview_window(MENU_LABEL)
            .ok_or("面板窗口不存在")?;
        let h = height.clamp(MENU_H_MIN, MENU_H_MAX);
        let sf = win.scale_factor().map_err(|e| e.to_string())?;
        let (x, y) = menu_target(&app, h)?;
        // 诊断：高度变化时**底边与右边缘应当不动**（面板向上生长），日志便于核对这条不变量
        eprintln!("[menu] resize h={h:.1} -> ({x:.1},{y:.1})");
        set_bounds_atomic(&win, x, y, MENU_W, h, sf)
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, height);
        Err("仅桌面端支持挂件面板".to_string())
    }
}

/// 面板目标左上角（逻辑 px）——读挂件窗口的**真实**几何（不信任前端读数，理由同 `widget_set_bounds`）
#[cfg(desktop)]
fn menu_target(app: &tauri::AppHandle, menu_h: f64) -> Result<(f64, f64), String> {
    let widget = app
        .get_webview_window(WIDGET_LABEL)
        .ok_or("挂件窗口不存在")?;
    let sf = widget.scale_factor().map_err(|e| e.to_string())?;
    let pos = widget
        .outer_position()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(sf);
    let size = widget
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(sf);
    // 上边界 = 挂件所在显示器的顶边（副屏可能为负或很大）。取不到显示器信息时不设限。
    let top = widget
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.position().to_logical::<f64>(m.scale_factor()).y)
        .unwrap_or(f64::NEG_INFINITY);
    Ok(menu_origin(
        pos.x,
        pos.y,
        size.width,
        size.height,
        MENU_W,
        menu_h,
        top,
    ))
}

/// 面板当前高度（逻辑 px）：读真实窗口尺寸，读不到用兜底值
#[cfg(desktop)]
fn menu_height(win: &WebviewWindow, sf: f64) -> f64 {
    win.inner_size()
        .map(|s| s.to_logical::<f64>(sf).height)
        .unwrap_or(MENU_H_FALLBACK)
}

/// 显示（或复用已有）面板窗口并对齐到挂件上方
#[cfg(desktop)]
fn show_menu(app: &tauri::AppHandle) -> Result<(), String> {
    // 挂件不存在时没有可对齐的目标（正常流程不会发生：☰ 在挂件页面里）
    app.get_webview_window(WIDGET_LABEL)
        .ok_or("挂件窗口不存在")?;

    // 已存在：重新对齐 + 显示 + 聚焦，并让面板重读站点数据（可能已切换站点）
    if let Some(win) = app.get_webview_window(MENU_LABEL) {
        let sf = win.scale_factor().map_err(|e| e.to_string())?;
        let h = menu_height(&win, sf);
        let (x, y) = menu_target(app, h)?;
        set_bounds_atomic(&win, x, y, MENU_W, h, sf)?;
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("widget:menu-show", ());
        emit_menu_state(app, true);
        eprintln!("[menu] reused at ({x:.1},{y:.1}) size {MENU_W}x{h:.1}");
        return Ok(());
    }

    // 首次创建：先按兜底高度算好位置（避免"先在别处闪一下"），页面加载完成后再显示
    let h0 = MENU_H_FALLBACK;
    let (x, y) = menu_target(app, h0)?;
    // 诊断：把对齐依据（挂件真实矩形）一并打出来，便于核对"右对齐 + 在正上方"（同挂件日志体例）
    if let Some(w) = app.get_webview_window(WIDGET_LABEL) {
        if let (Ok(p), Ok(s), Ok(sf2)) = (w.outer_position(), w.outer_size(), w.scale_factor()) {
            let p = p.to_logical::<f64>(sf2);
            let s = s.to_logical::<f64>(sf2);
            eprintln!(
                "[menu] widget rect ({:.1},{:.1}) {}x{} (logical)",
                p.x, p.y, s.width, s.height
            );
        }
    }
    let app_for_load = app.clone();
    let win = WebviewWindowBuilder::new(app, MENU_LABEL, WebviewUrl::App("index.html".into()))
        .title("今日充值金额")
        .inner_size(MENU_W, h0)
        .position(x, y)
        .decorations(false)
        .shadow(false) // 窗口阴影会呈现为边框/白线观感（挂件同理）；立体感由 CSS 投影负责
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false) // 高度由前端量测回报，不让系统改
        .visible(false)
        .on_document_title_changed(|_, title| eprintln!("[menu] document-title: {title}"))
        .on_page_load(move |win, load| {
            if load.event() == PageLoadEvent::Finished {
                // 页面就绪后再显示（同挂件：避免白屏/闪烁），并让面板读一次站点数据。
                // ⚠️ 首次创建时这次 emit 会早于 React 的 listen 注册 —— 面板挂载时自己也会读，
                //    这里只为"窗口复用时切换站点"服务（那时 listen 早已注册）。
                let _ = win.show();
                let _ = win.set_focus();
                let _ = win.emit("widget:menu-show", ());
                if let Some(w) = app_for_load.get_webview_window(WIDGET_LABEL) {
                    let _ = w.emit("widget:menu-state", true);
                }
                eprintln!("[menu] window shown");
            }
        })
        .build()
        .map_err(|e| {
            eprintln!("[menu] 创建面板窗口失败: {e}");
            format!("创建面板窗口失败: {e}")
        })?;

    // 任何途径关闭（Alt+F4 / 系统关闭）都只隐藏，不销毁（同挂件：避免异步销毁期竞态）
    let app2 = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            hide_menu(&app2);
        }
    });

    eprintln!("[menu] opened at ({x:.1},{y:.1}) size {MENU_W}x{h0} (logical)");
    Ok(())
}

/// 隐藏面板（幂等）。只在"确实由可见转隐藏"时发状态事件，避免重复通知。
#[cfg(desktop)]
pub(crate) fn hide_menu(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window(MENU_LABEL) else {
        return;
    };
    if !win.is_visible().unwrap_or(false) {
        return;
    }
    let _ = win.hide();
    emit_menu_state(app, false);
    eprintln!("[menu] hidden");
}

/// 把面板的显示状态告知挂件窗口（挂件据此同步 ☰ 的 aria-expanded，并在收起时重读当日记录）
#[cfg(desktop)]
fn emit_menu_state(app: &tauri::AppHandle, open: bool) {
    if let Some(w) = app.get_webview_window(WIDGET_LABEL) {
        let _ = w.emit("widget:menu-state", open);
    }
}

/// 挂件移动/缩放时让面板跟随。由挂件那条约 60Hz 的命中检测轮询线程顺带调用
/// （拖动是系统级拖动、缩放每帧改窗口几何，都没有"挂件移动"的事件可监听 →
/// 轮询是最省事且不会漏的同步点）。只在位置真的变了才调系统 API。
#[cfg(desktop)]
pub(crate) fn sync_menu_pos(app: &tauri::AppHandle) {
    let Some(menu) = app.get_webview_window(MENU_LABEL) else {
        return;
    };
    if !menu.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(sf), Ok(cur)) = (menu.scale_factor(), menu.outer_position()) else {
        return;
    };
    let h = menu_height(&menu, sf);
    let Ok((x, y)) = menu_target(app, h) else {
        return;
    };
    let cur = cur.to_logical::<f64>(sf);
    if (cur.x - x).abs() < 0.5 && (cur.y - y).abs() < 0.5 {
        return;
    }
    let _ = set_bounds_atomic(&menu, x, y, MENU_W, h, sf);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 常态：与挂件右对齐、贴在挂件正上方（间隔 6px）
    #[test]
    fn menu_right_aligned_and_above_widget() {
        // 挂件 (100,300) 308×308、面板 224×130：
        // 右边缘对齐 → x = 100+308-224 = 184；底边在挂件顶边之上 6px → y = 300-6-130 = 164
        assert_eq!(
            menu_origin(100.0, 300.0, 308.0, 308.0, 224.0, 130.0, 0.0),
            (184.0, 164.0)
        );
    }

    /// 挂件贴屏幕顶边：上方放不下 → 改放挂件下方（同样右对齐）
    #[test]
    fn menu_flips_below_when_no_room_above() {
        // 挂件 (0,20) 308×308：上方只剩 14px，放不下 130+6 → y = 20+308+6 = 334
        assert_eq!(
            menu_origin(0.0, 20.0, 308.0, 308.0, 224.0, 130.0, 0.0),
            (84.0, 334.0)
        );
    }

    /// 上边界取显示器顶边（副屏可能不是 0）：挂件在副屏顶部时同样翻转
    #[test]
    fn menu_uses_monitor_top_as_bound() {
        // 副屏顶边 y=1080、挂件 (0,1100)：上方 964 < 1080 → 翻到下方
        assert_eq!(
            menu_origin(0.0, 1100.0, 308.0, 308.0, 224.0, 130.0, 1080.0),
            (84.0, 1414.0)
        );
    }

    /// 高度变化时**底边与右边缘不动**（面板向上生长）——保证量测回报不会让面板"跳动"
    #[test]
    fn menu_height_change_keeps_bottom_and_right_edge() {
        let (x1, y1) = menu_origin(50.0, 400.0, 308.0, 308.0, 224.0, 120.0, 0.0);
        let (x2, y2) = menu_origin(50.0, 400.0, 308.0, 308.0, 224.0, 180.0, 0.0);
        assert_eq!(x1, x2, "右边缘必须固定");
        assert_eq!(y1 + 120.0, y2 + 180.0, "底边必须固定");
    }
}

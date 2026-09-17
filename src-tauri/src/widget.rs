//! 鲸鱼娘挂件：独立无边框置顶小窗，单站点余额展示（阶段 3）
//!
//! 架构决策（吸取历史回滚 3 次的教训）：
//! - 挂件窗口**复用 index.html 入口**（与主窗口同一个 vite 入口，dev/生产行为一致），
//!   前端按当前窗口 label 分流渲染（main → 主界面，widget → 挂件），
//!   彻底绕开「独立 html 入口在 dev 模式 404 / vite 多页配置」这类白屏根因。
//! - 站点数据通过 `widget:open` 事件（uid + displayName）传给挂件页面；
//!   **在页面加载完成（on_page_load Finished）后才 emit**，避免事件先于前端 listen 注册而丢失。
//! - 窗口 visible(false) 创建，页面加载完成后再 show，
//!   配合 page-state 诊断日志（eval_with_callback）区分「未加载」与「已加载但渲染异常」。

#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::Manager;
use tauri::State; // 跨平台：移动端命令同样使用

#[cfg(desktop)]
use tauri::webview::PageLoadEvent;
#[cfg(desktop)]
use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::config::{self, ConfigState};

/// 挂件窗口 label
pub const WIDGET_LABEL: &str = "widget";
/// 默认窗口大小 = 背景图 1026px 的 30%（对齐 Python 版 show_window）
const DEFAULT_W: f64 = 308.0;
const DEFAULT_H: f64 = 308.0;
const MIN_W: f64 = 160.0;
const MIN_H: f64 = 180.0;

/// 最近一次挂件目标站点（uid, displayName）。
/// 挂件页面挂载后主动拉取（`widget_get_site`），避免「页面加载完成 ≠ React 挂载完成」
/// 导致 widget:open 事件早于前端 listen 注册而丢失的时序竞争。
#[derive(Default)]
pub struct WidgetState(pub std::sync::Mutex<Option<(String, String)>>);

/// 滚轮缩放锚点（手势起始的真实窗口状态）：由 Rust 在缩放手势第一次调用时从系统读取并缓存。
/// 之后的每一帧都相对该锚点计算（k = 目标边长 / 起始边长），数学上无累积漂移——
/// 不依赖前端猜测的窗口位置（JS window.screenX / outerPosition 在 WebView2 高 DPI 下不可靠，
/// 实测与 Rust 真实 outer_position 相差可达 1000px，正是此前「向右下漂移」的根源）。
#[cfg(desktop)]
struct ZoomAnchor {
    pos_x: f64, // 手势起始窗口左上角（逻辑 px）
    pos_y: f64,
    size: f64, // 手势起始边长（逻辑 px，1:1）
}
#[cfg(desktop)]
static ZOOM_ANCHOR: std::sync::Mutex<Option<ZoomAnchor>> = std::sync::Mutex::new(None);

// ══════════════════════════════════════════════════════════════════════════
// 空白处点击穿透（2026-09/11）
//
// 背景图 background.png 约 **48% 像素完全透明**（鲸鱼娘是异形角色），但窗口是矩形 →
// 那近一半的空白会**吃掉鼠标事件**，挡住后面的窗口。用户要求「空白处可穿透」。
//
// 实现取舍：**不用 `SetWindowRgn`**（硬边区域会把图片的抗锯齿边缘切出锯齿，且每次缩放都要
// 重建区域）——改用**动态 `set_ignore_cursor_events`**：轮询全局光标位置 → 查命中遮罩 →
// 光标在空白处就把窗口整体设为穿透，回到实体处再关掉。渲染完全不受影响。
//
// 遮罩由**前端**从 background.png 的 alpha 通道生成后一次性上传（Rust 侧读不到前端打包资源）。
// 单元格用块内**平均** alpha + 很低阈值 ≈ 对实体区域做膨胀：宁可多捕获一点，
// 也不能把鲸鱼娘本体判成空白（否则用户点不到它、甚至拖不动窗口）。
// ══════════════════════════════════════════════════════════════════════════

/// 命中遮罩：size×size 的二值网格（行优先），1=实体（接收鼠标）、0=空白（穿透）
#[cfg(desktop)]
struct HitMask {
    size: usize,
    cells: Vec<u8>,
}
#[cfg(desktop)]
static HIT_MASK: std::sync::Mutex<Option<HitMask>> = std::sync::Mutex::new(None);
#[cfg(desktop)]
static HIT_POLL_STARTED: AtomicBool = AtomicBool::new(false);
/// 当前窗口是否处于穿透态（只作变化检测，避免每帧重复调用系统 API）
#[cfg(desktop)]
static HIT_IGNORED: AtomicBool = AtomicBool::new(false);

/// 窗口右上角**固定 UI 区**的占位（CSS px，不随画布缩放）——始终算实体。
///
/// ⚠️ 这两颗按钮都压在背景图的**透明区**上，必须特判，否则启用点击穿透后点不到：
///   - 返回按钮 `.widget-back`：`top:10 right:10 26×26`（历史教训：不加保护就关不掉挂件）
///   - 菜单按钮 `.widget-menu`：`top:42 right:10 26×26`（实测正是漏了这处保护 →
///     点击被穿透、菜单点不开）
///
/// 因此把两键所在矩形（宽 40 × 高 72）统一算实体，各留 4px 余量。
/// ⚠️ **2026-09/16 起「今日充值金额」面板已移出挂件窗口**（独立窗口，见 `widget_menu.rs`）：
/// 这里不再需要为面板预留区域 —— 保护区由 230×176 缩到 40×72，右上角其余空白恢复
/// "点一下就穿透"，不再白占一块不可穿透区。
#[cfg(desktop)]
const OVERLAY_W: f64 = 40.0;
#[cfg(desktop)]
const OVERLAY_H: f64 = 72.0;

/// 上传命中遮罩（前端从 background.png alpha 生成）。桌面端生效，移动端无此概念。
#[tauri::command]
pub fn widget_set_hitmask(app: tauri::AppHandle, size: usize, cells: Vec<u8>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        if size == 0 || cells.len() != size * size {
            return Err(format!(
                "命中遮罩尺寸不合法：size={size}，cells={}（应为 {}）",
                cells.len(),
                size * size
            ));
        }
        let solid = cells.iter().filter(|c| **c != 0).count();
        if solid == 0 {
            // 全空遮罩会让挂件整体不可点击（连拖动都失效）→ 拒绝，宁可没有穿透
            return Err("命中遮罩为空，已拒绝启用穿透".to_string());
        }
        *HIT_MASK.lock().map_err(|_| "命中遮罩加锁失败".to_string())? =
            Some(HitMask { size, cells });
        eprintln!("[widget] 命中遮罩已设置：{size}×{size}，实体格 {solid}/{}", size * size);
        start_hit_poller(app);
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, size, cells);
        Err("仅桌面端支持点击穿透".to_string())
    }
}

/// 诊断：回传当前命中判定（供脚本核对"遮罩映射是否正确"，例如把光标挪到空白/实体处比对）
#[tauri::command]
pub fn widget_hit_state(app: tauri::AppHandle) -> serde_json::Value {
    #[cfg(desktop)]
    {
        use serde_json::json;
        let Some(win) = app.get_webview_window(WIDGET_LABEL) else {
            return json!({ "error": "挂件窗口不存在" });
        };
        let (Ok(pos), Ok(size), Ok(cur)) =
            (win.outer_position(), win.outer_size(), win.cursor_position())
        else {
            return json!({ "error": "窗口状态读取失败" });
        };
        let (px, py) = (pos.x as f64, pos.y as f64);
        let (sw, sh) = (size.width as f64, size.height as f64);
        let (rx, ry) = (cur.x - px, cur.y - py);
        let inside = rx >= 0.0 && ry >= 0.0 && rx < sw && ry < sh;
        json!({
            "cursor": [cur.x, cur.y],
            "window": [px, py, sw, sh],
            "rel": [rx, ry],
            "inside": inside,
            "fixedOverlay": inside && in_fixed_overlay(&win, rx, ry, sw),
            "maskSolid": inside && mask_solid(rx / sw, ry / sh),
            "maskSet": HIT_MASK.lock().map(|g| g.is_some()).unwrap_or(false),
            "ignored": HIT_IGNORED.load(Ordering::SeqCst),
        })
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        serde_json::json!({ "error": "仅桌面端支持" })
    }
}

/// 启动穿透轮询线程（幂等）。约 60Hz：读全局光标 → 查遮罩 → 需要时切换穿透态。
#[cfg(desktop)]
fn start_hit_poller(app: tauri::AppHandle) {
    if HIT_POLL_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(16));
        apply_hit_test(&app);
    });
}

#[cfg(desktop)]
fn apply_hit_test(app: &tauri::AppHandle) {
    // 面板（独立窗口）跟随挂件：挂件拖动是**系统级拖动**、缩放是逐帧改窗口几何，
    // 都没有"挂件移动了"的事件可监听 → 借这条 60Hz 轮询同步（静止时不产生系统调用）。
    crate::widget_menu::sync_menu_pos(app);
    let Some(win) = app.get_webview_window(WIDGET_LABEL) else {
        return;
    };
    // 窗口隐藏时不必穿透；顺手复位，避免下次显示时残留穿透态（会导致整窗点不动）
    if !win.is_visible().unwrap_or(false) {
        set_ignored(&win, false);
        return;
    }
    let (Ok(pos), Ok(size), Ok(cur)) = (win.outer_position(), win.outer_size(), win.cursor_position())
    else {
        return;
    };
    let (px, py) = (pos.x as f64, pos.y as f64);
    let (sw, sh) = (size.width as f64, size.height as f64);
    if sw <= 0.0 || sh <= 0.0 {
        return;
    }
    let (rx, ry) = (cur.x - px, cur.y - py);
    let inside = rx >= 0.0 && ry >= 0.0 && rx < sw && ry < sh;
    let solid =
        inside && (in_fixed_overlay(&win, rx, ry, sw) || mask_solid(rx / sw, ry / sh));
    // 只有"在窗口内且落在空白处"才穿透
    set_ignored(&win, inside && !solid);
}

/// 光标（窗口内相对物理像素）是否落在「右上角固定 UI 区」（返回键 / 菜单键 / 菜单面板）
#[cfg(desktop)]
fn in_fixed_overlay(win: &tauri::WebviewWindow, rx: f64, ry: f64, sw: f64) -> bool {
    let sf = win.scale_factor().unwrap_or(1.0);
    rx >= sw - OVERLAY_W * sf && ry <= OVERLAY_H * sf
}

/// 归一化坐标 (u,v) 处是否为实体。遮罩缺失/越界/加锁失败一律按**实体**处理（保守：不穿透）
#[cfg(desktop)]
fn mask_solid(u: f64, v: f64) -> bool {
    let Ok(guard) = HIT_MASK.lock() else {
        return true;
    };
    let Some(m) = guard.as_ref() else {
        return true;
    };
    let n = m.size as f64;
    if u < 0.0 || v < 0.0 {
        return true;
    }
    let (ix, iy) = ((u * n) as usize, (v * n) as usize);
    if ix >= m.size || iy >= m.size {
        return true;
    }
    m.cells[iy * m.size + ix] != 0
}

/// 切换穿透态（仅在状态真正变化时调系统 API）
#[cfg(desktop)]
fn set_ignored(win: &tauri::WebviewWindow, v: bool) {
    if HIT_IGNORED.load(Ordering::SeqCst) == v {
        return;
    }
    if win.set_ignore_cursor_events(v).is_ok() {
        HIT_IGNORED.store(v, Ordering::SeqCst);
    }
}

/// **原子**设置窗口几何（逻辑 px）：Windows 用**一次** `SetWindowPos` 同时改位置与大小，
/// 其它平台退化为 `set_size` + `set_position`。
///
/// ⚠️ 为什么必须一次（实测，别改回两次调用）：分两次 `set_size` + `set_position` 时窗口边界
/// 会经过两个中间状态（先变尺寸、再移位置），WebView2 内容层每步各收一次 resize 事件
/// → 内容「拉伸-重绘」循环 → 抖动。一次 SetWindowPos 后窗口边界一步到位、只收一次 resize。
///
/// 挂件滚轮缩放每帧都走这里（`widget_set_bounds`），面板窗口的对齐/重排也复用它
/// （`widget_menu.rs`）。
#[cfg(desktop)]
pub(crate) fn set_bounds_atomic(
    win: &tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    sf: f64,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = win
            .hwnd()
            .map_err(|e| format!("获取窗口句柄失败: {e}"))?;
        let flags = windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER
            | windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOACTIVATE;
        let ok = unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::SetWindowPos(
                hwnd.0 as isize, // tauri HWND（windows crate 透明包装）→ windows-sys 0.52 isize
                0, // HWND_TOP：无 Z 序变化（配合 SWP_NOZORDER）
                (x * sf).round() as i32,
                (y * sf).round() as i32,
                (w * sf).round() as i32,
                (h * sf).round() as i32,
                flags,
            )
        };
        if ok == 0 {
            return Err(format!(
                "SetWindowPos 失败: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        win.set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
        win.set_position(tauri::LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())
    }
}

/// 主界面各站点的最近刷新结果缓存（uid → QuotaInfo JSON）。
/// 挂件打开时直接取用立即显示，避免重复网络请求等数据慢。
#[derive(Default)]
pub struct WidgetResultState(pub std::sync::Mutex<std::collections::HashMap<String, serde_json::Value>>);

/// 打开（或聚焦）挂件窗口并切换到指定站点。命令与 dev 调试钩子共用。
/// 仅桌面端实现；移动端（Android/iOS）返回不支持错误。
#[cfg(desktop)]
pub fn open_widget_inner(app: &tauri::AppHandle, uid: String) -> Result<(), String> {
    let cfg = config::load_config(app);
    let entry = cfg
        .providers
        .iter()
        .find(|p| p.uid == uid)
        .cloned()
        .ok_or_else(|| "站点不存在".to_string())?;

    // 记录目标站点：挂件页面挂载后主动拉取
    if let Ok(mut guard) = app.state::<WidgetState>().0.lock() {
        *guard = Some((uid.clone(), entry.display_name.clone()));
    }

    let cached = app
        .state::<WidgetResultState>()
        .0
        .lock()
        .ok()
        .and_then(|m| m.get(&uid).cloned());
    let payload = serde_json::json!({
        "uid": uid,
        "displayName": entry.display_name,
        "info": cached, // 主界面最近一次刷新结果（挂件立即显示，不等网络）
    });
    // 展开挂件时隐藏主窗口（任务栏一并隐藏，挂件置顶成为唯一可见窗口）
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
        eprintln!("[widget] main window hidden");
    }

    // 窗口已存在：显示（可能处于隐藏状态）+ 聚焦并切换站点
    if let Some(win) = app.get_webview_window(WIDGET_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("widget:open", payload);
        eprintln!("[widget] existing widget shown");
        return Ok(());
    }

    let (w, h) = cfg.show_widget_size.unwrap_or((DEFAULT_W, DEFAULT_H));
    eprintln!("[widget] open size: {w}x{h} (logical)");
    let shown = std::sync::Arc::new(AtomicBool::new(false));

    eprintln!("[widget] before build");
    let mut builder = WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App("index.html".into()))
        .title("余额展示")
        .inner_size(w, h)
        .min_inner_size(MIN_W, MIN_H)
        .resizable(false) // 完全无边框：关闭系统 resize 边框；缩放由挂件页 JS 自实现（setSize 不受影响）
        .decorations(false)
        .shadow(false) // 去掉窗口阴影（阴影会呈现为边框/顶部白线观感）
        .always_on_top(true)
        .skip_taskbar(true)
        .transparent(true)
        .visible(false);
    // 恢复上次位置（若有；不校验显示器边界——挂件可自由拖到任意位置）
    if let Some((px, py)) = cfg.show_widget_pos {
        builder = builder.position(px, py);
    }
    let win = builder
        .on_document_title_changed(|win, title| {
            eprintln!("[widget] document-title: {title} (url={:?})", win.url());
        })
        .on_page_load(move |win, load| {
            let event = match load.event() {
                PageLoadEvent::Started => "Started",
                PageLoadEvent::Finished => "Finished",
            };
            eprintln!("[widget] page-load {event}: {}", load.url());
            if load.event() == PageLoadEvent::Finished {
                // 页面加载完成后再显示，避免白屏 / 闪烁
                if !shown.swap(true, Ordering::SeqCst) {
                    let _ = win.show();
                    eprintln!("[widget] window shown");
                    // 页面已就绪、前端 listen 已注册，此时发站点事件才不会丢
                    let _ = win.emit("widget:open", payload.clone());
                    eprintln!("[widget] widget:open emitted");
                    // 延迟诊断：读余额渲染结果（等 fetchEntry 完成后再看 DOM）
                    let win3 = win.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(2500));
                        let js = "JSON.stringify({name: (document.querySelector('.widget-name')||{}).textContent || '', balance: (document.querySelector('.widget-balance')||{}).textContent || '', status: (document.querySelector('.widget-status')||{}).textContent || '', bgLoaded: (document.querySelector('.widget-bg')||{}).complete, bgFailed: !!document.querySelector('.widget-bg-fallback')})";
                        let _ = win3.eval_with_callback(js, |res| {
                            eprintln!("[widget] render-state: {res}");
                        });
                    });
                }
                // 诊断：读取页面真实状态（区分「未加载」与「已加载但渲染异常」）
                let js = "JSON.stringify({ready: document.readyState, title: document.title, href: location.href, bodyLen: document.body ? document.body.innerHTML.length : -1, bodyBg: document.body ? getComputedStyle(document.body).backgroundColor : '', htmlBg: getComputedStyle(document.documentElement).backgroundColor})";
                let _ = win.eval_with_callback(js, |res| {
                    eprintln!("[widget] page-state: {res}");
                });
            }
        })
        .build()
        .map_err(|e| {
            eprintln!("[widget] 创建挂件窗口失败: {e}");
            format!("创建挂件窗口失败: {e}")
        })?;
    eprintln!("[widget] after build");

    eprintln!("[widget] opened for uid={uid}");

    // 任何途径关闭（返回按钮 / Alt+F4 / 系统关闭）都保存窗口大小并恢复主窗口。
    // 注意：不真正销毁窗口（prevent_close + hide），再次展开时直接复用，
    // 避免 close() 异步销毁期间窗口句柄仍存在导致「点按钮只隐藏主窗口、挂件不出现」的竞态。
    let app2 = app.clone();
    let win2 = win.clone();
    win2.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            // 保存窗口大小与位置（逻辑像素：inner_size/outer_position 返回物理值，
            // 需按 scale_factor 换算，否则高 DPI 屏幕上恢复时会放大/错位）
            if let (Ok(size), Ok(sf)) = (win.inner_size(), win.scale_factor()) {
                let logical = size.to_logical::<f64>(sf);
                let pos = win
                    .outer_position()
                    .ok()
                    .map(|p| p.to_logical::<f64>(sf));
                let mut cfg = config::load_config(&app2);
                cfg.show_widget_size = Some((logical.width, logical.height));
                if let Some(p) = pos {
                    cfg.show_widget_pos = Some((p.x, p.y));
                }
                let state = app2.state::<ConfigState>();
                if let Ok(guard) = state.lock.lock() {
                    let _ = config::save_config(&app2, &cfg);
                    drop(guard);
                }
                eprintln!(
                    "[widget] hidden, size saved: {}x{} pos: {:?} (logical)",
                    logical.width,
                    logical.height,
                    cfg.show_widget_pos
                );
            }
            let _ = win.hide();
            // 「今日充值金额」面板是独立窗口：挂件收起时必须一并收起，
            // 否则桌面上会留下一块无主面板（它自己没有"挂件已关闭"的概念）
            crate::widget_menu::hide_menu(&app2);
            // 恢复主窗口（任务栏一并恢复）
            if let Some(main) = app2.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
                eprintln!("[widget] main window restored");
            }
        }
    });

    Ok(())
}

/// 移动端桩实现：挂件窗口仅桌面端支持。
#[cfg(not(desktop))]
pub fn open_widget_inner(_app: &tauri::AppHandle, _uid: String) -> Result<(), String> {
    Err("移动端不支持挂件窗口".into())
}

/// 打开挂件窗口（主界面「🐳 展示」按钮调用）。
/// 必须是 async command：同步 command 在主线程执行，而 build() 建窗需要 dispatch 回主线程，
/// 主线程被占用会死锁挂起（历史「点按钮挂件不出现」的真正根因；线程调用一直正常）。
#[tauri::command]
pub async fn open_widget(
    app: tauri::AppHandle,
    _state: State<'_, ConfigState>,
    uid: String,
) -> Result<(), String> {
    open_widget_inner(&app, uid)
}

/// 关闭挂件窗口（挂件页面「返回」按钮调用）。同样用 async 避免主线程窗口操作死锁。
#[tauri::command]
pub async fn close_widget(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(WIDGET_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

/// 挂件页面挂载后主动拉取目标站点（uid + displayName + 主界面已有结果）；未设置过返回 None。
#[derive(serde::Serialize)]
pub struct WidgetSite {
    pub uid: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    /// 主界面最近一次刷新结果；无缓存为 null
    pub info: Option<serde_json::Value>,
}

#[tauri::command]
pub fn widget_get_site(app: tauri::AppHandle) -> Option<WidgetSite> {
    // 用 try_state：Android 上 WidgetState 未 manage（挂件仅桌面），返回 None 而非 panic
    let state = app.try_state::<WidgetState>()?;
    let guard = state.0.lock().ok()?;
    let (uid, display_name) = guard.as_ref()?;
    let result_state = app.try_state::<WidgetResultState>()?;
    let result_guard = result_state.0.lock().ok()?;
    let info = result_guard.get(uid).cloned();
    Some(WidgetSite {
        uid: uid.clone(),
        display_name: display_name.clone(),
        info,
    })
}

/// 主界面刷新完成后同步结果缓存（挂件打开时直接复用，避免重复网络请求）；
/// info 传 JSON null 表示清除该站点缓存（站点删除/配置变更时调用）。
#[tauri::command]
pub fn widget_set_result(
    app: tauri::AppHandle,
    uid: String,
    info: serde_json::Value,
) -> Result<(), String> {
    // 诊断：记录前端结果到达时间（≈ 前端 setResults 时刻，用于核对「逐个显示」是否生效）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or_default();
    eprintln!("[ui] result {uid} at {now:.3}s");
    let result_state = match app.try_state::<WidgetResultState>() {
        Some(s) => s,
        None => return Ok(()), // Android 无挂件缓存，静默忽略
    };
    let mut map = result_state
        .0
        .lock()
        .map_err(|_| "获取结果缓存锁失败".to_string())?;
    if info.is_null() {
        map.remove(&uid);
    } else {
        map.insert(uid, info);
    }
    Ok(())
}

/// 主界面启动时批量恢复上次结果缓存（所有站点 uid → info）——
/// 启动后卡片直接显示上次数值（含识别为 0 的结果），避免先闪横线；
/// 挂件缓存（WidgetResultState）与主界面 results 共用同一份数据。
#[tauri::command]
pub fn widget_get_all_results(
    app: tauri::AppHandle,
) -> std::collections::HashMap<String, serde_json::Value> {
    let mut out = std::collections::HashMap::new();
    if let Some(state) = app.try_state::<WidgetResultState>() {
        if let Ok(guard) = state.0.lock() {
            for (k, v) in guard.iter() {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// 挂件滚轮缩放：**锚点数学全部在 Rust 完成**，每帧从系统真实窗口状态出发——
/// 前端只上报鼠标相对窗口内容坐标 + 目标边长 + 手势首帧标记。
/// 手势第一帧（first=true）从真实 outer_position / inner_size 缓存锚点 (P0, S0)；
/// 之后每帧：k = 目标边长/S0，新位置 = P0 + 鼠标内容坐标*(1-k)，保持鼠标指向的内容点屏幕位置不动。
/// 每帧步长 ≤10px 平滑推进。即使某帧落地有误差，下一帧仍以真实缓存锚点为基准，绝不累积漂移。
/// 不读前端任何位置/尺寸值（前端在 WebView2 高 DPI 下读取不可靠，是此前漂移的根源）。
#[tauri::command]
pub fn widget_set_bounds(
    app: tauri::AppHandle,
    mouse_x: f64,
    mouse_y: f64,
    target_w: f64,
    target_h: f64,
    first: bool,
) -> Result<f64, String> {
    let win = app
        .get_webview_window(WIDGET_LABEL)
        .ok_or("挂件窗口不存在")?;
    let sf = win.scale_factor().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    // ⚠️ 一律取整到 **CSS 整数像素**（与渲染进程 window.innerWidth 同口径）：
    // 内容层 scale = innerWidth/308（整数/308），锚点数学若用未取整的浮点尺寸，
    // 两者最多差 0.5 CSS px → 锚点系统性偏移（实测残留约 0.2 物理像素）。
    let cur_w = (size.width as f64 / sf).round();
    let cur_h = (size.height as f64 / sf).round();
    if cur_w <= 0.0 || cur_h <= 0.0 {
        return Ok(0.0);
    }
    #[cfg(desktop)]
    {
        let mut guard = ZOOM_ANCHOR
            .lock()
            .map_err(|_| "获取缩放锚点失败".to_string())?;
        // 手势首帧：以真实窗口状态缓存锚点（逻辑 px）
        if first {
            *guard = Some(ZoomAnchor {
                pos_x: pos.x as f64 / sf,
                pos_y: pos.y as f64 / sf,
                size: cur_w,
            });
        }
        let anchor = guard
            .as_ref()
            .ok_or("缩放锚点未初始化（应先以 first=true 调用）")?;
        // 1:1 正方形（对齐边缘缩放规则：取较大边为边长）；前端同值传两个参数，
        // 取 max 既是防御也是文档化行为，避免「宽高不一致时窗口取哪个」含糊。
        let stepped = target_w.max(target_h).max(1.0);
        // ⚠️ 位置数学必须用**前端请求值**（不是落地取整值）：
        // 前端内容层 scale = 请求值/308，锚点在内容中的位置按该 k 计算；
        // Rust 若用落地取整值算 k，两者差最多 0.4 CSS px → 锚点偏移 m·Δ/S0 ≈ 0.16 物理像素。
        // 落到实处的物理像素取整由下面的 SetWindowPos 完成，与位置数学无关。
        // 缩放比相对「手势起始尺寸」：k = stepped/S0（数学上无累积漂移）
        let k = stepped / anchor.size;
        let new_x = anchor.pos_x + mouse_x * (1.0 - k);
        let new_y = anchor.pos_y + mouse_y * (1.0 - k);
        drop(guard);
        // ⚠️ 原子设置位置+大小：一次 SetWindowPos（同一 Win32 消息）同时改位置和尺寸。
        // 此前「分两次 set_size + set_position」中间有窗口边界两帧变化（先变尺寸再移位置），
        // WebView2 内容层每步收到两次 resize 事件 → 内容「拉伸-重绘」循环 → 抖动。
        // 一次 SetWindowPos 后窗口边界一步到位，WebView2 只收到一次尺寸变化，中间帧最少。
        // （实现见 set_bounds_atomic；面板窗口的对齐也复用同一个函数）
        set_bounds_atomic(&win, new_x, new_y, stepped, stepped, sf)?;
        // 返回落地后的实际边长（CSS 整数像素口径，与 window.innerWidth 一致）：
        // 前端据此确认命令成功；内容层的缩放由前端自己的浮点游标负责
        //（用落地取整值当基准会把步长向上取整，实测把 1.25px 步长顶到 2px → 抖动放大）。
        let landed = win.outer_size().map_err(|e| e.to_string())?;
        Ok((landed.width as f64 / sf).round())
    }
    #[cfg(not(desktop))]
    {
        let _ = (pos.x, pos.y, mouse_x, mouse_y, target_w, target_h, first);
        Ok(cur_w)
    }
}

/// 挂件缩放结束后前端上报当前大小（逻辑像素），立即持久化——
/// 不依赖关闭时机（应用退出时窗口不触发 CloseRequested，只靠关闭保存会丢最后一次缩放/移动）。
/// 位置由 Rust 从真实 outer_position 读取并换算逻辑像素保存（不信任前端上报的 window.screenX，
/// 高 DPI 下是物理像素会错位；close 兜底也有同样问题，故缩放结束即用真实值覆盖）。
#[tauri::command]
pub fn widget_save_size(
    app: tauri::AppHandle,
    state: State<'_, ConfigState>,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(|_| "获取配置锁失败".to_string())?;
    let mut cfg = config::load_config(&app);
    cfg.show_widget_size = Some((w, h));
    if let Some(win) = app.get_webview_window(WIDGET_LABEL) {
        if let (Ok(p), Ok(sf)) = (win.outer_position(), win.scale_factor()) {
            cfg.show_widget_pos = Some((p.x as f64 / sf, p.y as f64 / sf));
        }
    }
    config::save_config(&app, &cfg)
}
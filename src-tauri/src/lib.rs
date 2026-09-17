//! API 额度监控器 —— Tauri 2 重做版

mod config;
mod export;
mod network;
mod web_login;
mod widget;
mod widget_menu;

use config::ConfigState;
use network::NetState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 桌面端 cfg(desktop) 块内会重新赋值（单实例插件），需要 mut；移动端无此块
    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(web_login::plugin())
        .plugin(export::plugin());

    // 单实例：桌面端防双开（第二个实例启动时聚焦已有窗口）；移动端无此概念，跳过
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            app.manage(NetState::new());
            app.manage(ConfigState::new());
            #[cfg(desktop)]
            app.manage(widget::WidgetState::default());
            #[cfg(desktop)]
            app.manage(widget::WidgetResultState::default());

            // 主窗口：恢复上次位置与大小（位置验证仍在某个显示器工作区内，
            // 防止外接屏拔掉后飞出屏幕；大小用逻辑像素避免高 DPI 缩放错位）。
            // 注意：setup 阶段窗口刚创建，立即 set_size/set_position 可能被窗口
            // 初始化流程覆盖（曾出现宽度不生效、只剩默认 437 的情况），
            // 所以放到延迟任务里等窗口显示后再应用。
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                let cfg = config::load_config(&handle);
                let saved_size = cfg.main_window_size;
                let saved_pos = cfg.main_window_pos.filter(|pos| {
                    let (x, y) = *pos;
                    app.available_monitors()
                        .map(|mons| {
                            mons.iter().any(|m| {
                                let p = m.position().to_logical::<f64>(m.scale_factor());
                                let s = m.size().to_logical::<f64>(m.scale_factor());
                                x >= p.x
                                    && x < p.x + s.width as f64
                                    && y >= p.y
                                    && y < p.y + s.height as f64
                            })
                        })
                        .unwrap_or(false)
                });
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if let (Some((sw, sh)), Some(_sf)) = (saved_size, w.scale_factor().ok()) {
                        if sw > 0.0 && sh > 0.0 {
                            let ls = tauri::LogicalSize::new(sw, sh);
                            if let Err(e) = w.set_size(ls) {
                                eprintln!("[main] set_size 失败: {e}");
                            }
                        }
                    }
                    if let Some((px, py)) = saved_pos {
                        let sf = w.scale_factor().unwrap_or(1.0);
                        let _ = w.set_position(tauri::PhysicalPosition::new(
                            (px * sf) as i32,
                            (py * sf) as i32,
                        ));
                    }
                    if let (Ok(sz), Ok(sf)) = (w.inner_size(), w.scale_factor()) {
                        let ls = sz.to_logical::<f64>(sf);
                        eprintln!("[main] window restored to {}x{} (logical)", ls.width, ls.height);
                    }
                });
            }
            // 关闭时保存位置与大小（应用退出路径）——独立取窗口，不依赖上面的 if 作用域
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                let app2 = app.handle().clone();
                let win2 = win.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Ok(sf) = win2.scale_factor() {
                            let mut cfg = config::load_config(&app2);
                            if let Ok(pos) = win2.outer_position() {
                                let logical = pos.to_logical::<f64>(sf);
                                cfg.main_window_pos = Some((logical.x, logical.y));
                            }
                            if let Ok(size) = win2.inner_size() {
                                let logical = size.to_logical::<f64>(sf);
                                cfg.main_window_size = Some((logical.width, logical.height));
                            }
                            let state = app2.state::<ConfigState>();
                            if let Ok(guard) = state.lock.lock() {
                                let _ = config::save_config(&app2, &cfg);
                                drop(guard);
                            }
                            eprintln!(
                                "[main] position saved: {:?}, size saved: {:?} (logical)",
                                cfg.main_window_pos, cfg.main_window_size
                            );
                        }
                        // 主窗口关闭 = 应用退出：挂件窗口常驻（prevent_close + hide），
                        // 不显式退出会导致「所有窗口关闭才退出」不满足 → 进程残留任务管理器
                        api.prevent_close();
                        app2.exit(0);
                    }
                });
            }

            // 启动时把主窗口带到前台：Windows 对后台启动（dev 终端/cargo run）的程序有
            // 前台锁定策略，窗口默认会压在其他窗口后面。短暂置顶 0.4s 抢焦点后恢复正常层级。
            // 解除置顶必须验证成功：一次性 set_always_on_top(false) 若赶上窗口初始化竞态会失败，
            // 置顶标志残留导致整个程序此后一直压在其它窗口之上（表现为打开弹窗时「窗口置顶」）。
            #[cfg(desktop)]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
                let _ = win.set_always_on_top(true);
                let w2 = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    for _ in 0..10 {
                        let top = w2.is_always_on_top().unwrap_or(false);
                        if !top {
                            break; // 已恢复正常层级
                        }
                        if let Err(e) = w2.set_always_on_top(false) {
                            eprintln!("[main] 解除置顶失败: {e}");
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                });
            }

            // 开发调试钩子：设置环境变量 AUTO_WIDGET_UID=<uid>（或 first=第一个站点）时，
            // 启动 3 秒后自动打开挂件窗口，便于验证挂件白屏问题。
            #[cfg(debug_assertions)]
            if let Ok(uid) = std::env::var("AUTO_WIDGET_UID") {
                if !uid.is_empty() {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(3000));
                        let target = if uid == "first" {
                            let cfg = config::load_config(&handle);
                            cfg.providers
                                .first()
                                .map(|p| p.uid.clone())
                                .unwrap_or_default()
                        } else {
                            uid.clone()
                        };
                        if target.is_empty() {
                            eprintln!("[widget] AUTO_WIDGET_UID 指定的站点不存在");
                        } else if let Err(e) = widget::open_widget_inner(&handle, target) {
                            eprintln!("[widget] 自动打开挂件失败: {e}");
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            network::http_request,
            network::fetch_site_icons,
            network::browser_login_query,
            config::get_config,
            config::save_config_cmd,
            config::upsert_provider,
            config::remove_provider,
            config::record_usage_baseline,
            config::save_wallpaper,
            export::export_config_file,
            widget::open_widget,
            widget::close_widget,
            widget::widget_get_site,
            widget::widget_set_result,
            widget::widget_get_all_results,
            widget::widget_set_bounds,
            widget::widget_save_size,
            widget::widget_set_hitmask,
            widget::widget_hit_state,
            widget_menu::widget_menu_toggle,
            widget_menu::widget_menu_close,
            widget_menu::widget_menu_resize,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 应用退出：终止仍活跃的 node 子进程（浏览器登录查询），防进程残留
            if let tauri::RunEvent::Exit = event {
                network::kill_active_node();
            }
        });
}

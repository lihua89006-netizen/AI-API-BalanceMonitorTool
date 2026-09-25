//! 安卓端「鲸鱼娘桌宠」：系统悬浮窗（方案 1）的 **Rust 桥 + 命令面**。
//!
//! 分三层（各自只做一件事）：
//!   · `PetOverlay.kt`  —— 三个 overlay 窗（鲸鱼 / 把手 / 菜单）、拖动、缩放、穿透；
//!   · `WidgetOverlayPlugin.kt` —— Kotlin 侧命令面与特殊授权引导；
//!   · 本文件 —— Rust 侧命令面（前端 `invoke` 的落点），负责**把前端算好的文字**与
//!     **编译期嵌入的鲸鱼背景图**交给 Kotlin。
//!
//! ## 数据口径（重要）
//! 站名 / 余额 / 「今日已用」/ 峰谷倒计时**一律由前端算好再推**（`src/lib/petOverlay.ts`），
//! 安卓端不在原生侧重算一遍 —— 这是方案里的「口径唯一」原则：口径代码只有一份
//! （桌面挂件 `WidgetApp.tsx` 与它共用同一批 `lib/` 函数），不会出现两端数字不一样。
//!
//! ## 平台
//! 只有安卓有悬浮窗。桌面端本模块整体退化成桩：命令统一返回
//! 「仅安卓端支持桌宠悬浮窗」，`overlay_status` 返回 `supported: false`，前端据此隐藏入口。
//!
//! ⚠️ 所有会走 `run_mobile_plugin` 的命令**必须 `async`**：该调用会阻塞当前线程直到
//!    Kotlin 侧 resolve，而 Kotlin 的命令要跑在安卓主线程上 —— 同步命令占住主线程就是死锁
//!    （`export_config_file` / `browser_login_query` 是同一条坑）。
#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use tauri::Runtime;

#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Kotlin 插件所在包名与类名（`@TauriPlugin` 注解类，构建时自动注册）
#[cfg(target_os = "android")]
const OVERLAY_PACKAGE: &str = "com.apibalance.monitor";
#[cfg(target_os = "android")]
const OVERLAY_CLASS: &str = "WidgetOverlayPlugin";

/// 鲸鱼背景图 = **编译期嵌入仓库里的那一份**（`public/background.png`，与前端 `dist/background.png` 同源）。
///
/// 为什么这么做：安卓端原生悬浮层读不到前端打包资源（`dist` 是编进 Rust 二进制的），
/// 但它**不应该因此多一份副本** —— 仓库里再放一份 `res/drawable/*.png` 迟早会和原图走散
/// （方案里把这个选项列为"退一步"，理由是"需要加同步机制"）。这里走编译期嵌入 = 零副本、零同步成本。
#[cfg(target_os = "android")]
const PET_BG_PNG: &[u8] = include_bytes!("../../public/background.png");

/// 桌宠要显示的文字（前端算好推过来；字段任意缺省）
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayPayload {
    pub name: String,
    pub balance: String,
    pub status: String,
    /// ok | err | busy | used
    pub status_kind: String,
    pub peak_label: String,
    pub peak_text: String,
    /// peak | valley | ""
    pub peak_kind: String,
}

/// Kotlin 侧统一回执
#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OverlayAck {
    ok: bool,
    message: String,
}

/// Kotlin 侧状态回执
#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OverlayStateAck {
    permitted: bool,
    showing: bool,
}

/// Kotlin 侧授权回执
#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OverlayPermissionAck {
    granted: bool,
    message: String,
}

/// Kotlin 侧几何回执
#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct OverlayGeometryAck {
    showing: bool,
    x: i32,
    y: i32,
    size_dp: i32,
}

/// 返回给前端的插件状态（`supported=false` = 当前平台没有桌宠悬浮窗）
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayStatus {
    pub supported: bool,
    pub permitted: bool,
    pub showing: bool,
}

/// 返回给前端的操作回执
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayOutcome {
    pub ok: bool,
    pub message: String,
}

/// 返回给前端的授权结果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayPermission {
    pub granted: bool,
    pub message: String,
}

/// 安卓端插件句柄（仅安卓编译）
#[cfg(target_os = "android")]
pub(crate) struct WidgetOverlay<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> WidgetOverlay<R> {
    /// 调 Kotlin 插件命令（`open` / `update` / `close` / `state` / `geometry`）
    fn run<A: serde::Serialize, T: serde::de::DeserializeOwned>(
        &self,
        command: &str,
        args: A,
    ) -> Result<T, String> {
        self.0
            .run_mobile_plugin(command, args)
            .map_err(|e| format!("桌宠悬浮窗调用失败（{command}）：{e}"))
    }
}

/// 注册安卓插件（lib.rs 的 Builder 调用；其它平台为 no-op）
pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("widget-overlay")
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = (&app, &api);
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(OVERLAY_PACKAGE, OVERLAY_CLASS)?;
                app.manage(WidgetOverlay(handle));
            }
            Ok(())
        })
        .build()
}

/// 把编译期嵌入的鲸鱼背景图写到应用目录，返回 Kotlin 能直接 `decodeFile` 的绝对路径。
///
/// 每次打开都重写一遍（约 480KB）：内容来自编译期常量，重写只是让"图片换了"自动生效，
/// 不做哈希比对是刻意的——比对逻辑本身比这次写入更贵，也更可能出错。
#[cfg(target_os = "android")]
fn ensure_pet_bg(app: &tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_config_dir())
        .map_err(|e| format!("取应用目录失败：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用目录失败：{e}"))?;
    let path = dir.join("pet_bg.png");
    std::fs::write(&path, PET_BG_PNG).map_err(|e| format!("写出桌宠背景图失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 把桌宠几何写进 config.json（位置/大小记忆）。
/// 加配置写锁 + 重新 load 一遍：与其它 read-modify-write 命令同一套路（避免并发覆盖丢更新）。
#[cfg(target_os = "android")]
fn persist_geometry(app: &tauri::AppHandle, x: i32, y: i32, size_dp: i32) {
    let state = app.state::<crate::config::ConfigState>();
    let Ok(_guard) = state.lock.lock() else {
        return;
    };
    let mut cfg = crate::config::load_config(app);
    cfg.mobile_widget_size = Some(size_dp);
    cfg.mobile_widget_pos = Some((x, y));
    if let Err(e) = crate::config::save_config(app, &cfg) {
        eprintln!("[overlay] 保存桌宠几何失败: {e}");
    }
}

/// 桌宠状态：是否支持（平台）、是否已授权（悬浮窗特殊权限）、是否正在显示。
/// 前端按钮据此在「打开／关闭」之间切换；每次点击都查一次，故桌宠被它自己的菜单关掉后
/// 前端也不会显示错状态（不做本地 toggle 缓存 —— 缓存一定会和真实状态走散）。
#[tauri::command]
pub async fn overlay_status(app: tauri::AppHandle) -> Result<OverlayStatus, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        let ack: OverlayStateAck = handle.run("state", ())?;
        Ok(OverlayStatus {
            supported: true,
            permitted: ack.permitted,
            showing: ack.showing,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(OverlayStatus {
            supported: false,
            permitted: false,
            showing: false,
        })
    }
}

/// 请求「显示在其他应用上层」授权（跳系统设置页）。
/// 系统该页永远回 RESULT_CANCELED，Kotlin 侧在回调里回读权限状态，故这里拿到的 `granted` 是权威值。
#[tauri::command]
pub async fn overlay_request_permission(app: tauri::AppHandle) -> Result<OverlayPermission, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        let ack: OverlayPermissionAck = handle.run("requestPermission", ())?;
        Ok(OverlayPermission {
            granted: ack.granted,
            message: ack.message,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("仅安卓端支持桌宠悬浮窗".to_string())
    }
}

/// 显示桌宠（已显示时 = 原地刷新文字）。
/// `sizeDp` 为 0/None 时由 Kotlin 用默认尺寸；位置缺省时落在屏幕右侧偏下。
#[tauri::command]
pub async fn overlay_open(
    app: tauri::AppHandle,
    payload: OverlayPayload,
    size_dp: Option<i32>,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<OverlayOutcome, String> {
    #[cfg(target_os = "android")]
    {
        let image_path = ensure_pet_bg(&app)?;
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        // 位置/大小记忆：调用方没给就用上次存下的（config.mobileWidgetPos / mobileWidgetSize），
        // 都没有则由原生层用默认值（右侧偏下、150dp）
        let cfg = crate::config::load_config(&app);
        let saved_pos = cfg.mobile_widget_pos;
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            image_path: String,
            name: String,
            balance: String,
            status: String,
            status_kind: String,
            peak_label: String,
            peak_text: String,
            peak_kind: String,
            size_dp: i32,
            x: Option<i32>,
            y: Option<i32>,
        }
        let ack: OverlayAck = handle.run(
            "open",
            Args {
                image_path,
                name: payload.name,
                balance: payload.balance,
                status: payload.status,
                status_kind: payload.status_kind,
                peak_label: payload.peak_label,
                peak_text: payload.peak_text,
                peak_kind: payload.peak_kind,
                size_dp: size_dp.or(cfg.mobile_widget_size).unwrap_or(0),
                x: x.or(saved_pos.map(|p| p.0)),
                y: y.or(saved_pos.map(|p| p.1)),
            },
        )?;
        Ok(OverlayOutcome {
            ok: ack.ok,
            message: ack.message,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, payload, size_dp, x, y);
        Err("仅安卓端支持桌宠悬浮窗".to_string())
    }
}

/// 刷新桌宠文字（主应用每轮刷新后调用）。桌宠未显示时 `ok=false`、不报错。
#[tauri::command]
pub async fn overlay_update(
    app: tauri::AppHandle,
    payload: OverlayPayload,
) -> Result<OverlayOutcome, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            name: String,
            balance: String,
            status: String,
            status_kind: String,
            peak_label: String,
            peak_text: String,
            peak_kind: String,
        }
        let ack: OverlayAck = handle.run(
            "update",
            Args {
                name: payload.name,
                balance: payload.balance,
                status: payload.status,
                status_kind: payload.status_kind,
                peak_label: payload.peak_label,
                peak_text: payload.peak_text,
                peak_kind: payload.peak_kind,
            },
        )?;
        Ok(OverlayOutcome {
            ok: ack.ok,
            message: ack.message,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, payload);
        Err("仅安卓端支持桌宠悬浮窗".to_string())
    }
}

/// 关闭桌宠。关闭**之前**先把几何存下来（关掉之后就查不到了），以免用户刚拖完就关、
/// 位置白丢一次。
#[tauri::command]
pub async fn overlay_close(app: tauri::AppHandle) -> Result<OverlayOutcome, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        if let Ok(g) = handle.run::<(), OverlayGeometryAck>("geometry", ()) {
            if g.showing {
                persist_geometry(&app, g.x, g.y, g.size_dp);
            }
        }
        let ack: OverlayAck = handle.run("close", ())?;
        Ok(OverlayOutcome {
            ok: ack.ok,
            message: ack.message,
        })
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(OverlayOutcome {
            ok: true,
            message: "当前平台没有桌宠悬浮窗".to_string(),
        })
    }
}

/// 主动保存桌宠当前位置/大小（桌宠**显示中**时前端定期调用）。
/// 为什么需要它：位置与缩放是在**原生菜单/把手手势**里改的（拖动、放大缩小），前端不知情；
/// 只在关闭时保存的话，用户拖完没多久应用被杀就丢了。返回 `false` = 桌宠没在显示（无需保存）。
#[tauri::command]
pub async fn overlay_save_geometry(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        let g: OverlayGeometryAck = handle.run("geometry", ())?;
        if !g.showing {
            return Ok(false);
        }
        persist_geometry(&app, g.x, g.y, g.size_dp);
        Ok(true)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(false)
    }
}

/// 桌宠当前几何（位置 + 边长，dp）；未显示时 `showing=false`。
/// 供前端在桌宠被其自身菜单拖动/缩放后落盘（P2），以及诊断用。
#[tauri::command]
pub async fn overlay_geometry(app: tauri::AppHandle) -> Result<Option<(i32, i32, i32)>, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<WidgetOverlay<tauri::Wry>>()
            .ok_or("桌宠插件未注册")?;
        let g: OverlayGeometryAck = handle.run("geometry", ())?;
        if !g.showing {
            return Ok(None);
        }
        Ok(Some((g.x, g.y, g.size_dp)))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

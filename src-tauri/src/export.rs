//! 导出配置文件：把配置文本写成文件，并把**文件本身**放进剪贴板（Windows `CF_HDROP`）。
//!
//! 为什么不是"复制文本"（2026-09/16 用户口径）：导出后到资源管理器 / 微信 / QQ 里直接 `Ctrl+V`，
//! 粘出来的就是那个 `.json` 文件，不需要先"另存为"。故导出物有两份：磁盘上的一份（剪贴板引用它，
//! 所以这份必须留在原地、不能被清理）+ 剪贴板里的文件句柄。
//!
//! ⚠️ 平台：剪贴板放文件是 **Windows 专有**；安卓走另一条路 —— 系统分享面板（`ACTION_SEND` +
//!   FileProvider）或保存到本地（`ACTION_CREATE_DOCUMENT`），见 `ConfigExportPlugin.kt`
//!   （2026-09/16 按用户口径「AB 结合」实现）。
//! ⚠️ 剪贴板内容的所有权：`SetClipboardData` 成功后内存归系统，**不要**再 `GlobalFree`（会双重释放）；
//!   失败时才自己释放。
// 安卓端走不到本模块的 Windows 实现（反之亦然），避免 dead_code 警告污染 cargo check
#![cfg_attr(not(windows), allow(dead_code))]

use std::fs;
// ⚠️ 三个 import 都**不能**按平台门控：Path 被 build_dropfiles_payload、PathBuf/fs 被 export_dir 用到，
// 而这些函数在各平台都存在（只是有些平台不调用它们）——门控过会让安卓目标编译不过（本轮踩过）
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 剪贴板格式：文件列表（`CF_HDROP`，值 15）。
/// 这里写常量而不引 `Win32_System_Ole` 只为拿这一个数（省一个 cargo feature）。
#[cfg(windows)]
const CF_HDROP: u32 = 15;
/// `DROPFILES` 结构长度：pFiles(4) + pt(8) + fNC(4) + fWide(4)
const DROPFILES_LEN: usize = 20;

/// 导出文件名兜底（前端没给名字或给的名字被清空时）
const DEFAULT_FILE_NAME: &str = "API余额通-配置.json";

/// 清洗前端传来的文件名：
///   - 路径分隔符与 Windows 保留字符一律换成 `_`（**防目录穿越**：`../../x.json`、绝对路径）
///   - 去掉前导 `.`（避免 `..`、隐藏文件）与控制字符
///   - 强制以 `.json` 结尾；清洗后为空则用兜底名
fn sanitize_file_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        let bad = matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            || ch.is_control();
        out.push(if bad { '_' } else { ch });
    }
    let cleaned = out.trim().trim_start_matches('.').trim().to_string();
    if cleaned.is_empty() {
        return DEFAULT_FILE_NAME.to_string();
    }
    if cleaned.to_lowercase().ends_with(".json") {
        cleaned
    } else {
        format!("{cleaned}.json")
    }
}

/// 构造 `CF_HDROP` 的数据块（纯函数，便于单测）：
/// 20 字节头（pFiles=20、pt=(0,0)、fNC=0、fWide=1）+ UTF-16LE 路径 + **双 NUL** 结束。
/// ⚠️ 结构写错的表现是"粘贴出空白/乱码文件名"，而剪贴板行为无法在自动化里自证，
/// 所以这里把布局钉成单测。
fn build_dropfiles_payload(path: &Path) -> Vec<u8> {
    let mut wide: Vec<u16> = path.as_os_str().to_string_lossy().encode_utf16().collect();
    wide.push(0); // 字符串结束
    wide.push(0); // 列表结束（双 NUL）
    let mut buf = vec![0u8; DROPFILES_LEN + wide.len() * 2];
    buf[0..4].copy_from_slice(&(DROPFILES_LEN as u32).to_le_bytes()); // pFiles = 头长度
    buf[16..20].copy_from_slice(&1u32.to_le_bytes()); // fWide = 1 → 路径按 UTF-16 解析
    for (i, w) in wide.iter().enumerate() {
        let at = DROPFILES_LEN + i * 2;
        buf[at..at + 2].copy_from_slice(&w.to_le_bytes());
    }
    buf
}

/// 把单个文件放进剪贴板（Windows）。
#[cfg(windows)]
fn set_clipboard_files(path: &Path) -> Result<(), String> {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let payload = build_dropfiles_payload(path);
    unsafe {
        // hWndNewOwner = 0：剪贴板归当前任务所有
        if OpenClipboard(0) == 0 {
            return Err("打开剪贴板失败（可能被其它程序占用，稍后再试）".to_string());
        }
        let result = (|| -> Result<(), String> {
            if EmptyClipboard() == 0 {
                return Err("清空剪贴板失败".to_string());
            }
            let h = GlobalAlloc(GMEM_MOVEABLE, payload.len());
            if h.is_null() {
                return Err("分配剪贴板内存失败".to_string());
            }
            let p = GlobalLock(h);
            if p.is_null() {
                GlobalFree(h);
                return Err("锁定剪贴板内存失败".to_string());
            }
            std::ptr::copy_nonoverlapping(payload.as_ptr(), p as *mut u8, payload.len());
            GlobalUnlock(h);
            // 成功即把所有权交给系统（**不要**再 GlobalFree）；失败才自己释放
            if SetClipboardData(CF_HDROP, h as isize) == 0 {
                GlobalFree(h);
                return Err("写入剪贴板失败".to_string());
            }
            Ok(())
        })();
        CloseClipboard();
        result
    }
}

/// 导出目录：应用配置目录下的 `export/`（与 config.json 同级）。
/// ⚠️ 剪贴板里放的是**这个目录下文件的路径**，所以导出物必须留在原地（用户粘贴时系统才读得到）。
fn export_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取应用配置目录失败：{e}"))?
        .join("export");
    fs::create_dir_all(&dir).map_err(|e| format!("创建导出目录失败：{e}"))?;
    Ok(dir)
}

/// 导出结果（返回给前端统一处理：成功 / 用户取消 / 错误）。
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportOutcome {
    pub ok: bool,
    /// `clipboard`（Windows）/ `share` / `save`（安卓）
    pub mode: String,
    pub path: String,
    /// 用户主动取消（安卓「保存到本地」被取消）——不是错误，前端显示中性提示
    pub cancelled: bool,
    pub message: String,
}

/// 安卓端插件返回（ConfigExportPlugin.kt 的 JSObject）
#[cfg(target_os = "android")]
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MobileExportResult {
    ok: bool,
    mode: String,
    path: String,
    cancelled: bool,
    message: String,
}

/// 安卓端插件所在包名与类名（@TauriPlugin 注解类，构建时自动注册）
#[cfg(target_os = "android")]
const EXPORT_PACKAGE: &str = "com.apibalance.monitor";
#[cfg(target_os = "android")]
const EXPORT_CLASS: &str = "ConfigExportPlugin";

/// 安卓端插件句柄（仅安卓编译）
#[cfg(target_os = "android")]
pub(crate) struct ConfigExport<R: tauri::Runtime>(tauri::plugin::PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: tauri::Runtime> ConfigExport<R> {
    /// 调 Kotlin 插件：`share`（ACTION_SEND + FileProvider）/ `save`（ACTION_CREATE_DOCUMENT）
    fn run(&self, command: &str, file_name: &str, content: &str) -> Result<MobileExportResult, String> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args<'a> {
            file_name: &'a str,
            content: &'a str,
        }
        self.0
            .run_mobile_plugin(command, Args { file_name, content })
            .map_err(|e| format!("安卓导出失败：{e}"))
    }
}

/// 注册安卓插件（lib.rs 的 Builder 调用；其它平台为 no-op）
pub(crate) fn plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("config-export")
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = (&app, &api);
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(EXPORT_PACKAGE, EXPORT_CLASS)?;
                app.manage(ConfigExport(handle));
            }
            Ok(())
        })
        .build()
}

/// 导出配置文件。
/// - **Windows**：写成 `.json` 并把**文件本身**放进剪贴板（`CF_HDROP`），`mode` 忽略。
/// - **安卓**：`mode = "share"` 走系统分享面板、`"save"` 走系统「保存到本地」，由 Kotlin 插件实现。
/// ⚠️ 必须 `async`：`run_mobile_plugin` 会阻塞当前线程直到 Kotlin 回调 resolve，
///    而 Kotlin 侧的 UI 操作要跑在主线程上 —— 同步命令若占住主线程就会死锁
///    （`browser_login_query` 同样是 async，原因相同）。
#[tauri::command]
pub async fn export_config_file(
    app: AppHandle,
    text: String,
    file_name: String,
    mode: Option<String>,
) -> Result<ExportOutcome, String> {
    if text.trim().is_empty() {
        return Err("导出内容为空".to_string());
    }
    let name = sanitize_file_name(&file_name);

    #[cfg(windows)]
    {
        let _ = mode; // Windows 固定"把文件放进剪贴板"，不需要选择导出方式
        let path = export_dir(&app)?.join(&name);
        fs::write(&path, text.as_bytes()).map_err(|e| format!("写入配置文件失败：{e}"))?;
        set_clipboard_files(&path)?;
        Ok(ExportOutcome {
            ok: true,
            mode: "clipboard".to_string(),
            path: path.to_string_lossy().to_string(),
            cancelled: false,
            message: "已把配置文件放进剪贴板".to_string(),
        })
    }

    // 安卓（2026-09/16）：用户点导出后二选一 —— 系统分享 / 保存到本地，交给 Kotlin 插件
    // （ConfigExportPlugin.kt：ACTION_SEND + FileProvider / ACTION_CREATE_DOCUMENT）
    #[cfg(target_os = "android")]
    {
        let command = if matches!(mode.as_deref(), Some("save")) { "save" } else { "share" };
        let handle = app.state::<ConfigExport<tauri::Wry>>();
        let r = handle.run(command, &name, &text)?;
        Ok(ExportOutcome {
            ok: r.ok,
            mode: r.mode,
            path: r.path,
            cancelled: r.cancelled,
            message: r.message,
        })
    }

    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = (&app, mode);
        Err("当前平台不支持导出配置文件".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 文件名清洗：必须挡住目录穿越与保留字符（文件名由前端传入，不能信任）
    #[test]
    fn sanitize_file_name_blocks_traversal_and_forces_json() {
        assert_eq!(sanitize_file_name("API余额通-配置_260916.1200.json"), "API余额通-配置_260916.1200.json");
        assert_eq!(sanitize_file_name("../../evil.json"), "_.._evil.json");
        assert_eq!(sanitize_file_name("..\\..\\evil"), "_.._evil.json");
        assert_eq!(sanitize_file_name("C:\\Windows\\x.json"), "C__Windows_x.json");
        assert_eq!(sanitize_file_name("a:b*c?d"), "a_b_c_d.json");
        assert_eq!(sanitize_file_name("config"), "config.json", "没有扩展名时补 .json");
        assert_eq!(sanitize_file_name(".hidden"), "hidden.json", "去掉前导点");
        assert_eq!(sanitize_file_name("   "), DEFAULT_FILE_NAME);
        assert_eq!(sanitize_file_name(""), DEFAULT_FILE_NAME);
    }

    /// DROPFILES 布局：头 20 字节、fWide=1、pFiles=20、路径 UTF-16LE、双 NUL 结尾
    #[test]
    fn dropfiles_payload_layout_is_correct() {
        let p = Path::new("C:\\tmp\\a.json");
        let buf = build_dropfiles_payload(p);
        assert_eq!(buf.len(), DROPFILES_LEN + (p.to_string_lossy().encode_utf16().count() + 2) * 2);
        assert_eq!(u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]), DROPFILES_LEN as u32);
        assert_eq!(u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]), 1, "fWide 必须为 1");
        // 路径区按 UTF-16LE 解回来（去掉结尾双 NUL）
        let wide: Vec<u16> = buf[DROPFILES_LEN..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(wide[wide.len() - 1], 0, "末尾 NUL");
        assert_eq!(wide[wide.len() - 2], 0, "列表结束需要双 NUL");
        let text = String::from_utf16(&wide[..wide.len() - 2]).unwrap();
        assert_eq!(text, "C:\\tmp\\a.json");
    }

    /// 含非 ASCII 的文件名必须按 UTF-16 正确往返（否则粘贴出来是乱码名）
    #[test]
    fn dropfiles_payload_handles_non_ascii() {
        let p = Path::new("C:\\导出\\API余额通-配置.json");
        let buf = build_dropfiles_payload(p);
        let wide: Vec<u16> = buf[DROPFILES_LEN..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16(&wide[..wide.len() - 2]).unwrap();
        assert_eq!(text, "C:\\导出\\API余额通-配置.json");
    }
}

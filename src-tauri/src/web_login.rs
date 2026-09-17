//! 安卓端「内嵌 WebView 登录」移动插件：Rust ↔ Kotlin（WebLoginPlugin.kt）桥接。
//! 仅安卓编译；桌面端该模块为空（browser_login_query 走原 Playwright 链路）。

use tauri::Runtime;
#[cfg(target_os = "android")]
use serde::Serialize;
#[cfg(target_os = "android")]
use tauri::plugin::PluginHandle;
#[cfg(target_os = "android")]
use tauri::Manager;

/// Kotlin 插件所在包名与类名（@TauriPlugin 注解类，构建时自动注册）
#[cfg(target_os = "android")]
const WEB_LOGIN_PACKAGE: &str = "com.apibalance.monitor";
#[cfg(target_os = "android")]
const WEB_LOGIN_CLASS: &str = "WebLoginPlugin";

/// 移动端插件句柄（仅安卓编译）。
#[cfg(target_os = "android")]
pub(crate) struct WebLogin<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> WebLogin<R> {
    /// 打开内嵌 WebView 登录页：用户手动登录 → 抓余额接口 → 返回结果（含 cookie 供后续 HTTP 查询）
    pub(crate) fn open_login(
        &self,
        login_url: &str,
        balance_url: &str,
        keyword: &str,
    ) -> Result<crate::network::BrowserLoginResult, String> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args<'a> {
            login_url: &'a str,
            balance_url: &'a str,
            keyword: &'a str,
        }
        self.0
            .run_mobile_plugin(
                "openLogin",
                Args {
                    login_url,
                    balance_url,
                    keyword,
                },
            )
            .map_err(|e| format!("WebView 登录查询失败: {e}"))
    }
}

/// 注册插件（lib.rs 的 Builder 调用；桌面端为 no-op）
pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("web-login")
        .setup(|app, api| {
            #[cfg(not(target_os = "android"))]
            let _ = (&app, &api);
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(WEB_LOGIN_PACKAGE, WEB_LOGIN_CLASS)?;
                app.manage(WebLogin(handle));
            }
            Ok(())
        })
        .build()
}

//! 网络层：所有 HTTP 请求通过 Rust 侧发出（Android WebView 有 CORS 限制，且需要会话保持）。

use std::collections::HashMap;

use reqwest::Proxy;
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

// —— 活跃 node 子进程 PID 追踪（应用退出时终止，防残留）——
use std::sync::Mutex;
static ACTIVE_NODE_PID: Mutex<Option<u32>> = Mutex::new(None);

/// 记录当前浏览器登录查询的 node 进程 PID（仅桌面分支 spawn 后调用）
pub(crate) fn record_node_pid(pid: u32) {
    if let Ok(mut g) = ACTIVE_NODE_PID.lock() {
        *g = Some(pid);
    }
}

/// 清除记录的 PID（查询结束自动调用）
pub(crate) fn clear_node_pid(pid: u32) {
    if let Ok(mut g) = ACTIVE_NODE_PID.lock() {
        if *g == Some(pid) {
            *g = None;
        }
    }
}

/// 应用退出：强制终止仍活跃的 node 子进程（Windows TerminateProcess；其它平台 std kill）
pub(crate) fn kill_active_node() {
    let pid = ACTIVE_NODE_PID.lock().ok().and_then(|mut g| g.take());
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::CloseHandle;
            use windows_sys::Win32::System::Threading::{
                OpenProcess, TerminateProcess, PROCESS_TERMINATE,
            };
            unsafe {
                let h = OpenProcess(PROCESS_TERMINATE, 0, pid);
                if h != 0 {
                    TerminateProcess(h, 1);
                    CloseHandle(h);
                }
            }
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
        }
    }
}

/// RAII：查询结束时自动清除记录的 PID（覆盖所有 return 路径）
pub(crate) struct NodePidGuard(u32);
impl Drop for NodePidGuard {
    fn drop(&mut self) {
        clear_node_pid(self.0);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String, // GET / POST
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>, // 原始请求体（JSON 文本 或 form 编码文本）
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub proxy: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    /// UTF-8 有损文本
    pub body: String,
}

/// 全局网络客户端池：按 proxy 缓存 client，cookie jar 各自保持（登录会话依赖）
pub struct NetState {
    clients: std::sync::Mutex<HashMap<Option<String>, reqwest::Client>>,
}

impl NetState {
    pub fn new() -> Self {
        Self {
            clients: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn client_for(&self, proxy: Option<&str>) -> Result<reqwest::Client, String> {
        let key = proxy.map(|s| s.to_string());
        let mut map = self.clients.lock().unwrap();
        if let Some(c) = map.get(&key) {
            return Ok(c.clone());
        }
        let mut builder = reqwest::Client::builder()
            .cookie_store(true)
            .user_agent("ApiQuotaMonitor/2.0");
        if let Some(p) = &key {
            builder = builder
                .proxy(Proxy::all(p).map_err(|e| format!("代理解析失败: {e}"))?);
        }
        let c = builder.build().map_err(|e| format!("构建网络客户端失败: {e}"))?;
        map.insert(key, c.clone());
        Ok(c)
    }
}

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024; // 响应体上限 10MB，防内存耗尽

#[tauri::command]
pub async fn http_request(
    req: HttpRequest,
    state: State<'_, NetState>,
) -> Result<HttpResponse, String> {
    let client = state.client_for(req.proxy.as_deref())?;
    let method = req.method.to_uppercase();
    let mut builder = match method.as_str() {
        "GET" => client.get(&req.url),
        "POST" => client.post(&req.url),
        _ => return Err(format!("不支持的请求方法: {}", req.method)),
    };
    for (k, v) in &req.headers {
        builder = builder.header(k, v);
    }
    if let Some(ct) = &req.content_type {
        builder = builder.header("content-type", ct);
    }
    if let Some(b) = &req.body {
        builder = builder.body(b.clone());
    }
    // 默认 30s 超时，前端传值仅做覆盖
    builder = builder.timeout(std::time::Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)));
    let started = std::time::Instant::now();
    let resp = builder.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    eprintln!(
        "[net] {} {} -> {} ({:?})",
        method,
        req.url,
        status,
        started.elapsed()
    );
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!("响应体过大（超过 {}MB），已中止读取", MAX_BODY_BYTES / 1024 / 1024));
    }
    let body = String::from_utf8_lossy(&bytes).to_string();
    Ok(HttpResponse { status, body })
}

// —— 站点图标抓取 ——

/// 提取 HTML 中所有 `attr="value"` 的值（单双引号均可）
fn extract_attr_values(html: &str, attr: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    let pat = format!("{attr}=");
    while let Some(idx) = rest.find(&pat) {
        let after = &rest[idx + pat.len()..];
        let after = after.trim_start();
        let (value, consumed) = match after.chars().next() {
            Some('"') => match after[1..].find('"') {
                Some(e) => (after[1..=e].to_string(), e + 2),
                None => break,
            },
            Some('\'') => match after[1..].find('\'') {
                Some(e) => (after[1..=e].to_string(), e + 2),
                None => break,
            },
            _ => break,
        };
        out.push(value);
        rest = &after[consumed.min(after.len())..];
    }
    out
}

/// 提取 HTML 中每个 `<tag ...>` 片段（tag 不区分大小写）
fn tag_fragments<'a>(html: &'a str, tag: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut rest = html;
    let open = format!("<{tag}");
    while let Some(idx) = rest.to_ascii_lowercase().find(&open.to_ascii_lowercase()) {
        let start = &rest[idx..];
        match start.find('>') {
            Some(e) => {
                out.push(&start[..e]);
                rest = &start[e + 1..];
            }
            None => break,
        }
    }
    out
}

/// 把相对地址解析为绝对地址（基于 origin，如 https://host）
fn absolutize(origin: &str, url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if url.starts_with("data:") || url.starts_with("javascript:") || url.starts_with("blob:") {
        return None;
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        return Some(url.to_string());
    }
    if let Some(rest) = url.strip_prefix("//") {
        return Some(format!("https://{rest}"));
    }
    if let Some(rest) = url.strip_prefix('/') {
        return Some(format!("{origin}/{rest}"));
    }
    Some(format!("{origin}/{url}"))
}

/// 简单 HTML 实体解码（覆盖 favicon 常见编码）
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x2F;", "/")
        .replace("&#47;", "/")
}

/// 抓取站点首页 HTML，提取候选图标 URL（按优先级排序）：
///   1) <link rel="icon|shortcut icon|apple-touch-icon">
///   2) 含 "logo" 的 src/href（重点）
///   3) <meta property="og:image">
/// 相对地址解析为绝对地址，去重后返回。
#[tauri::command]
pub async fn fetch_site_icons(host: String, state: State<'_, NetState>) -> Result<Vec<String>, String> {
    eprintln!("[net] icon-fetch called for {host}");
    let client = state.client_for(None)?;
    let url = format!("https://{host}/");
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_millis(15_000))
        .send()
        .await
        .map_err(|e| format!("获取首页失败: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取首页失败: {e}"))?;
    if status != 200 {
        eprintln!("[net] icon {} -> {status} (skip)", url);
        return Ok(Vec::new());
    }
    eprintln!("[net] icon {} -> {status} ({} bytes)", url, body.len());
    let origin = format!("https://{host}");

    let mut ordered: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let push = |ordered: &mut Vec<String>, seen: &mut std::collections::HashSet<String>, v: String| {
        if !v.is_empty() && seen.insert(v.clone()) {
            ordered.push(v);
        }
    };

    // 候选过滤：排除脚本/样式/无图片特征的值（rel=icon 的明确候选除外）
    let plausible = |u: &str| -> bool {
        let lower = u.to_ascii_lowercase();
        if lower.ends_with(".js") || lower.ends_with(".css") || lower.ends_with(".json") {
            return false;
        }
        if lower.contains(".js?") || lower.contains(".css?") {
            return false;
        }
        true
    };
    // "logo" 需作为单词出现（排除 logout 等误匹配）
    let logoish = |u: &str| -> bool {
        let lower = u.to_ascii_lowercase();
        lower.contains("logo") && !lower.contains("logout")
    };
    let plausible_img = |u: &str| -> bool {
        if !plausible(u) {
            return false;
        }
        let lower = u.to_ascii_lowercase();
        let img_ext = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".ico", ".gif", ".avif"];
        img_ext.iter().any(|e| lower.ends_with(e)) || logoish(u) || lower.contains("favicon")
    };

    // 1) <link rel="icon|shortcut icon|apple-touch-icon" href="...">
    for frag in tag_fragments(&body, "link") {
        let rels: Vec<String> = extract_attr_values(frag, "rel");
        let rel_ok = rels.iter().any(|r| {
            let r = r.to_ascii_lowercase();
            r.contains("icon") || r.contains("apple-touch")
        });
        if !rel_ok {
            continue;
        }
        for href in extract_attr_values(frag, "href") {
            if let Some(abs) = absolutize(&origin, &decode_entities(&href)) {
                if plausible(&abs) {
                    push(&mut ordered, &mut seen, abs);
                }
            }
        }
    }

    // 2) 含 "logo" 的 img src / 全页 href/src 含 logo 的（重点）
    for frag in tag_fragments(&body, "img") {
        if !logoish(frag) {
            continue;
        }
        for src in extract_attr_values(frag, "src") {
            if let Some(abs) = absolutize(&origin, &decode_entities(&src)) {
                if plausible_img(&abs) {
                    push(&mut ordered, &mut seen, abs);
                }
            }
        }
    }
    for attr in ["href", "src"] {
        for v in extract_attr_values(&body, attr) {
            if logoish(&v) {
                if let Some(abs) = absolutize(&origin, &decode_entities(&v)) {
                    if plausible_img(&abs) {
                        push(&mut ordered, &mut seen, abs);
                    }
                }
            }
        }
    }

    // 3) <meta property="og:image" content="...">
    for frag in tag_fragments(&body, "meta") {
        if !frag.to_ascii_lowercase().contains("og:image") {
            continue;
        }
        for content in extract_attr_values(frag, "content") {
            if let Some(abs) = absolutize(&origin, &decode_entities(&content)) {
                if plausible_img(&abs) {
                    push(&mut ordered, &mut seen, abs);
                }
            }
        }
    }

    if ordered.is_empty() {
        // 兜底：/favicon.ico（常见约定）
        ordered.push(format!("{origin}/favicon.ico"));
    }
    for (i, u) in ordered.iter().enumerate() {
        eprintln!("[net] icon[{i}] {u}");
    }
    Ok(ordered)
}

// —— 「模拟浏览器登录」兜底查询（按需 spawn 一次性 Node + Playwright 查询） ——

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoginParams {
    pub login_url: String,
    pub balance_url: String,
    #[serde(default)]
    pub balance_keyword: Option<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBalance {
    pub available: Option<f64>,
    pub cash: Option<f64>,
    pub voucher: Option<f64>,
    pub credit: Option<f64>,
    pub owed: Option<f64>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLoginResult {
    pub success: bool,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub extra: String,
    pub balance: Option<BrowserBalance>,
}

// ===== 方案 A：内嵌浏览器运行时（release 单 exe）=====

/// release 构建内嵌的 runtime.zip（minmax 全量：node.exe + node_modules + query_balance.js），
/// 由 打包.ps1 在构建前生成到 src-tauri/runtime.zip（node.exe 压缩后约 38MB）。
#[cfg(not(debug_assertions))]
static RUNTIME_ZIP: &[u8] = include_bytes!("../runtime.zip");

/// 解压内嵌 runtime.zip 到 app_data/runtime/ 并返回该目录（幂等：已释放直接返回）。
/// 目录在 %APPDATA%\com.apibalance.monitor\runtime\（可写），登录态 web_state 随之可写。
#[cfg(not(debug_assertions))]
fn ensure_runtime(app_data: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::io::Read as _;
    let runtime = app_data.join("runtime");
    if runtime.join("query_balance.js").exists() {
        return Ok(runtime);
    }
    eprintln!("[net] 首次使用：解压内嵌浏览器运行时 -> {}", runtime.display());
    std::fs::create_dir_all(&runtime).map_err(|e| format!("创建运行时目录失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(RUNTIME_ZIP))
        .map_err(|e| format!("解析内嵌运行时失败: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取内嵌运行时条目失败: {e}"))?;
        let name = entry.name().replace('\\', "/");
        // zip-slip 防护：拒绝绝对路径与 .. 逃逸
        if name.starts_with('/') || name.split('/').any(|seg| seg == "..") {
            continue;
        }
        let out = runtime.join(&name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            let mut buf = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut buf).map_err(|e| format!("读取条目失败: {e}"))?;
            std::fs::write(&out, &buf).map_err(|e| format!("写入文件失败: {e}"))?;
        }
    }
    Ok(runtime)
}

/// 按需启动 `node minmax/query_balance.js` 完成一次「模拟浏览器登录」查询（查完进程即退出）。
/// 返回 Node 脚本 stdout 的 JSON 结果；超时（180s）或进程失败返回 Err。
#[tauri::command]
pub async fn browser_login_query(
    #[cfg_attr(debug_assertions, allow(unused_variables))]
    app: tauri::AppHandle,
    params: BrowserLoginParams,
) -> Result<BrowserLoginResult, String> {
    #[cfg(target_os = "android")]
    {
        // 安卓（方案 A）：内嵌 WebView 手动登录 + 抓余额（系统 CookieManager 持久化登录态，
        // 用户可真人过验证码/滑块；WebLoginPlugin.kt 返回余额与 cookie）
        let wl = app.state::<crate::web_login::WebLogin<tauri::Wry>>();
        return wl.open_login(
            &params.login_url,
            &params.balance_url,
            params.balance_keyword.as_deref().unwrap_or(""),
        );
    }
    #[cfg(not(target_os = "android"))]
    {
    // —— 定位浏览器运行时目录（含 query_balance.js，node.exe 同目录）——
    // 优先级：
    //   1. exe 同级 minmax/（便携分发：exe 与 minmax 目录放一起，含自带 node.exe）
    //   2. release 内嵌 runtime（方案 A：单 exe，首次调用自动解压到 app_data/runtime）
    //   3. dev 回退项目根 minmax/
    // （注意：不能用 env!("CARGO_MANIFEST_DIR") 单独定位——它是编译期绝对路径，
    //   打包版拷到别处就失效；必须运行时基于 current_exe 推导。
    //   项目路径回退是 src-tauri 上一级（项目根）下的 minmax，即 ../minmax——不是 ../../，
    //   那是 src-tauri 上跳两级（D:\DeepSeek\minmax），历史 bug 根源）
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));
    let mut mm_dir = exe_dir
        .as_ref()
        .map(|d| d.join("minmax"))
        .filter(|d| d.join("query_balance.js").exists());
    #[cfg(not(debug_assertions))]
    if mm_dir.is_none() {
        if let Ok(app_data) = app.path().app_data_dir() {
            if let Ok(r) = ensure_runtime(&app_data) {
                mm_dir = Some(r);
            }
        }
    }
    #[cfg(debug_assertions)]
    if mm_dir.is_none() {
        let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../minmax");
        if dev.join("query_balance.js").exists() {
            mm_dir = Some(dev);
        }
    }
    let mm_dir = mm_dir.ok_or_else(|| "找不到查询脚本 minmax/query_balance.js".to_string())?;
    let script = mm_dir
        .join("query_balance.js")
        .canonicalize()
        .map_err(|e| format!("找不到查询脚本 minmax/query_balance.js: {e}"))?
        // ⚠️ canonicalize 在 Windows 上返回 \\?\ 前缀的 verbatim 路径
        //（GetFinalPathNameByHandleW 默认格式），node 无法解析（实测报
        // `lstat 'D:'` 错误）；剥离前缀后才是 node 能直接运行的普通路径
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string();
    let params_json = serde_json::to_string(&params).map_err(|e| format!("参数序列化失败: {e}"))?;
    // node 可执行文件：优先用运行时目录内的 node.exe（方案 A 单 exe / 便携分发），
    // 没有则回退 PATH 里的 node
    let node_cmd = mm_dir
        .join("node.exe")
        .exists()
        .then(|| mm_dir.join("node.exe").to_string_lossy().trim_start_matches(r"\\?\").to_string());
    let node_used = node_cmd.clone().unwrap_or_else(|| "node (PATH)".to_string());
    // —— 登录态（真实账号会话 cookie）存放目录 ——
    // ⚠️ 2026-09/15 迁移：原先由 query_balance.js 默认写在**项目目录** `minmax/web_state/`，
    //   真实账号会话裸放在源码树里（git init 后一推即泄露）。现改由这里显式指定
    //   应用数据目录（dev = com.apibalance.monitor.dev，release = com.apibalance.monitor），
    //   与 config.json 同级，天然在项目目录之外；Rust 侧不直接读写它，只透传给脚本。
    //   取不到 app_data_dir（极罕见）时不注入该变量 → 脚本回退脚本同级 web_state/（行为同旧版）。
    let app_state_dir = app.path().app_data_dir().ok();
    if let Some(d) = &app_state_dir {
        // 目录缺失时由脚本 mkdirSync 递归创建，这里只做尽力创建
        let _ = std::fs::create_dir_all(d);
    }
    // 诊断：打印实际要 spawn 的 node 与脚本路径（排查 Windows 参数传递问题）
    eprintln!(
        "[net] browser_login spawn: node={:?} args=[{:?}, {:?}] state_dir={:?}",
        node_used,
        script,
        params_json.chars().take(60).collect::<String>(),
        app_state_dir.as_ref().map(|d| d.join("web_state").to_string_lossy().to_string())
    );

    let mut cmd = match &node_cmd {
        Some(n) => std::process::Command::new(n),
        None => std::process::Command::new("node"),
    };
    // 登录态目录通过环境变量透传给脚本（见上方 app_state_dir 说明）
    if let Some(d) = &app_state_dir {
        cmd.env("AQM_WEB_STATE_DIR", d.join("web_state"));
    }
    // Windows：spawn node.exe（控制台子系统）时会新建黑窗口——加 CREATE_NO_WINDOW 静默后台运行
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .arg(&script)
        .arg(&params_json)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 Node 失败（需要 Node.js 且 minmax/node_modules 已就绪）: {e}"))?;

    // 记录 node 子进程 PID（RAII guard 在函数返回时自动清除；应用退出时由 kill_active_node 终止）
    let pid = child.id();
    record_node_pid(pid);
    let _node_pid_guard = NodePidGuard(pid);

    let mut out_reader = child.stdout.take().ok_or("无法读取输出")?;
    let mut err_reader = child.stderr.take().ok_or("无法读取错误")?;
    use std::io::Read;
    let out_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out_reader.read_to_string(&mut s);
        s
    });
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = err_reader.read_to_string(&mut s);
        s
    });

    // 超时给足：脚本最坏路径（直连超时→重新登录→跳页→等接口）实测约 2 分钟，
    // 90s 会误杀导致「查询超时」；180s 留足余量（用户在 UI 侧可感知等待，但至少能拿到结果）
    let timeout = std::time::Duration::from_secs(180);
    let start = std::time::Instant::now();
    let mut killed = false;
    loop {
        if let Some(_status) = child.try_wait().map_err(|e| format!("等待 Node 进程失败: {e}"))? {
            break;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            killed = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
    }
    let out = out_thread.join().map_err(|_| "读取输出失败".to_string())?;
    let err = err_thread.join().map_err(|_| "读取错误失败".to_string())?;
    if killed {
        return Err("查询超时（180 秒），已终止".to_string());
    }
    let trimmed = out.trim();
    if !trimmed.is_empty() {
        return serde_json::from_str(trimmed)
            .map_err(|e| format!("解析查询结果失败: {e}（{}）", trimmed.chars().take(200).collect::<String>()));
    }
    Err(format!(
        "查询失败：{}",
        err.trim().chars().take(500).collect::<String>()
    ))
    }
}


// ===== 方案 A 内嵌运行时释放逻辑测试（仅 release 配置编译内嵌 blob）=====
#[cfg(all(test, not(debug_assertions)))]
mod runtime_extract_tests {
    use super::*;

    #[test]
    fn ensure_runtime_extracts_and_idempotent() {
        let tmp = std::env::temp_dir().join("aqm_runtime_test");
        let _ = std::fs::remove_dir_all(&tmp);
        let r = ensure_runtime(&tmp).expect("首次解压应成功");
        assert!(r.join("query_balance.js").exists(), "query_balance.js 应已释放");
        assert!(r.join("node.exe").exists(), "node.exe 应已释放");
        assert!(r.join("node_modules").exists(), "playwright 依赖目录应已释放");
        // 幂等：二次调用不重复解压
        let r2 = ensure_runtime(&tmp).expect("幂等调用应成功");
        assert_eq!(r, r2);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

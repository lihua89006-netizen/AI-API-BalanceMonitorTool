//! 配置存储：config.json 读写（应用配置目录），原子写入 + 损坏回退默认。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderEntry {
    pub uid: String,
    pub provider_id: String,
    pub display_name: String,
    pub enabled: bool,
    pub auto_refresh_minutes: i64,
    #[serde(default)]
    pub config: Value, // 站点自定义字段（api_key / base_url 等）
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub auto_refresh_minutes: i64,
    pub theme: String, // light / dark / system
    pub providers: Vec<ProviderEntry>,
    /// 背景壁纸：anime（动漫图，默认）/ aurora（极光渐变）/ plain（纯色）/ custom（自定义图片）
    pub wallpaper: String,
    /// 自定义壁纸文件路径（wallpaper=custom 时生效）
    pub wallpaper_file: Option<String>,
    /// 挂件窗口大小（逻辑像素，宽×高）；None = 默认 308×308
    pub show_widget_size: Option<(f64, f64)>,
    /// 挂件窗口位置（逻辑像素，左上角）；None = 系统默认放置
    pub show_widget_pos: Option<(f64, f64)>,
    /// 主窗口位置（逻辑像素，左上角）；None = 系统默认放置
    pub main_window_pos: Option<(f64, f64)>,
    /// 主窗口大小（逻辑像素，宽×高）；None = 配置默认（437×600）
    pub main_window_size: Option<(f64, f64)>,
    /// 「今日已用」的当日余额基准（按站点 uid）
    pub usage_baselines: std::collections::HashMap<String, UsageBaseline>,
    /// 启动自动打开桌宠（挂件）的**模式**（2026-09/16 用户口径，设置页下拉框三选一）：
    /// `"off"` 关闭自动 / `"last"` 上次站点 / `"pinned"` 置顶站点（站点列表第一张卡）。
    /// ⚠️ 空串 = 老配置没有这个字段 → 由下面的布尔字段 `auto_open_widget` 推导（true → "last"）。
    /// 判定在前端 `src/lib/autoWidget.ts::autoWidgetMode()`（有单测）；Rust 侧只负责存。
    pub auto_open_widget_mode: String,
    /// ⚠️ **老字段**（早期只有这个开关）：现在只作兼容读取与同步回写，判断一律看
    /// `auto_open_widget_mode`。前端保存时两者一起写（mode != "off" ⇔ true），
    /// 因此老版本/老文档里的语义仍然成立。
    pub auto_open_widget: bool,
    /// 上次打开的挂件站点 uid（「上次站点」模式启动时用它还原上次那个挂件；None = 还没开过）
    pub last_widget_uid: Option<String>,
    /// 安卓端桌宠（系统悬浮窗）边长（dp）；None = 默认 150dp（2026-09/19）
    pub mobile_widget_size: Option<i32>,
    /// 安卓端桌宠左上角位置（屏幕像素，绝对坐标）；None = 首次打开落在右侧偏下
    pub mobile_widget_pos: Option<(i32, i32)>,
}

/// 「今日已用」的当日**余额观测**记录（按站点 uid 存一条）。
///
/// ⚠️ **口径：消费只由"下降"构成**（2026-09/16 换模型，对齐开源实现
/// `MeteorNOX/DeepSeek-Balance-Whale-Widget` 的账本思路）：
///
/// 余额接口只给**快照**、不给流水，所以"余额涨了"既可能是充值、也可能是赠金/纠错。
/// 旧模型把充值当成**修正项**加进消费里（`水位 + 已登记充值 − 当前余额`），结果：
/// 充值被算了两次（水位里一次、`recharged` 又一次）→ 显示值恒多出整整一个充值额；
/// 判据下界被抬到 `水位 + 充值` → 之后再充小额永不提示。
///
/// 现改为**升降分开累计**：
///   - 每次观测与上次读数比较：**下降**累加进 `debit`（= 今日已用）、**上升**累加进 `credit`（只记录）
///   - 充值在结构上**不可能**污染消费：数字单调不减、恒 ≥ 0，也不需要用户登记任何金额
///   - 代价（如实的边界）：余额快照没有流水，**起点之前的消费不在本区间内**；
///     且"充值"与"消费"落在同一次刷新间隔内时，净结果是一次上升 → 那部分消费观测不到
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct UsageBaseline {
    /// 当日**首个**观测到的余额（本统计区间的期初；诊断与将来扩展用）。
    /// 老配置里同义字段叫 `value`，故用 serde alias 兼容读取。
    #[serde(alias = "value")]
    pub opening: f64,
    pub currency: String,
    /// 记录日期（YYYY-MM-DD，**本机时区**）
    pub day: String,
    /// 上次读到的余额
    pub last: f64,
    /// 上次观测时刻（毫秒时间戳；用于丢弃重复/迟到的样本）
    pub last_at: u64,
    /// 当日**累计下降** —— 这就是「今日已用」
    pub debit: f64,
    /// 当日**累计上升**（充值 / 赠金 / 纠错）。只记录、**不参与消费计算**；
    /// 留着是为了诊断（"今天确实入账过"）与将来做"余额校正"时用。
    pub credit: f64,
}

/// 配置写锁：串行化 read-modify-write 命令，避免并发覆盖丢更新
pub struct ConfigState {
    pub lock: Mutex<()>,
}

impl ConfigState {
    pub fn new() -> Self {
        Self { lock: Mutex::new(()) }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    Ok(dir.join("config.json"))
}

fn backup_broken(path: &PathBuf) {
    let bak = path.with_extension("json.bak");
    let _ = fs::copy(path, bak);
}

/// 剥离 UTF-8 BOM（EF BB BF）。
///
/// ⚠️ 为什么需要它（2026-09/15 实测踩到）：`serde_json::from_str` 把 BOM 也当成 JSON 文本的一部分，
/// 于是报 "expected value at line 1 column 1"；对用户而言后果很重——`load_config` 会判定「配置损坏」，
/// 备份后**回退默认值**，接着任何一次保存都会把默认值写回，用户的站点与 API Key 就此丢失。
/// 而用文本编辑器 / 记事本另存、或 PowerShell 5.1 的 `Set-Content -Encoding UTF8` 写出的 JSON 都会带 BOM，
/// 完全可能出现这种「看起来是合法 JSON」的文件。故这里主动容错。
fn strip_utf8_bom(bytes: &[u8]) -> &[u8] {
    if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
        &bytes[3..]
    } else {
        bytes
    }
}

pub(crate) fn load_config(app: &AppHandle) -> AppConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return AppConfig::default(),
    };
    match fs::read(&path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(strip_utf8_bom(&bytes));
            match serde_json::from_str::<AppConfig>(&text) {
                Ok(cfg) => cfg,
                Err(e) => {
                    // 配置损坏：备份原文件再回退默认，避免静默覆盖导致站点与密钥丢失
                    backup_broken(&path);
                    eprintln!("[config] config.json 损坏（{e}），已备份为 config.json.bak 并回退默认");
                    AppConfig::default()
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppConfig::default(),
        Err(e) => {
            eprintln!("[config] 读取 config.json 失败（{e}）");
            AppConfig::default()
        }
    }
}

pub(crate) fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let s = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(&tmp, s).map_err(|e| format!("写入配置失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存配置失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> AppConfig {
    load_config(&app)
}

#[tauri::command]
pub fn save_config_cmd(app: AppHandle, state: State<'_, ConfigState>, cfg: AppConfig) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(|_| "获取配置锁失败".to_string())?;
    save_config(&app, &cfg)
}

#[tauri::command]
pub fn upsert_provider(
    app: AppHandle,
    state: State<'_, ConfigState>,
    entry: ProviderEntry,
) -> Result<AppConfig, String> {
    let _guard = state.lock.lock().map_err(|_| "获取配置锁失败".to_string())?;
    let mut cfg = load_config(&app);
    if let Some(p) = cfg.providers.iter_mut().find(|p| p.uid == entry.uid) {
        *p = entry;
    } else {
        cfg.providers.insert(0, entry); // 新增站点置顶（用户要求：添加后卡片出现在最上面）
    }
    save_config(&app, &cfg)?;
    Ok(cfg)
}

/// 保存自定义壁纸图片（base64 → app_config_dir/wallpapers/custom.png）
/// 返回壁纸文件的绝对路径；前端用 convertFileSrc(path) 加载
#[tauri::command]
pub fn save_wallpaper(app: AppHandle, data: String) -> Result<String, String> {
    // 去除 data URL 前缀（如 data:image/png;base64,）
    let b64 = data
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(data.as_str())
        .trim();
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("壁纸图片解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("壁纸图片为空".to_string());
    }
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("壁纸图片过大（上限 20MB）".to_string());
    }
    let dir = config_path(&app)?; // …/config.json → …目录
    let wall_dir = dir.parent().map(|p| p.join("wallpapers")).ok_or("配置目录异常")?;
    fs::create_dir_all(&wall_dir).map_err(|e| format!("创建壁纸目录失败: {e}"))?;
    let path = wall_dir.join("custom.png");
    fs::write(&path, &bytes).map_err(|e| format!("保存壁纸失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn remove_provider(app: AppHandle, state: State<'_, ConfigState>, uid: String) -> Result<AppConfig, String> {
    let _guard = state.lock.lock().map_err(|_| "获取配置锁失败".to_string())?;
    let mut cfg = load_config(&app);
    cfg.providers.retain(|p| p.uid != uid);
    cfg.usage_baselines.remove(&uid); // 站点删除时一并清掉当日基准，避免残留无效键
    save_config(&app, &cfg)?;
    Ok(cfg)
}

/// 金额定点标度：8 位小数（对齐参考实现的记账口径）。
///
/// ⚠️ 为什么要定点：`debit`/`credit` 是**逐次观测累加**出来的，直接用 f64 相加会让误差
/// 随刷新次数累积（一天几百次刷新，0.01 级噪声足以让显示末位乱跳）。累加前换算成整数单位
/// 相加、再换回来，误差不累积；`config.json` 里仍是可读的小数（人可手改）。
const MONEY_SCALE: f64 = 100_000_000.0;

/// 金额 → 定点整数单位（8 位小数）
fn money_units(v: f64) -> i64 {
    (v * MONEY_SCALE).round() as i64
}

/// 定点整数单位 → 金额
fn units_to_money(u: i64) -> f64 {
    u as f64 / MONEY_SCALE
}

/// 一次观测的结果（返回给前端做诊断；单测用它断言，避免测试重写一遍逻辑）
#[derive(Debug, PartialEq)]
pub(crate) enum Observed {
    /// 建立了新的统计区间（当天首个读数 / 跨天 / 币种变化）
    Rebuilt,
    /// 样本被丢弃（重复或迟到）
    Stale,
    /// 累加了一次下降（= 消费）
    Debit(f64),
    /// 累加了一次上升（充值 / 赠金 / 纠错；只记录，不进消费）
    Credit(f64),
    /// 读数与上次完全相同
    Same,
}

/// 建立一条「当天」的观测记录（首次 / 跨天 / 币种变化时调用）——
/// **唯一会重置累计量的地方**。
///
/// ⚠️ 起点之前的消费不在本区间内：余额接口只给快照、没有流水，这是本地推算的固有边界
/// （参考实现也把同一条写进了它的排障说明，用户可见）。
pub(crate) fn fresh_baseline(value: f64, currency: String, day: String, at: u64) -> UsageBaseline {
    UsageBaseline {
        opening: value,
        currency,
        day,
        last: value,
        last_at: at,
        debit: 0.0,
        credit: 0.0,
    }
}

/// 把一次余额观测应用到当日记录上（**纯函数**，生产与单测共用同一份逻辑）。
///
/// 三条不变量（"消费只由下降构成"的落地）：
///   1. **只有下降进 `debit`**：下降累加、上升只记 `credit` → 充值不可能让数字变大或变小；
///   2. `at <= last_at` 的重复/迟到样本**原样丢弃**（挂件 60s 刷新与主界面各自上报，会乱序到达；
///      照收会凭空造出一段"下降"或"上升"）；
///   3. 跨天或**币种变化**一律重建区间（币种切换造成的数值跳变不是消费——参考实现踩过：
///      币种随机切换曾把每次跳变记成一笔消费、单日虚记数千元）。
pub(crate) fn observe(
    b: &mut UsageBaseline,
    value: f64,
    currency: &str,
    day: &str,
    at: u64,
) -> Observed {
    // ⚠️ "是否已有本区间"**只靠 day + 币种**判定：不要拿 `last_at > 0` 当哨兵 ——
    //    那样 `at = 0` 的样本永远建不起区间（每次都被判成"重建"，白白吃掉一次累计）。
    //    空记录的 `day` 是空串，与任何真实日期都不相等，天然就是"没有区间"。
    let same_window = b.day == day && b.currency.eq_ignore_ascii_case(currency);
    if !same_window {
        *b = fresh_baseline(value, currency.to_string(), day.to_string(), at);
        return Observed::Rebuilt;
    }
    if at <= b.last_at {
        return Observed::Stale;
    }
    let prev = money_units(b.last);
    let now = money_units(value);
    // ⚠️ 方向定义：`delta > 0` = **本次读数比上次低**（余额下降）→ 消费。
    //    这里必须用 `prev - now`：写成 `now - prev` 会把"充值"记成消费（本模块第一版就写反过，
    //    靠单测 `only_decreases_count_as_usage` 抓出来的）。
    let delta = prev - now;
    b.last = units_to_money(now);
    b.last_at = at;
    if delta > 0 {
        b.debit = units_to_money(money_units(b.debit) + delta);
        Observed::Debit(units_to_money(delta))
    } else if delta < 0 {
        b.credit = units_to_money(money_units(b.credit) - delta);
        Observed::Credit(units_to_money(-delta))
    } else {
        Observed::Same
    }
}

/// 记录一次余额观测，并把**下降**累加进当日消费（`debit`）。
///
/// - `day` 由前端传入（JS 本地日期 = 用户本机时区），Rust 侧不做时区换算；
/// - `at` = 该次读数的时刻（毫秒），用于丢弃重复/迟到样本；
/// - 返回值只作诊断（前端不依赖它做业务判断，避免"读失败就整块不显示"）。
#[tauri::command]
pub fn record_usage_baseline(
    app: AppHandle,
    state: State<'_, ConfigState>,
    uid: String,
    value: f64,
    currency: String,
    day: String,
    at: u64,
) -> Result<serde_json::Value, String> {
    if uid.trim().is_empty() {
        return Err("uid 为空".to_string());
    }
    if day.trim().is_empty() {
        return Err("day 为空".to_string());
    }
    if currency.trim().is_empty() {
        return Err("currency 为空".to_string());
    }
    if !value.is_finite() {
        return Err("value 非有限数".to_string());
    }
    let _guard = state.lock.lock().map_err(|_| "获取配置锁失败".to_string())?;
    let mut cfg = load_config(&app);
    let mut base = cfg.usage_baselines.remove(&uid).unwrap_or_default();
    let outcome = observe(&mut base, value, currency.trim(), &day, at);
    let (kind, delta, accepted) = match outcome {
        Observed::Rebuilt => ("rebuilt", 0.0, true),
        Observed::Stale => ("stale", 0.0, false),
        Observed::Same => ("same", 0.0, true),
        Observed::Debit(d) => ("debit", d, true),
        Observed::Credit(c) => ("credit", c, true),
    };
    let snapshot = (base.opening, base.debit, base.credit);
    cfg.usage_baselines.insert(uid, base);
    // 被丢弃的样本不写盘（既不推进 last_at，也不制造一次无意义的写）
    if accepted {
        save_config(&app, &cfg)?;
    }
    Ok(serde_json::json!({
        "accepted": accepted,
        "kind": kind,
        "delta": delta,
        "opening": snapshot.0,
        "debit": snapshot.1,
        "credit": snapshot.2,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BOM 容错：带 BOM 的合法 JSON 必须能被解析（否则会误判「配置损坏」并回退默认、丢站点）
    #[test]
    fn strip_utf8_bom_handles_bom_and_plain() {
        let plain: &[u8] = br#"{"theme":"light"}"#;
        assert_eq!(strip_utf8_bom(plain), plain);

        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(plain);
        assert_eq!(strip_utf8_bom(&with_bom), plain);

        // 只有部分 BOM 前缀时不得误剥
        assert_eq!(strip_utf8_bom(&[0xEF, 0xBB]), &[0xEF, 0xBB]);
        assert_eq!(strip_utf8_bom(&[]), &[] as &[u8]);
    }

    /// 关键回归：BOM + 合法配置 → 解析成功（修复前这里会失败并回退默认值）
    #[test]
    fn config_with_bom_parses_instead_of_falling_back_to_default() {
        // 注意：字节串字面量 b".." 不允许非 ASCII，故用普通字符串再取字节
        let json = r#"{"autoRefreshMinutes":30,"theme":"dark","providers":[{"uid":"p-1","providerId":"deepseek_official","displayName":"DeepSeek官方","enabled":true,"autoRefreshMinutes":0,"config":{"api_key":"sk-x"}}],"usageBaselines":{"p-1":{"value":9.44,"currency":"CNY","day":"2026-09-15"}}}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(json.as_bytes());
        let text = String::from_utf8_lossy(strip_utf8_bom(&bytes)).to_string();
        let cfg: AppConfig = serde_json::from_str(&text).expect("带 BOM 的配置应能解析");
        assert_eq!(cfg.theme, "dark");
        assert_eq!(cfg.providers.len(), 1);
        assert_eq!(cfg.providers[0].uid, "p-1");
        assert_eq!(cfg.providers[0].display_name, "DeepSeek官方");
        assert_eq!(cfg.usage_baselines.get("p-1").map(|b| b.day.as_str()), Some("2026-09-15"));
        // 老配置里的 `value`（当日首次余额）经 serde alias 读进新字段 `opening`
        assert_eq!(cfg.usage_baselines.get("p-1").map(|b| b.opening), Some(9.44));

        // 反证：不剥 BOM 时确实会失败（说明这个容错不是多余的）
        let raw = String::from_utf8_lossy(&bytes).to_string();
        assert!(serde_json::from_str::<AppConfig>(&raw).is_err());
    }

    /// usageBaselines 缺省兼容：老配置（无该字段）必须仍能加载，且序列化后可回读
    #[test]
    fn usage_baselines_is_optional_and_roundtrips() {
        let legacy = br#"{"theme":"light","providers":[]}"#;
        let cfg: AppConfig = serde_json::from_str(std::str::from_utf8(legacy).unwrap()).unwrap();
        assert!(cfg.usage_baselines.is_empty());

        let mut cfg2 = cfg.clone();
        cfg2.usage_baselines
            .insert("p-1".to_string(), fresh_baseline(4.38, "CNY".into(), "2026-09-15".into(), 1));
        let json = serde_json::to_string(&cfg2).unwrap();
        assert!(json.contains("usageBaselines"), "应序列化为 camelCase：{json}");
        assert!(json.contains("lastAt"), "观测时刻也要落盘：{json}");
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.usage_baselines.get("p-1").map(|b| b.currency.as_str()), Some("CNY"));
        assert_eq!(back.usage_baselines.get("p-1").map(|b| b.opening), Some(4.38));
    }

    /// **核心不变量（本次换模型的理由）**：只有"下降"进消费，充值在结构上不可能污染它。
    ///
    /// 序列：100 →（用掉 20）80 →（充 50）130 →（用掉 5）125
    /// 真实消费 = 20 + 5 = 25；旧公式 `水位 + 已登记充值 − 当前` 在同一条序列上会算出
    /// 一个虚高的数（充值得被算两次），而现在的 `debit` 恒等于 25。
    #[test]
    fn only_decreases_count_as_usage() {
        let mut b = fresh_baseline(100.0, "CNY".into(), "2026-09-16".into(), 1);
        assert_eq!(observe(&mut b, 80.0, "CNY", "2026-09-16", 2), Observed::Debit(20.0));
        assert_eq!(b.debit, 20.0, "下降进入消费");
        assert_eq!(b.credit, 0.0);

        assert_eq!(observe(&mut b, 130.0, "CNY", "2026-09-16", 3), Observed::Credit(50.0));
        assert_eq!(b.debit, 20.0, "★ 充值不得让消费变大哪怕一分");
        assert_eq!(b.credit, 50.0, "上升只记录在 credit 里");

        assert_eq!(observe(&mut b, 125.0, "CNY", "2026-09-16", 4), Observed::Debit(5.0));
        assert_eq!(b.debit, 25.0, "消费 = 20 + 5（充值前的消费没被冲掉）");
        assert_eq!(b.opening, 100.0, "期初余额全程不变");
    }

    /// 重复/迟到样本必须丢弃：挂件 60s 刷新与主界面各自上报，会乱序到达；
    /// 照收会凭空造出一段"下降"或"上升"（按时间戳单调递增判定）。
    #[test]
    fn stale_and_duplicate_samples_are_ignored() {
        let mut b = fresh_baseline(50.0, "CNY".into(), "2026-09-16".into(), 1000);
        // 迟到的旧样本（时间更早）→ 丢弃，且不推进 last_at
        assert_eq!(observe(&mut b, 40.0, "CNY", "2026-09-16", 900), Observed::Stale);
        assert_eq!(b.debit, 0.0, "迟到样本不得计入消费");
        assert_eq!(b.last_at, 1000);
        // 同一时刻重复上报 → 同样丢弃
        assert_eq!(observe(&mut b, 40.0, "CNY", "2026-09-16", 1000), Observed::Stale);
        assert_eq!(b.debit, 0.0);
        // 时间更晚的正常样本照收
        assert_eq!(observe(&mut b, 40.0, "CNY", "2026-09-16", 1001), Observed::Debit(10.0));
        assert_eq!(b.debit, 10.0);
        // 读数相同：既不算消费也不算入账
        assert_eq!(observe(&mut b, 40.0, "CNY", "2026-09-16", 1002), Observed::Same);
        assert_eq!(b.debit, 10.0);
    }

    /// 跨天 / 币种变化都要**重建统计区间**（币种切换的数值跳变不是消费——
    /// 参考实现踩过：币种随机切换曾把每次跳变记成一笔消费、单日虚记数千元）。
    #[test]
    fn day_and_currency_change_rebuild_window() {
        let mut b = fresh_baseline(80.0, "CNY".into(), "2026-09-15".into(), 1);
        observe(&mut b, 60.0, "CNY", "2026-09-15", 2);
        assert_eq!(b.debit, 20.0);

        // 跨天：累计清零、期初取新一天首个读数
        assert_eq!(observe(&mut b, 55.0, "CNY", "2026-09-16", 3), Observed::Rebuilt);
        assert_eq!(b.debit, 0.0, "隔天重新开始累计");
        assert_eq!(b.opening, 55.0);
        assert_eq!(b.day, "2026-09-16");

        // 币种变化：同样重建（不是消费）
        observe(&mut b, 40.0, "CNY", "2026-09-16", 4);
        assert_eq!(b.debit, 15.0);
        assert_eq!(observe(&mut b, 6.0, "USD", "2026-09-16", 5), Observed::Rebuilt);
        assert_eq!(b.debit, 0.0, "币种变了不得把 34 元差额算成消费");
        assert_eq!(b.currency, "USD");
    }

    /// 定点累加不漂移：300 次 0.01 的下降必须精确等于 3.00（f64 直接相加会差 1e-13 量级）。
    /// ⚠️ 测试自己必须给**精确**的读数序列（用整数分构造），否则测的是测试的浮点误差。
    #[test]
    fn accumulation_does_not_drift() {
        let mut b = UsageBaseline::default();
        // 第一次观测（100.00）建立区间，之后 300 次各降 0.01
        for i in 0..=300u64 {
            observe(&mut b, (10000 - i) as f64 / 100.0, "CNY", "2026-09-16", i + 1);
        }
        assert_eq!(b.opening, 100.0);
        assert_eq!(b.debit, 3.0, "累计下降必须精确，不得有浮点漂移");
    }
}

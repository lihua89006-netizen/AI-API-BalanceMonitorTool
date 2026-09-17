# API余额通

跨平台 API 余额集中监控工具：把各大模型 API 网站的剩余额度集中显示在一个窗口里。

Windows 上是「主窗口卡片网格 + 鲸鱼娘挂件（独立置顶小窗）」，Android 上是响应式卡片列表。

ps.挂件可以常驻显示单个站点的余额与「今日已用」，充值不会再污染这个数字（消费只由余额的下降累加）。

也可以自己用 AI 工具添加不同站点及余额获取方式（见「添加新站点的适配器」）。

点展示键就会变成可爱鲸鱼娘，自动置顶、可变大小、点击刷新、空白处可穿透。

<!-- 截图：把你的截图直接拖进这段注释下方，GitHub 会自动生成图片链接；
     下面两张是仓库里已有的图，作为临时占位，替换掉即可 -->
<img width="160" alt="图标" src="public/app-icon.png" />
<img width="360" alt="挂件背景" src="public/background.png" />

点击下载👉[![最新版本](https://img.shields.io/github/v/release/lihua89006-netizen/AI-API-BalanceMonitorTool?label=最新版本&color=blue)](https://github.com/lihua89006-netizen/AI-API-BalanceMonitorTool/releases/latest)

---

以下为AI生成👇

跨平台的 API 余额监控工具：把各网站的大模型 API 剩余额度集中显示。Windows 端为主窗口（卡片网格，
可调整大小、退出记忆位置与尺寸）+ 鲸鱼娘挂件（独立无边框置顶透明小窗，单击/60s 刷新、拖动、
滚轮缩放、空白处点击穿透、大小位置记忆）；Android 端为响应式适配（无挂件）。
视觉为 Apple 风玻璃拟态 + 壁纸背景（深浅色可切换）。

## 运行（源码方式）

需要 Node 20+ / pnpm 11 / Rust 1.98（MSVC）+ WebView2：

```bash
pnpm install
pnpm dev:app            # 桌面开发（= tauri dev --config src-tauri/tauri.dev.conf.json）

pnpm exec tsc --noEmit  # 类型检查
pnpm test               # 前端单测（vitest）
cd src-tauri; cargo test --lib   # 后端单测
```

> ⚠️ 起 dev 必须用 `pnpm dev:app`。裸 `pnpm tauri dev` 会与桌面打包版**共用 identifier 与配置目录**
> → 单实例锁互踢、`config.json` 互相覆盖。dev 使用独立 identifier `com.apibalance.monitor.dev`。

## 打包

```powershell
powershell -File 打包.ps1            # 桌面免安装单文件 exe（会自动生成并内嵌 Node 运行时）
powershell -File 打包.ps1 -Android   # 额外出 aarch64 最小 APK（需在 UAC 弹窗点「是」）
```

- 产物自动带时间戳复制到桌面：`API余额通_<yyMMdd.HHmm>.exe` / `API余额通-安卓_<yyMMdd.HHmm>.apk`，
  并自动清理桌面上的旧包（只保留最新一个）
- 桌面 exe 约 62MB 单文件、**免安装**：目标机只需系统 Edge（Win10/11 标配）+ WebView2 + VC++ 运行库
- 打包前会生成 `src-tauri/runtime.zip`（`minmax/` 全量压缩，**已剔除 `web_state/` 登录态**）并嵌入 exe；
  `cargo build --release` 直接跑会因缺该文件失败，请走脚本
- 安卓整包构建需要管理员权限（Windows 符号链接）；拿不到提权时的两道编译门见 `交接文档.md` §7.6
- 本机模拟器 `tauri_avd` 是 **x86_64** 镜像：想在模拟器上验证，请用**不带 `--target`** 的全 ABI 包
  （`pnpm tauri android build --apk`）；真机分发建议 `--target aarch64`（约 31MB）

## 添加新站点的适配器

1. 在 `src/providers/` 下新建文件，实现 `Provider` 接口（可参考 `deepseek.ts`、`openai_compat.ts`）：

   ```ts
   import type { Provider, QuotaInfo } from './types'
   import { num, parseJsonResponse } from './types'

   export const mySiteProvider: Provider = {
     id: 'my_site',
     name: '我的站点',
     description: '一句话说明余额从哪来',
     websiteUrl: 'https://example.com',
     configSchema: [
       { key: 'api_key', label: 'API Key', type: 'password', required: true },
     ],
     async fetch(client, config): Promise<QuotaInfo> {
       const resp = await client.request({
         method: 'GET',
         url: 'https://example.com/api/balance',
         headers: { Authorization: `Bearer ${String(config.api_key ?? '')}` },
       })
       const data = parseJsonResponse(resp, 'balance')
       const inner = data.data as Record<string, unknown> | undefined
       return {
         ok: true,
         providerId: 'my_site',
         displayName: '我的站点',
         message: 'ok',
         remaining: num(inner?.balance),
         currency: 'CNY',
       }
     },
   }
   ```

2. 在 `src/providers/registry.ts` 的 `PROVIDERS` 数组里注册一行（顺序 = 「添加站点」里的类型顺序）。

3. 重新构建即可，界面无需任何改动。表单字段由 `configSchema` 自动渲染
   （`advanced: true` 收进「高级设置」折叠区，`desktopOnly: true` 在安卓端隐藏）。

## 目录结构

```
api-quota-monitor-tauri/
├── src/                       前端（React 19 + TypeScript + Vite）
│   ├── App.tsx                主界面（概览 / 卡片网格 / 各弹窗）
│   ├── app.css styles/        主样式与主题变量（深浅色 + 壁纸）
│   ├── components/            SiteCard / SiteDialog / SiteActionsDialog / SyncDialog /
│   │                          SettingsDialog / PlanFilterDialog / MenuSelect / Toast …
│   ├── widget/                鲸鱼娘挂件（WidgetApp）+ 独立设置面板（WidgetMenuApp）
│   ├── lib/                   store / worker / net / sync / crypto / usage / autoWidget /
│   │                          plans / deepseekPeak / fmt / theme / tooltip
│   └── providers/             适配器层（8 个内置 + registry 注册表）
├── src-tauri/                 后端（Rust）
│   ├── src/                   lib.rs（入口/单实例/窗口记忆）/ network.rs（HTTP 与代理）/
│   │                          config.rs（config.json + 余额观测账本）/ widget.rs（挂件窗口）/
│   │                          widget_menu.rs（独立设置面板）/ web_login.rs（安卓 WebView 登录）/
│   │                          export.rs（导出配置）
│   ├── capabilities/          窗口权限（main / widget / widget-menu）
│   ├── tauri.conf.json        窗口与打包配置（dev 另有 tauri.dev.conf.json）
│   └── gen/android/           Android 工程（含手写的 Kotlin 插件）
├── test/                      前端单测（vitest）
├── probe/                     开发期量测夹具（仅 dev 注入，生产构建零注入）
├── minmax/                    「模拟浏览器登录」的 Node + Playwright 查询脚本
├── 打包.ps1                   一键打包脚本（桌面 exe / +安卓 APK）
├── config.example.json        配置模板（复制为 config.json 后填自己的 Key）
└── 交接文档.md                完整架构、每轮改动与踩坑记录
```

## 验证方式

- `pnpm test`：前端单测（适配器 / 同步导出 / 加密 / 今日已用 / 峰谷倒计时 / 金额格式化 / 启动模式）
- `cd src-tauri; cargo test --lib`：后端单测（配置 BOM 容错、余额观测账本、导出文件名与剪贴板布局、面板定位）
- `pnpm exec tsc --noEmit` 与 `cargo check`：编译门
- `probe/`：开发期量测夹具（屏幕捕获 + 探针，仅 dev 生效）——把「抖 / 糊 / 手感」这类主观问题变成可比数字
- `交接文档.md` §11：每轮改动的「问题 / 改法 / 验证」三段记录

## ⚠️ 安全提醒

- `config.json` 里保存的是**明文 API Key**，以及阿里云 / 火山引擎的 **AccessKey Secret**（云账户钥匙，
  权限更高）。Windows 位置：`%APPDATA%\com.apibalance.monitor\`（dev 为 `...monitor.dev\`）。
  **请勿分享、勿提交到 Git**（已在 `.gitignore` 中排除）。首次使用可复制 `config.example.json` 为
  `config.json` 并替换占位值。
- 「导出配置文件」导出的内容**含 Key**：界面有警示，默认走口令加密（`AQM2:`，60 万次 PBKDF2）；
  口令丢失无法恢复。
- 「模拟浏览器登录」的会话 cookie 存在应用配置目录的 `web_state/`（不在仓库内）。
  ⚠️ **不要把它打进任何压缩包再提交**——本项目踩过一次：旧手工分发包里带着登录态，
  只能重建仓库才能从历史里清除。

## 贡献

欢迎提交适配器、修复 Bug、改进界面。提交前请跑通 `pnpm test` 与 `cargo test --lib`
（都在本地假服务器上跑，不依赖真实账号）。

## 开源协议

[GPL-3.0](LICENSE)

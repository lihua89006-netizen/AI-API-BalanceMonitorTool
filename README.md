# API余额通（API Balance Manager）

跨平台 API 余额集中监控工具：把各大模型 API 网站的剩余额度集中显示。

- **Windows**：主窗口卡片网格展示各站点余额 + 鲸鱼娘挂件展示窗（透明置顶小窗）
- **Android**：响应式适配（窄屏布局优化）
- 视觉：Apple 风玻璃拟态 + 壁纸背景（深浅色切换）

## 技术栈

Tauri 2（Rust）+ React 19 + TypeScript + Vite 7 + pnpm。

## 开发

```bash
pnpm install          # 安装依赖
pnpm tauri dev        # 开发（vite 1420 + cargo watch）
pnpm exec tsc --noEmit # 类型检查
pnpm test             # vitest 测试
pnpm build            # 前端生产构建（dist）
pnpm tauri build      # Windows release 打包
```

## 文档

完整架构说明、构建打包流程与已知问题见 [`交接文档.md`](./交接文档.md)（含测试状态、适配器层、挂件实现细节与待办清单）。
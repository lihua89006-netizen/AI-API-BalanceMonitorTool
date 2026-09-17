import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import WidgetApp from "./widget/WidgetApp";
import WidgetMenuApp from "./widget/WidgetMenuApp";
import { setupTooltips } from "./lib/tooltip";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 平台标记：让 CSS 能区分 Android 与桌面（响应式适配仅 Android 生效，Windows 保持原布局）
document.documentElement.dataset.platform = /Android/i.test(navigator.userAgent)
  ? "android"
  : "desktop";

// 全局悬浮提示（fixed 定位，脱离滚动容器不被裁剪）
setupTooltips();

// 窗口分流：挂件窗口（label=widget）渲染鲸鱼娘挂件，
// 「今日充值金额」面板窗口（label=widget-menu）渲染独立面板，其余渲染主界面。
// 三个窗口复用同一个 index.html 入口，dev/生产行为一致
// （见 src-tauri/src/widget.rs 与 widget_menu.rs）
const windowLabel = getCurrentWindow().label;
const page =
  windowLabel === "widget" ? (
    <WidgetApp />
  ) : windowLabel === "widget-menu" ? (
    <WidgetMenuApp />
  ) : (
    <App />
  );

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{page}</React.StrictMode>,
);

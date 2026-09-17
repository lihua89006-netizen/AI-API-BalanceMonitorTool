import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";
// 开发期量测中间件（apply: 'serve'，生产构建不参与）——见 probe/ 目录
import { aqmProbe } from "./probe/vite-plugin-aqm";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** 容忍 chokidar 对临时文件的 EBUSY 崩溃：
 *  本项目工具链（DSH 文件编辑）以原子写方式在 src 下产生
 *  `.文件.pid.uuid.tmpdir/文件.tmp` 临时目录；Windows 上 vite 内置的
 *  chokidar 对这类正在写入的文件建 watch 会抛 EBUSY 并直接杀掉 dev server
 *  （历史故障反复出现）。这里在 watcher 的 error 事件上吞掉 EBUSY/EPERM，
 *  使 vite 继续运行——临时文件不影响正确文件的热更。
 *  若个别文件改动未热更，touch 该文件即可触发 chokidar 重新读取。 */
function tolerantWatcher(): PluginOption {
  return {
    name: "tolerant-watcher-ebusy",
    apply: "serve",
    configureServer(server) {
      server.watcher.on("error", (err: NodeJS.ErrnoException & { code?: string }) => {
        if (err && (err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES")) {
          console.log(`[vite] watcher 忽略临时文件错误: ${err.code} ${err.message?.slice(0, 80)}`);
          return;
        }
        console.error("[vite] watcher error:", err);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => {
  console.log("[vite.config] 加载，ignored 为函数 =", typeof ((p: string) => p.includes(".tmpdir")));
  return {
  plugins: [react(), tolerantWatcher(), aqmProbe()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // 4. 忽略编辑器/tools 的原子写入临时目录（.文件.pid.uuid.tmpdir）
      ignored: (path: string) =>
        path.includes("src-tauri") || path.includes(".tmpdir") || /\.tmp$/.test(path),
    },
  },
  };
});
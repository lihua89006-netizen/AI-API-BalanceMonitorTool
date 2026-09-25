package com.apibalance.monitor

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // 沉浸式状态栏：系统栏透明，界面内容延伸到状态栏/导航栏区域，
    // 由前端视口安全区（env(safe-area-inset-*)）自行留白适配
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // ⚠️ 关于「切后台后 JS 定时器还能不能跑」（2026-09/19 实测，结论：**能，不需要额外处理**）：
  //    wry 模板的 `WryActivity.onPause()` 会调 `mWebView.onPause()`，按文档它会暂停 WebView 的
  //    定时器；而主界面的自动刷新全在 JS 定时器里，所以本轮一度在这里加了「super 之后把
  //    WebView resume 回来」的 workaround。**A/B 实测推翻了它的必要性**：把 DeepSeek 站点间隔
  //    设为 1 分钟，前台 100s 内 2 次刷新；**带** workaround 后台 180s 2 次、**去掉**之后后台
  //    也是 180s 2 次（间隔 60~99s）→ 无差别。按本项目「不要保留没测出作用的代码」的规矩删掉了。
  //    ⚠️ 也别被 logcat 的 `ActivityManager: freezing …webview:sandboxed_process0` 误导：
  //    那是 WebView **共享沙箱进程**的冻结动作，我们页面里的定时器照常跑。

  override fun onDestroy() {
    // 鲸鱼娘桌宠（系统悬浮窗）的生命周期口径（2026-09/19 用户拍板）：
    //   「主应用最小化或切到后台等情况，桌宠继续存在，退出后则不需要存在」
    // → 悬浮窗挂在**应用上下文**的 WindowManager 上（不随 Activity 停止消失），
    //    在这里随 Activity 销毁一起收走。
    // ⚠️ 只在**真正退出**时收：`isChangingConfigurations` 为真时属于配置变更重建
    //    （本 Activity 声明了 orientation|screenSize|uiMode 等 configChanges，正常旋转不会重建，
    //     但主题/字体缩放等变更仍可能走到这里），那种情况桌宠应当保留。
    if (!isChangingConfigurations) {
      PetOverlay.dismiss()
    }
    super.onDestroy()
  }
}

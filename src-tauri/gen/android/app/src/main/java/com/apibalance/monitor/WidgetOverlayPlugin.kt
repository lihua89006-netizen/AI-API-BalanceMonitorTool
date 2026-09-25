// 安卓端「鲸鱼娘桌宠」的 Tauri 插件（Rust ↔ Kotlin 桥）。
//
// 职责分工：
//   · 本文件 = **命令面**（open / update / close / state / requestPermission / geometry）
//     + 特殊授权的引导（`SYSTEM_ALERT_WINDOW` 不能弹窗申请，只能跳系统设置页）。
//   · 窗口实现全在 `PetOverlay.kt`（三个 overlay 窗、拖动、缩放、菜单）。
//   · 数据由主应用推送（`overlay_open` / `overlay_update`，见 src-tauri/src/widget_overlay.rs）：
//     安卓端**不**重复实现余额口径，站名/余额/今日已用/峰谷倒计时都按桌面挂件的同一份代码算好再推。
//
// ⚠️ 所有窗口操作都要在主线程（`runOnUiThread`）：Plugin 的 @Command 不在主线程执行
//    （ConfigExportPlugin 里 startActivity 也要 runOnUiThread，同一个原因）。
package com.apibalance.monitor

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin
class WidgetOverlayPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        private const val TAG = "WidgetOverlay"
    }

    init {
        // 原生菜单里的「切换站点 / 刷新数据」把动作交回主界面 JS 执行（口径都在前端，见 PetOverlay.onAction）。
        // 直接在我们自己的 RustWebView 上跑一段 JS —— 登录用的那个 WebView 是普通 WebView，
        // 按类型精确查找不会误伤（两处都在同一个视图树里）。
        PetOverlay.onAction = { action ->
            val js = "window.__aqmPetAction && window.__aqmPetAction('$action')"
            val wv = findRustWebView(activity.window?.decorView)
            if (wv == null) {
                Log.d(TAG, "no RustWebView for action=$action")
            } else {
                activity.runOnUiThread {
                    try {
                        wv.evaluateJavascript(js, null)
                        Log.d(TAG, "action dispatched: $action")
                    } catch (e: Exception) {
                        Log.d(TAG, "dispatch action failed: ${e.message}")
                    }
                }
            }
        }
    }

    /** 找主界面的 WebView（tauri 的 `RustWebView` 类型）；找不到返回 null */
    private fun findRustWebView(v: View?): WebView? {
        if (v is RustWebView) return v
        if (v is ViewGroup) {
            for (i in 0 until v.childCount) {
                findRustWebView(v.getChildAt(i))?.let { return it }
            }
        }
        return null
    }

    /** 显示桌宠（若已显示则原地刷新文字） */
    @Command
    fun open(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(OverlayArgs::class.java)
        } catch (e: Exception) {
            invoke.reject("参数不合法：${e.message}")
            return
        }
        if (!PetOverlay.canDraw(activity)) {
            // 明确报错而不是"点了没反应"：前端据此弹授权引导
            Log.d(TAG, "open rejected: no overlay permission")
            invoke.reject("尚未授予「显示在其他应用上层」权限")
            return
        }
        val text = PetText(
            name = args.name ?: "",
            balance = args.balance ?: "",
            status = args.status ?: "",
            statusKind = args.statusKind ?: "ok",
            peakLabel = args.peakLabel ?: "",
            peakText = args.peakText ?: "",
            peakKind = args.peakKind ?: "",
        )
        val ctx = activity.applicationContext
        activity.runOnUiThread {
            val ok = PetOverlay.show(ctx, args.imagePath, args.sizeDp, args.x, args.y, text)
            if (ok) {
                invoke.resolve(ack(true, "桌宠已显示"))
            } else {
                invoke.reject("桌宠显示失败（背景图或权限问题，见 logcat: PetOverlay）")
            }
        }
    }

    /** 刷新数据（主应用每轮刷新后调用） */
    @Command
    fun update(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(OverlayArgs::class.java)
        } catch (e: Exception) {
            invoke.reject("参数不合法：${e.message}")
            return
        }
        val text = PetText(
            name = args.name ?: "",
            balance = args.balance ?: "",
            status = args.status ?: "",
            statusKind = args.statusKind ?: "ok",
            peakLabel = args.peakLabel ?: "",
            peakText = args.peakText ?: "",
            peakKind = args.peakKind ?: "",
        )
        activity.runOnUiThread {
            if (!PetOverlay.isShowing) {
                invoke.resolve(ack(false, "桌宠未显示"))
                return@runOnUiThread
            }
            PetOverlay.update(text)
            invoke.resolve(ack(true, "已刷新"))
        }
    }

    /** 关闭桌宠（菜单里的「关闭桌宠」走的是 Kotlin 内部路径，不走这条） */
    @Command
    fun close(invoke: Invoke) {
        activity.runOnUiThread {
            PetOverlay.dismiss()
            invoke.resolve(ack(true, "桌宠已关闭"))
        }
    }

    /** 状态查询：是否有授权 + 是否正在显示（前端按钮据此切换"打开/关闭"） */
    @Command
    fun state(invoke: Invoke) {
        invoke.resolve(
            JSObject().apply {
                put("permitted", PetOverlay.canDraw(activity))
                put("showing", PetOverlay.isShowing)
            },
        )
    }

    /** 当前几何（未显示时只有 showing=false）——Rust 用它把位置/大小落盘 */
    @Command
    fun geometry(invoke: Invoke) {
        val g = PetOverlay.geometry()
        invoke.resolve(
            JSObject().apply {
                put("showing", PetOverlay.isShowing)
                if (g != null) {
                    put("x", g.x)
                    put("y", g.y)
                    put("sizeDp", g.sizeDp)
                }
            },
        )
    }

    /**
     * 请求「显示在其他应用上层」授权。
     * ⚠️ 这是**特殊权限**，不能像普通运行时权限那样弹窗申请，只能跳到系统设置页让用户手动打开；
     *    而且该页**永远回 RESULT_CANCELED**（用户按返回 / 打开开关都一样）→
     *    回调里只能**回读** `Settings.canDrawOverlays()` 判断结果。
     */
    @Command
    fun requestPermission(invoke: Invoke) {
        if (PetOverlay.canDraw(activity)) {
            invoke.resolve(permission(true))
            return
        }
        try {
            val intent = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${activity.packageName}"),
            )
            startActivityForResult(invoke, intent, "permissionResult")
        } catch (e: Exception) {
            Log.d(TAG, "open overlay settings failed: ${e.message}")
            invoke.reject("打开系统授权页失败：${e.message}")
        }
    }

    /** 系统授权页返回：只认权限状态本身（见 requestPermission 注释） */
    @ActivityCallback
    private fun permissionResult(invoke: Invoke, result: ActivityResult) {
        val granted = PetOverlay.canDraw(activity)
        Log.d(TAG, "permissionResult: granted=$granted (resultCode=${result.resultCode})")
        invoke.resolve(permission(granted))
    }

    private fun ack(ok: Boolean, message: String): JSObject = JSObject().apply {
        put("ok", ok)
        put("message", message)
    }

    private fun permission(granted: Boolean): JSObject = JSObject().apply {
        put("granted", granted)
        put("message", if (granted) "已授权" else "未授权：需要「显示在其他应用上层」才能把桌宠盖在别的 App 上")
    }
}

/**
 * 桌宠参数（camelCase 与 Rust 侧 serde 命名对齐）。
 * 除 `imagePath` 外的字段都可缺省：P0 骨架阶段前端只推站名/余额/状态，峰谷行等 P1 再补。
 */
@InvokeArg
class OverlayArgs {
    lateinit var imagePath: String
    var name: String? = null
    var balance: String? = null
    var status: String? = null
    var statusKind: String? = null
    var peakLabel: String? = null
    var peakText: String? = null
    var peakKind: String? = null
    var sizeDp: Int = 0
    var x: Int? = null
    var y: Int? = null
}

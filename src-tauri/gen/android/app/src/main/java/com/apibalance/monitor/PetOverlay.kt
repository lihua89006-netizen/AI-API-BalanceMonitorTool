// 安卓端「鲸鱼娘桌宠」悬浮层（方案 1：系统悬浮窗，可盖在所有 App 之上）
//
// ── 用户口径（2026-09/19 拍板，本文件的形状由这四条决定）────────────────────────
//  ① 摆放范围 = **盖在所有 App 之上**（不是动态壁纸那种只在桌面可见的形态）→ 必须走
//     `SYSTEM_ALERT_WINDOW` 特殊授权 + `TYPE_APPLICATION_OVERLAY`。
//  ② 留存 = 主应用**最小化/切后台时继续存在**，**退出主应用后不需要存在**
//     → 悬浮窗挂在**应用上下文**的 WindowManager 上、由 MainActivity.onDestroy 收走；
//       **不起前台服务、不要常驻通知**（起服务是"退出后仍要活着"才需要的代价）。
//  ③ 穿透 = 「整窗穿透 + 只留拖动把手」。安卓没有公开 API 设置窗口输入区域
//     （桌面那套"按 alpha 逐像素穿透"搬不过来）→ 用**两个 overlay 窗口**实现：
//        · 鲸鱼本体窗：`FLAG_NOT_TOUCHABLE`，任何触摸**直接落到下面的 App**（真穿透）；
//        · 把手窗：40dp 小圆，可触摸 —— 拖动它=移动桌宠，单击它=开关菜单。
//        · 菜单窗：同样是小 overlay 窗，只覆盖它自己那块矩形。
//     于是「在鲸鱼身上点一下」= 操作底下的 App（与用户选的口径一致）。
//  ④ 站点 = **可切换多站点**（菜单里切换；数据由主应用推送，见 widget_overlay.rs）。
//
// ── 与桌面的能力差异（不要照着桌面改）──────────────────────────────────────────
//  · 桌面挂件是**独立 WebView 窗口**（复用 index.html）；安卓端 dist 编在 Rust 二进制里，
//    第二个 WebView 拿不到那份前端 → 这里用**原生 View** 画（图片 + 文字），
//    位置与字号全部按桌面 `widget.css` 的 308 画布比例换算（见 PetCanvasView）。
//  · 位置/大小记忆：见 `geometry()` —— 数值由 Rust 落盘到 config.json（P2）。
package com.apibalance.monitor

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.roundToInt

/** 画布基准：与桌面挂件 `widget.css` 的 308×308 画布同口径，位置/字号都按它取比例 */
private const val CANVAS_BASE = 308f

/** 桌宠要显示的文字（由主应用算好推过来 —— 口径与桌面挂件完全一致，安卓端不再算一遍） */
data class PetText(
    val name: String = "",
    val balance: String = "",
    val status: String = "",
    /** ok | err | busy | used —— 决定状态行颜色（对齐 widget.css 的 .widget-status.*） */
    val statusKind: String = "ok",
    val peakLabel: String = "",
    val peakText: String = "",
    /** peak | valley | "" —— 徽标配色（对齐 .widget-peak-peak / .widget-peak-valley） */
    val peakKind: String = "",
) {
    val hasPeak: Boolean get() = peakLabel.isNotEmpty()
}

/** 桌宠几何（左上角 + 边长，单位：dp；落盘用 dp 以免换设备后尺寸错位） */
data class PetGeometry(val x: Int, val y: Int, val sizeDp: Int)

/**
 * 桌宠悬浮层单例：持有三个 overlay 窗口（鲸鱼 / 把手 / 菜单），负责开、关、刷新数据与拖拽缩放。
 *
 * ⚠️ 必须用**应用上下文**（`context.applicationContext`）：Activity 上下文建的窗口在
 *    Activity 销毁时会被系统连带移除（且会报 WindowLeaked）。
 * ⚠️ 所有 `WindowManager.addView/updateViewLayout/removeView` 都要在**主线程**调用
 *    （调用方用 `runOnUiThread`，见 WidgetOverlayPlugin）。
 */
object PetOverlay {
    private const val TAG = "PetOverlay"

    private const val DEFAULT_SIZE_DP = 150
    private const val MIN_SIZE_DP = 90
    private const val MAX_SIZE_DP = 280
    private const val STEP_SIZE_DP = 20
    private const val HANDLE_DP = 40
    /** 后台戳醒 JS 的间隔（见 startPoke / pokeRunnable 的说明） */
    private const val POKE_INTERVAL_MS = 60_000L

    private var wm: WindowManager? = null
    private var screenW = 0
    private var screenH = 0
    private var density = 1f

    private var whale: View? = null
    private var whaleLp: WindowManager.LayoutParams? = null
    private var whaleCanvas: PetCanvasView? = null

    private var handle: View? = null
    private var handleLp: WindowManager.LayoutParams? = null

    private var menu: View? = null
    private var menuLp: WindowManager.LayoutParams? = null

    /** 桌宠边长（px）——几何的单一真源，鲸鱼窗与把手都从它派生 */
    private var sizePx = 0
    /** 当前文字（切换穿透模式要重建窗口，重建后要把文字铺回去） */
    private var lastText = PetText()
    private var bgBitmap: Bitmap? = null

    /**
     * 触摸穿透开关（用户口径 ③：整窗穿透 + 只留拖动把手）。
     *
     * ⚠️ **平台约束（2026-09/19 实测，本项目的关键发现）**：带 `FLAG_NOT_TOUCHABLE` 的
     *    悬浮窗，系统会把它的 alpha **上限压到 0.8** —— 客户端 `LayoutParams.alpha` 明明是 1.0
     *    （已用日志确认），`dumpsys window windows` 里服务端的 `mAttrs` 却是 `alpha=0.8`；
     *    显式设 0.5 则原样通过（说明是"上限"而非"固定值"）。逐项排除过：换成
     *    `PixelFormat.RGBA_8888` 无效；把手窗（同参数但**没**这个 flag）alpha 保持 1.0。
     *    后果：真穿透时整只鲸鱼被系统打八折 —— 背景图里本来完全不透明的气泡（alpha 实测 255）
     *    对着深色壁纸只渲染出 207，底下 App 的图标/文字会透上来。
     *    **两个特性不能兼得**，故做成菜单开关，默认沿用用户口径（穿透 = 开）。
     */
    private var passThrough = true

    val isShowing: Boolean get() = whale != null
    val isPassThrough: Boolean get() = passThrough

    /**
     * 菜单动作回调（由 `WidgetOverlayPlugin` 注入）。
     *
     * 「切换站点」「刷新数据」这两件事的数据都在主界面前端（余额口径、当日账本、站点列表全在 JS 里），
     * 所以原生菜单只能把动作**交给主界面的 JS 去做** —— 注入方拿得到 Activity，在我们**自己的
     * `RustWebView`** 上跑一段 `window.__aqmPetAction('…')` 即可（不走 Rust 转发、不需要插件事件权限，
     * 也不轮询）。桌宠窗口自己不认识站点列表，这一点刻意保持。
     */
    var onAction: ((String) -> Unit)? = null

    // ══════════════════════════════════════════════════════════════════
    // 后台「戳一下」：桌宠开着时，用**原生定时器**定期把主界面 JS 叫醒
    //
    // 为什么需要（2026-09/19 实测）：
    //   · 主界面的自动刷新全在 JS 定时器里；主应用切后台后 Chromium 会把后台页面的**定时器**停掉
    //     —— 实测：切后台 2 分钟时还在刷（每 60~99s 一次），到 **4~5 分钟后彻底停**，
    //     而悬浮窗一直可见、进程也没被冻结（`dumpsys activity processes`：`isFrozen=false`，
    //     还是 `has-overlay-ui` 的 perceptible 进程）→ 停的是渲染层，不是进程。
    //   · 但 **`evaluateJavascript` 驱动的脚本照样执行**：后台 11 分钟时点原生菜单「切换站点」，
    //     立刻看到了切换与一次真实网络刷新（日志 `action dispatched: nextSite` → `[ui] result`）。
    //   → 所以保活不需要前台服务：**我们自己的进程还活着且能跑定时器**，由它定期把 JS 戳醒，
    //     让 JS 去跑它自己那套"哪些站点该刷了"的判断（口径仍只有一份，在 JS 里）。
    // ⚠️ 只在桌宠显示期间跑（关闭即停）；间隔取 60 秒 —— 与前台那套 30s tick 的量级一致，
    //    真正的刷新与否仍由每个站点自己的 autoRefreshMinutes 决定（这里只是给 JS 一个机会）。
    // ══════════════════════════════════════════════════════════════════
    private val pokeHandler = Handler(Looper.getMainLooper())
    private val pokeRunnable = object : Runnable {
        override fun run() {
            if (whale == null) return
            onAction?.invoke("tick")
            pokeHandler.postDelayed(this, POKE_INTERVAL_MS)
        }
    }

    private fun startPoke() {
        pokeHandler.removeCallbacks(pokeRunnable)
        pokeHandler.postDelayed(pokeRunnable, POKE_INTERVAL_MS)
    }

    private fun stopPoke() {
        pokeHandler.removeCallbacks(pokeRunnable)
    }

    /** 特殊权限检查（`SYSTEM_ALERT_WINDOW` 只能查状态 + 跳系统设置页，不能弹窗申请） */
    fun canDraw(context: Context): Boolean = Settings.canDrawOverlays(context)

    /** 当前几何（未显示时返回 null）——Rust 据此落盘 */
    fun geometry(): PetGeometry? {
        val lp = whaleLp ?: return null
        return PetGeometry(lp.x, lp.y, (sizePx / density).roundToInt())
    }

    // ══════════════════════════════════════════════════════════════════
    // 显示 / 关闭
    // ══════════════════════════════════════════════════════════════════

    /**
     * 显示桌宠。返回 false = 环境不支持（无授权 / 图片读不出来）。
     * @param imagePath 鲸鱼背景 PNG 的绝对路径（Rust 把编译进二进制的那份 dist 资源写到应用目录后传入，
     *                  单一来源、仓库里不存第二份副本）
     */
    fun show(context: Context, imagePath: String, sizeDp: Int, x: Int?, y: Int?, text: PetText): Boolean {
        val ctx = context.applicationContext
        if (!canDraw(ctx)) {
            Log.d(TAG, "show rejected: no SYSTEM_ALERT_WINDOW")
            return false
        }
        val bmp: Bitmap? = try {
            BitmapFactory.decodeFile(imagePath)
        } catch (e: Exception) {
            Log.d(TAG, "decode bg failed: ${e.message}")
            null
        }
        if (bmp == null) {
            Log.d(TAG, "decode bg returned null: $imagePath")
            return false
        }
        val w = ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dm = ctx.resources.displayMetrics
        wm = w
        density = dm.density
        screenW = dm.widthPixels
        screenH = dm.heightPixels

        dismiss() // 幂等：重复打开先清掉旧的，避免叠窗

        sizePx = dp(clampSizeDp(if (sizeDp > 0) sizeDp else DEFAULT_SIZE_DP))
        // 默认落点：右侧偏下（不挡顶部状态栏，也不压底部手势条）
        val px = x ?: (screenW - sizePx - dp(8))
        val py = y ?: (screenH * 0.55f).roundToInt()

        val canvas = newCanvas(ctx, bmp, text)
        bgBitmap = bmp
        lastText = text
        whaleCanvas = canvas
        whale = canvas
        whaleLp = whaleParams(sizePx, px, py)
        w.addView(whale, whaleLp)

        val grip = GripHandleView(ctx)
        handle = grip
        handleLp = baseParams(dp(HANDLE_DP), dp(HANDLE_DP))
        grip.setOnTouchListener(dragListener())
        w.addView(grip, handleLp)

        moveTo(px, py)
        startPoke() // 后台也保持数据新鲜（见 pokeRunnable 的说明）
        Log.d(TAG, "shown: size=${sizePx}px at ($px,$py) passThrough=$passThrough screen=${screenW}x$screenH")
        return true
    }

    /** 鲸鱼窗参数：穿透模式加 `FLAG_NOT_TOUCHABLE`（用户口径 ③），清晰模式不加（见 passThrough 注释） */
    private fun whaleParams(size: Int, x: Int, y: Int): WindowManager.LayoutParams =
        baseParams(size, size).apply {
            if (passThrough) flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            this.x = x
            this.y = y
        }

    /** 造一块画布。点它 = 刷新数据（对齐桌面挂件「点一下刷新」的语义）。
     *
     * ⚠️ 只在**清晰模式**下有效：穿透模式的鲸鱼窗带 `FLAG_NOT_TOUCHABLE`，它收不到任何触摸
     *    （点击直接落到下面的 App —— 那是用户要的口径）。所以清晰模式下"点鲸鱼没反应"
     *    会被这个点击监听补上，而穿透模式下窗口本来就不接触摸，监听器自然不触发。 */
    private fun newCanvas(ctx: Context, bmp: Bitmap, text: PetText): PetCanvasView =
        PetCanvasView(ctx).apply {
            setBitmap(bmp)
            setText(text)
            isClickable = true
            setOnClickListener { onAction?.invoke("refresh") }
        }

    /**
     * 切换「点击穿透」（重建鲸鱼窗 —— 窗口 flag 只能在创建时定）。
     * 重建后几何与文字都按切换前的状态还原，用户看不出跳变。
     */
    private fun togglePassThrough() {
        val w = wm ?: return
        val lp = whaleLp ?: return
        val bmp = bgBitmap ?: return
        val ctx = whale?.context ?: return
        val text = lastText
        val x = lp.x
        val y = lp.y
        passThrough = !passThrough
        // 摘掉旧的鲸鱼窗（把手与菜单不动）
        try {
            w.removeViewImmediate(whale)
        } catch (e: Exception) {
            Log.d(TAG, "remove whale for mode switch failed: ${e.message}")
        }
        val canvas = newCanvas(ctx, bmp, text)
        whaleCanvas = canvas
        whale = canvas
        whaleLp = whaleParams(sizePx, x, y)
        try {
            w.addView(canvas, whaleLp)
        } catch (e: Exception) {
            Log.d(TAG, "re-add whale failed: ${e.message}")
            return
        }
        // ⚠️ 必须把把手**重新加一遍**：overlay 窗口的层级 = 添加顺序，鲸鱼窗刚被加到最上面；
        //    清晰模式下鲸鱼窗是可触摸的，会吃掉本该落到把手上的事件（实测：切到清晰模式后
        //    把手完全点不动、也拖不动）。重加一次把手把它顶回最上层。
        bringHandleToFront()
        moveTo(x, y)
        Log.d(TAG, "passThrough=$passThrough (window rebuilt)")
    }

    /** 把把手（以及打开着的菜单）重新加一遍，置回最上层 */
    private fun bringHandleToFront() {
        val w = wm ?: return
        val grip = handle ?: return
        val hlp = handleLp ?: return
        try {
            w.removeViewImmediate(grip)
            w.addView(grip, hlp)
        } catch (e: Exception) {
            Log.d(TAG, "re-add handle failed: ${e.message}")
        }
        val m = menu
        val mlp = menuLp
        if (m != null && mlp != null) {
            try {
                w.removeViewImmediate(m)
                w.addView(m, mlp)
                positionMenu()
            } catch (e: Exception) {
                Log.d(TAG, "re-add menu failed: ${e.message}")
            }
        }
    }

    /** 关闭桌宠（三个窗口一起收；幂等） */
    fun dismiss() {
        stopPoke() // 先停定时器（wm 为空时也要停，别让它在没有桌宠时继续戳 JS）
        val w = wm ?: return
        hideMenu()
        for (v in listOf(whale, handle)) {
            if (v != null) {
                try {
                    w.removeViewImmediate(v)
                } catch (e: Exception) {
                    Log.d(TAG, "remove failed: ${e.message}")
                }
            }
        }
        whale = null
        whaleLp = null
        whaleCanvas = null
        handle = null
        handleLp = null
        // 释放背景图（约 4MB 内存）；下次打开会重新解码
        bgBitmap = null
        Log.d(TAG, "dismissed")
    }

    /** 刷新文字（数据推送；窗口未显示时静默忽略） */
    fun update(text: PetText) {
        lastText = text
        whaleCanvas?.setText(text)
    }

    // ══════════════════════════════════════════════════════════════════
    // 几何：位置 / 缩放
    // ══════════════════════════════════════════════════════════════════

    /** 把桌宠左上角移到 (x, y)：鲸鱼窗与把手窗一起动，并夹在屏幕内 */
    private fun moveTo(x: Int, y: Int) {
        val w = wm ?: return
        val lp = whaleLp ?: return
        val cx = x.coerceIn(0, (screenW - sizePx).coerceAtLeast(0))
        val cy = y.coerceIn(0, (screenH - sizePx).coerceAtLeast(0))
        lp.x = cx
        lp.y = cy
        try {
            w.updateViewLayout(whale, lp)
        } catch (e: Exception) {
            Log.d(TAG, "move whale failed: ${e.message}")
        }
        // 把手落在鲸鱼**右上角内侧**的空处：背景图 alpha 实测该角落完全透明（A=0），
        // 既不会压住角色的脸/头发（右下角是身体，A=255），也与桌面把返回/菜单键放右上角一致。
        // ⚠️ 这里先用**请求值**摆一次（拖动时能立刻跟手），再由 post 里的
        //    `positionHandleOnWhale()` 按**真实落点**校正（见那里的注释）。
        val hlp = handleLp
        if (hlp != null) {
            val inset = dp(4)
            hlp.x = cx + sizePx - hlp.width - inset
            hlp.y = cy + inset
            try {
                w.updateViewLayout(handle, hlp)
            } catch (e: Exception) {
                Log.d(TAG, "move handle failed: ${e.message}")
            }
        }
        whale?.post { positionHandleOnWhale() }
        if (menu != null) positionMenu()
    }

    /**
     * 按鲸鱼窗的**真实屏幕位置**摆把手。
     *
     * 为什么不能只用请求值：系统会为了不压住状态栏/导航栏把窗口整体往里挪一点
     * （实测：请求 y=2006、`dumpsys input` 的 frame 却是 1943，差 63px = 导航栏高度），
     * 于是"按请求值算出来的把手位置"与鲸鱼本体错位（把手落在气泡上、不在角上）。
     * `View.getLocationOnScreen` 给的是**落地后**的真实坐标，用它算就永远对齐。
     */
    private fun positionHandleOnWhale() {
        val w = wm ?: return
        val hlp = handleLp ?: return
        val v = whale ?: return
        val grip = handle ?: return
        val loc = IntArray(2)
        v.getLocationOnScreen(loc)
        if (loc[0] == 0 && loc[1] == 0) return // 还没上屏（首帧前）→ 保持请求值
        val inset = dp(4)
        hlp.x = loc[0] + v.width - hlp.width - inset
        hlp.y = loc[1] + inset
        try {
            w.updateViewLayout(grip, hlp)
        } catch (e: Exception) {
            Log.d(TAG, "correct handle position failed: ${e.message}")
        }
    }

    /**
     * 缩放一档：**以中心为锚点**。
     * （桌面是滚轮缩放 + Rust 侧锚点数学；安卓端没有滚轮，菜单档位缩放保持中心不动即可，
     *   不需要"鼠标指向的内容点不动"那套数学。）
     */
    private fun scaleBy(deltaDp: Int) {
        val lp = whaleLp ?: return
        val w = wm ?: return
        val old = sizePx
        val next = dp(clampSizeDp((old / density).roundToInt() + deltaDp))
        if (next == old) return
        val cx = lp.x + old / 2
        val cy = lp.y + old / 2
        sizePx = next
        lp.width = next
        lp.height = next
        try {
            w.updateViewLayout(whale, lp)
        } catch (e: Exception) {
            Log.d(TAG, "resize failed: ${e.message}")
        }
        whaleCanvas?.requestLayout()
        moveTo(cx - next / 2, cy - next / 2)
    }

    private fun clampSizeDp(v: Int): Int = v.coerceIn(MIN_SIZE_DP, MAX_SIZE_DP)

    private fun dp(v: Int): Int = (v * density).roundToInt()

    /**
     * overlay 窗口通用参数。
     * ⚠️ `TYPE_APPLICATION_OVERLAY` 需要 API 26+；24/25 只能用已废弃的 `TYPE_PHONE`
     *    （同样需要 SYSTEM_ALERT_WINDOW 授权，是 minSdk 24 的兜底路径）。
     * ⚠️ `FLAG_NOT_FOCUSABLE`：不抢输入焦点（否则会把下面的 App 顶成失焦状态：
     *    弹不出软键盘、视频/游戏会暂停）。触摸是否穿透由调用方再加 `FLAG_NOT_TOUCHABLE`。
     */
    private fun baseParams(w: Int, h: Int): WindowManager.LayoutParams {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        else
            @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        return WindowManager.LayoutParams(
            w,
            h,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.RGBA_8888,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            // ⚠️ `FLAG_LAYOUT_IN_SCREEN`：**x/y 必须是绝对屏幕坐标**。
            //    不加这个 flag 时，窗口坐标被解释在"去掉状态栏之后的内容区"里 ——
            //    实测设 y=1320、`dumpsys input` 里的 frame 却是 y=**1394**（差 74px = 状态栏高度），
            //    于是"按窗口坐标算出来的把手位置"与真实可点区域差了 22px 以上，点不中。
            //    项目的其它窗口（桌面挂件）由 Win32 API 直接给屏幕坐标，没有这层偏移。
            flags = flags or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
            // ⚠️ **必须显式指定 alpha = 1.0**：见 `passThrough` 注释 —— 逐像素透明由
            //    背景图自身的 alpha 通道负责，窗口这一层要尽量不透明。
            alpha = 1.0f
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 把手：拖动 / 单击开菜单
    // ══════════════════════════════════════════════════════════════════

    private fun dragListener(): View.OnTouchListener {
        val slop = ViewConfiguration.getTouchSlop()
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0
        var startY = 0
        var moved = false
        // 长按是否已经开过菜单：开过之后这一次手势就不再拖动、抬起也不再切换
        var longFired = false
        // 手势按下时菜单是否已经开着：抬起时据此**切换**（开着就关、关着就开）。
        // ⚠️ 不能在 ACTION_DOWN 里无条件 hideMenu()：「点一下把手想关掉菜单」会变成
        //    "先收起、抬起又打开" → 净效果是关不掉（本轮实测手感问题）。
        var menuWasOpen = false
        val longPress = Runnable {
            if (!moved && !longFired) {
                longFired = true
                Log.d(TAG, "handle long-press: toggle menu")
                toggleMenu()
            }
        }
        return View.OnTouchListener { view, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = ev.rawX
                    downRawY = ev.rawY
                    startX = whaleLp?.x ?: 0
                    startY = whaleLp?.y ?: 0
                    moved = false
                    longFired = false
                    menuWasOpen = menu != null
                    // 长按把手 = 开菜单（方案/目标里的口径）；单击也开（更顺手），两种都支持
                    view.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (longFired) return@OnTouchListener true // 已开菜单 → 本次手势不再拖动
                    val dx = ev.rawX - downRawX
                    val dy = ev.rawY - downRawY
                    if (!moved && (abs(dx) > slop || abs(dy) > slop)) {
                        moved = true
                        view.removeCallbacks(longPress) // 判定为拖动 → 取消长按
                        hideMenu() // 开始拖动才收起菜单（菜单是临时的）
                    }
                    if (moved) moveTo(startX + dx.roundToInt(), startY + dy.roundToInt())
                    true
                }
                MotionEvent.ACTION_UP -> {
                    view.removeCallbacks(longPress)
                    Log.d(TAG, "handle up: moved=$moved longFired=$longFired menuWasOpen=$menuWasOpen")
                    // 未位移时：菜单原本开着 → 关掉；原本关着 → 打开（单击与长按走同一条语义）
                    if (!moved && !longFired) {
                        if (menuWasOpen) hideMenu() else toggleMenu()
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    view.removeCallbacks(longPress)
                    true
                }
                else -> false
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // 菜单（第三个 overlay 窗）
    // 为什么不用 PopupWindow：它需要一个可用的窗口 token，而 overlay 窗口不是 Activity 窗口，
    // 拿 overlay 的 view 当锚点会 BadTokenException → 直接用同款 overlay 窗最稳。
    // ══════════════════════════════════════════════════════════════════

    private fun toggleMenu() {
        if (menu != null) {
            hideMenu()
            return
        }
        val ctx: Context = whale?.context ?: return
        val panel = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadius = 12f * density
                setColor(0xF2FFFFFF.toInt())
                setStroke(dp(1), 0x331F3A5F)
            }
            val pad = dp(6)
            setPadding(pad, pad, pad, pad)
        }
        val items = listOf<Pair<String, () -> Unit>>(
            // 站点切换与数据刷新都交回主界面 JS（见 onAction 注释）
            "切换站点" to { onAction?.invoke("nextSite") },
            "刷新数据" to { onAction?.invoke("refresh") },
            "放大" to { scaleBy(STEP_SIZE_DP) },
            "缩小" to { scaleBy(-STEP_SIZE_DP) },
            // 见 passThrough 注释：真穿透的代价是系统把整窗 alpha 压到 0.8（发灰、底下会透出来），
            // 这里给一个开关让用户自己取舍，默认沿用用户口径（穿透 = 开）
            (if (passThrough) "点击穿透：开" else "点击穿透：关") to { togglePassThrough() },
            "关闭桌宠" to { dismiss() },
        )
        for ((label, action) in items) panel.addView(menuButton(ctx, label, action))
        menu = panel
        menuLp = baseParams(dp(132), WindowManager.LayoutParams.WRAP_CONTENT)
        try {
            wm?.addView(panel, menuLp)
        } catch (e: Exception) {
            Log.d(TAG, "add menu failed: ${e.message}")
            menu = null
            menuLp = null
            return
        }
        positionMenu()
        // WRAP_CONTENT 的高度要等第一次 layout 之后才准 → layout 完再定位一次
        panel.post { positionMenu() }
    }

    private fun menuButton(ctx: Context, label: String, action: () -> Unit): TextView =
        TextView(ctx).apply {
            text = label
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(0xFF1F3A5F.toInt())
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            gravity = Gravity.CENTER
            val vp = dp(9)
            val hp = dp(10)
            setPadding(hp, vp, hp, vp)
            isClickable = true
            setOnClickListener {
                hideMenu()
                action()
            }
        }

    /** 菜单贴在把手**上方**（右缘与把手右缘对齐），并夹在屏幕内 */
    private fun positionMenu() {
        val w = wm ?: return
        val mlp = menuLp ?: return
        val m = menu ?: return
        val hlp = handleLp ?: return
        val mh = if (m.height > 0) m.height else dp(150)
        mlp.x = (hlp.x + hlp.width - mlp.width).coerceIn(0, (screenW - mlp.width).coerceAtLeast(0))
        // 默认贴在把手上方；上方不够（把手已在屏幕顶部附近）则改贴下方，避免被夹到屏幕外压住鲸鱼
        val gap = dp(6)
        val above = hlp.y - mh - gap
        mlp.y = if (above >= 0) {
            above
        } else {
            (hlp.y + hlp.height + gap).coerceIn(0, (screenH - mh).coerceAtLeast(0))
        }
        try {
            w.updateViewLayout(m, mlp)
        } catch (e: Exception) {
            Log.d(TAG, "position menu failed: ${e.message}")
        }
    }

    private fun hideMenu() {
        val m = menu ?: return
        try {
            wm?.removeViewImmediate(m)
        } catch (e: Exception) {
            Log.d(TAG, "hide menu failed: ${e.message}")
        }
        menu = null
        menuLp = null
    }
}

/**
 * 鲸鱼画布：原生复刻桌面挂件在 308×308 画布上的排版（位置与字号按比例换算）。
 *
 * 比例来源 = `src/widget/widget.css`（每一项都标了出处，改那边记得同步这里）：
 *   峰谷行 9.6% ／ 站名 19.5%（无峰谷行时 16.2%）／ 金额 31%（27.7%）／ 状态 40.5%（37.2%）
 *   水平：left 2%、宽 84%、行内居中 ／ 字号（画布 px）：站名 21.6、后缀 15.1、金额 36、状态 13、徽标 13
 */
private class PetCanvasView(context: Context) : FrameLayout(context) {
    private val bg = ImageView(context)
    private val nameRow = LinearLayout(context)
    private val nameView = TextView(context)
    private val suffixView = TextView(context)
    private val balanceView = TextView(context)
    private val statusView = TextView(context)
    private val peakRow = LinearLayout(context)
    private val peakChip = TextView(context)
    private val peakText = TextView(context)

    private var text = PetText()

    private val ink = 0xFF1F3A5F.toInt()
    private val inkSoft = 0xFF3D5A80.toInt()
    private val errRed = 0xFFB3261E.toInt()
    private val peakRed = 0xFFDC2626.toInt()
    private val valleyGreen = 0xFF16A34A.toInt()

    init {
        bg.scaleType = ImageView.ScaleType.FIT_XY
        addView(bg, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        // 站名行：站名 + 小一号的「余额」后缀（对齐 .widget-name / .widget-name .suffix）
        nameRow.orientation = LinearLayout.HORIZONTAL
        nameRow.gravity = Gravity.CENTER
        nameView.includeFontPadding = false
        suffixView.includeFontPadding = false
        suffixView.text = "余额"
        // ⚠️ 子 View 的 LayoutParams 类型由**父容器**决定：nameRow 是 LinearLayout，
        //    这里必须给 LinearLayout.LayoutParams —— 用外层 FrameLayout 的那套会在 onLayout
        //    取 layoutParams 时 ClassCastException 直接崩掉整个应用（本轮实测踩到）。
        nameRow.addView(nameView, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        nameRow.addView(suffixView, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))

        for (v in listOf<TextView>(balanceView, statusView)) {
            v.gravity = Gravity.CENTER
            v.includeFontPadding = false
        }

        // 峰谷行：徽标 + 倒计时同一行（对齐 .widget-peak.row 的 flex + gap 4px）
        peakRow.orientation = LinearLayout.HORIZONTAL
        peakRow.gravity = Gravity.CENTER
        peakChip.gravity = Gravity.CENTER
        peakChip.includeFontPadding = false
        peakText.includeFontPadding = false
        peakRow.addView(peakChip)
        peakRow.addView(peakText)

        for (v in listOf<View>(nameRow, balanceView, statusView, peakRow)) {
            addView(v, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT))
        }
    }

    fun setBitmap(bmp: Bitmap) {
        bg.setImageBitmap(bmp)
    }

    fun setText(t: PetText) {
        text = t
        nameView.text = t.name
        balanceView.text = t.balance
        statusView.text = t.status
        statusView.setTextColor(
            when (t.statusKind) {
                "err" -> errRed
                "busy" -> inkSoft
                else -> ink
            },
        )
        peakChip.text = t.peakLabel
        peakText.text = t.peakText
        val vis = if (t.hasPeak) VISIBLE else GONE
        peakRow.visibility = vis
        requestLayout()
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val s = width.toFloat()
        if (s <= 0f) return
        val k = s / CANVAS_BASE // 画布缩放比：所有数值都按它换算

        // 背景图始终铺满（对齐 .widget-bg 的 object-fit: cover；图为正方形，故与铺满等价）
        bg.layout(0, 0, width, height)

        // 各行的纵向中心（比例取自 widget.css）
        val hasPeak = text.hasPeak
        val peakY = 0.096f * s
        val nameY = (if (hasPeak) 0.195f else 0.162f) * s
        val balanceY = (if (hasPeak) 0.310f else 0.277f) * s
        val statusY = (if (hasPeak) 0.405f else 0.372f) * s

        // 字号：画布 px × k（白色 shadowLayer 近似桌面那圈 8 向白描边）
        applyFont(nameView, 21.6f * k, true, ink)
        applyFont(suffixView, 15.1f * k, true, inkSoft)
        applyFont(balanceView, 36f * k, true, ink)
        applyFont(statusView, 13f * k, false, ink)
        applyFont(peakText, 13f * k, true, ink)
        applyFont(peakChip, 13f * k, true, peakRed)
        stylePeakChip(k)
        // 站名与后缀的紧凑微距（CSS `.widget-name .suffix { margin-left: 0.15em }`；
        // em 相对**自身**字号 15.1px，故 0.15 × 15.1 = 2.3px）
        val suffixLp = suffixView.layoutParams as LinearLayout.LayoutParams
        suffixLp.marginStart = (0.15f * 15.1f * k).roundToInt()
        suffixView.layoutParams = suffixLp

        // 文字行：left 2% / 宽 84%，行内居中；纵向按中心对齐（.widget-text 的 translateY(-50%)）
        val left = (0.02f * s).roundToInt()
        val boxW = (0.84f * s).roundToInt()
        layoutCentered(nameRow, left, boxW, nameY)
        layoutCentered(balanceView, left, boxW, balanceY)
        layoutCentered(statusView, left, boxW, statusY)
        layoutCentered(peakRow, left, boxW, peakY)
    }

    private fun stylePeakChip(k: Float) {
        val valley = text.peakKind == "valley"
        peakChip.background = GradientDrawable().apply {
            cornerRadius = 6f * k
            setColor(if (valley) 0x2922C55E else 0x26EF4444)
            setStroke(
                (1f * k).roundToInt().coerceAtLeast(1),
                if (valley) 0x6622C55E.toInt() else 0x66EF4444.toInt(),
            )
        }
        peakChip.setTextColor(if (valley) valleyGreen else peakRed)
        val hp = (5f * k).roundToInt()
        peakChip.setPadding(hp, 0, hp, 0)
        // 徽标行高 19 画布 px、最小宽 19（.widget-peak-chip height:19px / min-width:19px）
        peakChip.minWidth = (19f * k).roundToInt()
        peakChip.minimumHeight = (19f * k).roundToInt()
    }

    private fun applyFont(tv: TextView, px: Float, bold: Boolean, color: Int) {
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, px)
        tv.typeface = Typeface.create(Typeface.DEFAULT, if (bold) Typeface.BOLD else Typeface.NORMAL)
        tv.setTextColor(color)
        tv.setShadowLayer(px * 0.06f, 0f, 0f, Color.WHITE)
    }

    /** 在 [left, left+boxW] 内水平居中、纵向以 centerY 为中心摆放 */
    private fun layoutCentered(v: View, left: Int, boxW: Int, centerY: Float) {
        val wSpec = MeasureSpec.makeMeasureSpec(boxW, MeasureSpec.AT_MOST)
        val hSpec = MeasureSpec.makeMeasureSpec(height, MeasureSpec.AT_MOST)
        v.measure(wSpec, hSpec)
        val vh = v.measuredHeight
        val vw = v.measuredWidth
        val x = left + (boxW - vw) / 2
        val y = (centerY - vh / 2f).roundToInt()
        v.layout(x, y, x + vw, y + vh)
    }
}

/** 拖动把手：半透明圆 + 六个点（自绘，不依赖字体里有没有 ⠿ 之类的字形） */
private class GripHandleView(context: Context) : View(context) {
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xB3FFFFFF.toInt()
        style = Paint.Style.FILL
    }
    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x661F3A5F.toInt()
        style = Paint.Style.STROKE
        strokeWidth = 1f * resources.displayMetrics.density
    }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x991F3A5F.toInt() }

    init {
        isClickable = true
    }

    override fun onDraw(canvas: Canvas) {
        val r = minOf(width, height) / 2f
        canvas.drawCircle(width / 2f, height / 2f, r - ringPaint.strokeWidth, bgPaint)
        canvas.drawCircle(width / 2f, height / 2f, r - ringPaint.strokeWidth, ringPaint)
        // 2 列 × 3 行小点（抓手观感）
        val d = r * 0.13f
        val gapX = r * 0.34f
        val gapY = r * 0.30f
        for (col in -1..0) {
            for (row in -1..1) {
                canvas.drawCircle(width / 2f + col * gapX, height / 2f + row * gapY, d, dotPaint)
            }
        }
    }
}

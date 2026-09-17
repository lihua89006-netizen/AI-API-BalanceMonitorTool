// 安卓端「模拟浏览器登录」：应用内嵌 WebView 手动登录 + Cookie 持久化 + 抓余额接口
// 方案 A（2026-08 v2）：
//   1. 打开全屏 WebView 加载登录页，用户手动登录（验证码/滑块真人可过）
//   2. 登录态由系统 CookieManager 持久化（应用级，重启不丢）
//   3. 检测到 URL 离开登录页（登录成功）→ 自动跳转余额页 → shouldInterceptRequest 抓余额接口
//   4. 抓到余额后自动完成（无感），返回 { success, message, balance, cookie } 给 Rust
// 单实例：已有登录页打开时拒绝重复打开（防自动刷新叠开多个 WebView）
package com.apibalance.monitor

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

@TauriPlugin
class WebLoginPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        @Volatile
        var activeView: LoginWebView? = null
    }

    @Command
    fun openLogin(invoke: Invoke) {
        val args = invoke.parseArgs(OpenLoginArgs::class.java)
        activity.runOnUiThread {
            val existing = activeView
            if (existing != null) {
                invoke.reject("已有登录页面在打开中，请先完成或取消")
                return@runOnUiThread
            }
            val view = LoginWebView(activity, args, object : LoginWebView.Callback {
                override fun onDone(result: JSObject) {
                    activeView = null
                    invoke.resolve(result)
                }

                override fun onCancel(message: String) {
                    activeView = null
                    invoke.reject(message)
                }
            })
            activeView = view
            view.show()
        }
    }
}

@InvokeArg
class OpenLoginArgs {
    lateinit var loginUrl: String
    lateinit var balanceUrl: String
    var keyword: String = ""
}

/**
 * 全屏登录视图：垂直 LinearLayout（顶部操作栏 + WebView weight=1）。
 * 流程：登录页 →（URL 离开登录页 = 登录成功）自动跳余额页 → 拦截含 keyword 的接口（HttpURLConnection 带 Cookie
 * 重发读响应体解析余额）→ 自动完成。
 */
class LoginWebView(
    context: Context,
    private val args: OpenLoginArgs,
    private val callback: Callback,
) : LinearLayout(context) {

    interface Callback {
        fun onDone(result: JSObject)
        fun onCancel(message: String)
    }

    private val webView = WebView(context)
    private var captured: JSObject? = null
    private var finished = false
    private var autoJumped = false
    private var doneScheduled = false
    private var attached = false

    /** 余额字段别名（与桌面 query_balance.js 一致） */
    private val FIELD_ALIASES = mapOf(
        "available" to arrayOf("available_amount", "available_balance", "available", "remain_balance", "remaining_balance", "balance"),
        "cash" to arrayOf("cash_balance", "cash_amount", "cash"),
        "voucher" to arrayOf("voucher_balance", "voucher", "gift_balance", "gift", "bonus"),
        "credit" to arrayOf("credit_balance", "credit_limit", "credit"),
        "owed" to arrayOf("owed_amount", "owed", "arrears_balance", "arrears", "debt"),
    )

    fun show() {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(Color.BLACK)

        // —— 顶部操作栏 ——
        val topBar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(Color.rgb(0x1f, 0x1f, 0x1f))
            setPadding(dp(10), dp(4), dp(10), dp(4))
        }
        val title = TextView(context).apply {
            text = "登录或等待 · 成功后将自动完成"
            setTextColor(Color.WHITE)
            textSize = 13f
        }
        val cancelBtn = Button(context).apply {
            text = "取消"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(0x4a, 0x4a, 0x4a))
            textSize = 12f
            setOnClickListener { finish("用户取消", null) }
        }
        val doneBtn = Button(context).apply {
            text = "完成"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(0x1a, 0x7f, 0x37))
            textSize = 12f
            setOnClickListener { onDoneClick() }
        }
        topBar.addView(
            title,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f),
        )
        topBar.addView(
            cancelBtn,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { marginEnd = dp(8) },
        )
        topBar.addView(doneBtn)

        // —— WebView ——
        webView.apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            webViewClient = object : WebViewClient() {
                override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler?, error: SslError?) {
                    handler?.proceed() // 允许自签名证书站点
                }

                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?,
                ): WebResourceResponse? {
                    val url = request?.url?.toString() ?: return null
                    val kw = args.keyword.lowercase().trim()
                    val matched = if (kw.isEmpty()) {
                        // 关键字留空时用默认列表（对齐桌面 query_balance.js 的自动识别）
                        val low = url.lowercase()
                        listOf(
                            "query_balance", "get_balance", "account_balance", "available_amount",
                            "balance_info", "wallet", "quota", "/balance",
                        ).any { low.contains(it) }
                    } else {
                        url.lowercase().contains(kw)
                    }
                    if (!matched) return null
                    captureBalanceApi(url)
                    return null // 放行
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    val u = url ?: return
                    val low = u.lowercase()
                    Log.d("WebLogin", "onPageFinished: $u")
                    val isLoginPage = low.contains("login") || low.contains("signin") ||
                        low.contains("account.minimaxi") || low.contains("unified-auth")
                    if (isLoginPage) {
                        // 无登录态/登录态失效：显示登录页等待用户操作（后台无感期间保持隐藏）
                        attachIfNeeded()
                        return
                    }
                    if (!autoJumped && args.balanceUrl.isNotBlank() && !u.equals(args.balanceUrl, ignoreCase = true)) {
                        // 登录成功（离开登录页）→ 自动跳余额页
                        autoJumped = true
                        view?.loadUrl(args.balanceUrl)
                        return
                    }
                    // 已到余额页：等接口抓取（shouldInterceptRequest）+ 兜底从页面 DOM 提取
                    scheduleDoneIfCaptured()
                    extractFromDom()
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                    result?.confirm()
                    return true
                }
            }
        }
        addView(topBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(
            webView,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        // 不立即显示：有登录态时后台无感查询（不弹界面）；仅当需要登录（被重定向回登录页）才显示
        webView.loadUrl(args.balanceUrl)
        // 整体超时兜底：45 秒仍未完成（含用户登录等待）→ 返回失败，杜绝 invoke 永不返回导致前端永久「刷新中」
        Handler(Looper.getMainLooper()).postDelayed({
            if (!finished) {
                Log.d("WebLogin", "整体超时，返回失败")
                finish("查询超时（45 秒），请重试", null)
            }
        }, 45000)
    }

    /** 需要用户交互（登录/等待）时再把界面挂到 Activity（后台无感查询期间保持隐藏） */
    private fun attachIfNeeded() {
        if (attached || finished) return
        attached = true
        (context as? androidx.activity.ComponentActivity)?.let { act ->
            act.addContentView(
                this,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            // 返回键：WebView 可后退则后退，否则关闭
            act.onBackPressedDispatcher.addCallback(act, object : androidx.activity.OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    if (webView.canGoBack()) webView.goBack()
                    else finish("用户取消", null)
                }
            })
        }
    }

    /** 余额页加载完成后的兜底：抓到即自动完成 */
    private fun scheduleDoneIfCaptured() {
        if (doneScheduled || finished) return
        doneScheduled = true
        Handler(Looper.getMainLooper()).postDelayed({
            val cap = captured
            if (cap != null) {
                finish(null, cap)
            } else {
                doneScheduled = false // 允许后续页面再试
            }
        }, 3500)
    }

    /** 兜底：从已渲染的余额页 DOM 文本提取余额（接口拦截未命中时；兼容 SSR/页面直出）。
     *  SPA 渲染可能晚于 onPageFinished 数秒，故 2s 间隔最多重试 8 次（最长约 16s） */
    private fun extractFromDom() {
        if (finished || captured != null) return
        val attempt = object : Runnable {
            var tries = 0
            override fun run() {
                if (finished || captured != null) return
                tries++
                try {
                    webView.evaluateJavascript(
                        // encodeURIComponent 输出纯 ASCII，Kotlin 侧 URLDecoder 解码，绕开 JSON Unicode 解析问题
                        "(function(){return JSON.stringify(encodeURIComponent(document.body ? document.body.innerText : ''));})()",
                    ) { result ->
                        Log.d("WebLogin", "eval[$tries] raw=${if (result == null) "NULL" else result.take(120)}")
                        if (finished || captured != null) return@evaluateJavascript
                        if (result == null || result == "null") return@evaluateJavascript
                        try {
                            // result 形如 "\"...\""：去首尾引号后 URL 解码
                            val stripped = result.trim().removePrefix("\"").removeSuffix("\"")
                            val text = java.net.URLDecoder.decode(stripped, "UTF-8")
                            Log.d("WebLogin", "dom[$tries] len=${text.length} text=${text.take(300)}")
                            val bal = if (text.isBlank()) null else parseDomBalance(text)
                            if (bal != null) {
                                captured = JSObject().apply {
                                    put("success", true)
                                    put("message", "ok")
                                    put("balance", bal)
                                    put("cookie", CookieManager.getInstance().getCookie(args.balanceUrl) ?: "")
                                    put("apiUrl", "dom")
                                }
                                Handler(Looper.getMainLooper()).postDelayed({
                                    val cap = captured
                                    if (cap != null && !finished) finish(null, cap)
                                }, 500)
                            } else if (tries < 8) {
                                Handler(Looper.getMainLooper()).postDelayed(this, 2000)
                            } else {
                                // 重试耗尽仍无余额：返回失败，避免 invoke 永不返回导致前端永久「刷新中」
                                Log.d("WebLogin", "dom 提取重试耗尽，返回失败")
                                finish("未捕获到余额接口（请确认余额页已打开且接口/页面包含余额数据）", null)
                            }
                        } catch (_: Exception) {
                        }
                    }
                } catch (_: Exception) {
                }
            }
        }
        Handler(Looper.getMainLooper()).postDelayed(attempt, 2000)
    }

    /** 从页面文本正则提取余额（中英文常见标签） */
    private fun parseDomBalance(text: String): JSObject? {
        val out = JSObject()
        var any = false
        fun grab(labelRe: Regex, key: String) {
            if (out.has(key)) return
            val m = labelRe.find(text)
            if (m != null) {
                val v = m.groupValues[1].toDoubleOrNull()
                if (v != null) {
                    out.put(key, v)
                    any = true
                }
            }
        }
        // 可用/余额（主）——优先「可用额度」「可用余额」「当前余额」，兜底「余额」
        val avail = Regex("(?:可用额度|可用余额|当前余额|账户余额|Account balance|Available balance)[^0-9]{0,20}(?:¥|￥|\\$|RMB)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE)
            .find(text)
        if (avail != null) {
            avail.groupValues[1].toDoubleOrNull()?.let { out.put("available", it); any = true }
        }
        if (!out.has("available")) {
            grab(Regex("(?:余额|Balance)[^0-9]{0,20}(?:¥|￥|\\$)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE), "available")
        }
        grab(Regex("(?:现金|Cash)[^0-9]{0,20}(?:¥|￥|\\$)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE), "cash")
        grab(Regex("(?:代金券|赠金|Voucher|Gift)[^0-9]{0,20}(?:¥|￥|\\$)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE), "voucher")
        grab(Regex("(?:授信|信用|Credit)[^0-9]{0,20}(?:¥|￥|\\$)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE), "credit")
        grab(Regex("(?:欠费|Owed|Arrears)[^0-9]{0,20}(?:¥|￥|\\$)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)", RegexOption.IGNORE_CASE), "owed")
        return if (any) out else null
    }

    /** 拦截到余额接口：重发请求（带 Cookie）读响应体并解析；抓到即安排自动完成 */
    private fun captureBalanceApi(url: String) {
        try {
            val cookie = CookieManager.getInstance().getCookie(url) ?: ""
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.requestMethod = "GET"
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            if (cookie.isNotEmpty()) conn.setRequestProperty("Cookie", cookie)
            conn.setRequestProperty("User-Agent", webView.settings.userAgentString ?: "Mozilla/5.0")
            val code = conn.responseCode
            val body = if (code in 200..299) conn.inputStream.bufferedReader().use { it.readText() } else ""
            conn.disconnect()
            if (body.isNotBlank()) {
                parseBalance(body)?.let { bal ->
                    captured = JSObject().apply {
                        put("success", true)
                        put("message", "ok")
                        put("balance", bal)
                        put("cookie", cookie)
                        put("apiUrl", url)
                    }
                    Handler(Looper.getMainLooper()).postDelayed({
                        val cap = captured
                        if (cap != null && !finished) finish(null, cap)
                    }, 800) // 等页面稳定后自动完成
                }
            }
        } catch (_: Exception) {
            // 抓取失败不阻塞页面，点「完成」时再提示
        }
    }

    /** 递归解析余额字段（兼容多级嵌套） */
    private fun parseBalance(body: String): JSObject? {
        return try {
            val root = JSONObject(body)
            val out = JSObject()
            var any = false
            fun walk(o: JSONObject) {
                for ((key, aliases) in FIELD_ALIASES) {
                    if (out.has(key)) continue
                    for (a in aliases) {
                        if (o.has(a) && !o.isNull(a)) {
                            val v = o.optDouble(a, Double.NaN)
                            if (!v.isNaN()) {
                                out.put(key, v)
                                any = true
                            }
                            break
                        }
                    }
                }
                val it = o.keys()
                while (it.hasNext()) {
                    val k = it.next()
                    val v = o.opt(k)
                    if (v is JSONObject) walk(v)
                }
            }
            walk(root)
            if (any) out else null
        } catch (_: Exception) {
            null
        }
    }

    /** 手动完成：仅当已抓到接口时有效（抓取由自动流程承担） */
    private fun onDoneClick() {
        val cap = captured
        if (cap != null) {
            finish(null, cap)
            return
        }
        finish(
            "未捕获到余额接口：请确认已登录并停留在余额页（接口关键字「${if (args.keyword.isBlank()) "自动" else args.keyword}」）",
            null,
        )
    }

    private fun finish(message: String?, result: JSObject?) {
        if (finished) return
        finished = true
        Log.d("WebLogin", "finish success=${result != null} msg=${message ?: (result?.getString("message") ?: "")}")
        callback.onDone(
            JSObject().apply {
                put("success", result != null)
                put("message", result?.getString("message") ?: (message ?: "已取消"))
                if (result != null) {
                    put("balance", result.getJSObject("balance"))
                    put("cookie", result.getString("cookie"))
                    put("apiUrl", result.getString("apiUrl"))
                }
            },
        )
        (parent as? ViewGroup)?.removeView(this)
        webView.destroy()
    }

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()
}

// 安卓端「导出配置文件」（2026-09/16）：用户点导出后二选一
//   ① 系统分享 share()：文件写进 cacheDir/exports/ → FileProvider 授权 URI → ACTION_SEND 分享面板
//   ② 保存到本地 save()：ACTION_CREATE_DOCUMENT 让用户选位置 → 直接把内容写进所选 URI
// 为什么不用外部存储权限：走 FileProvider（临时授权）+ SAF，**零权限**，也不受分区存储限制。
// ⚠️ FileProvider 与 file_paths.xml 是 Tauri 安卓模板自带的（authority = ${applicationId}.fileprovider，
//    已声明 cache-path/external-path），所以这里**不需要改 AndroidManifest.xml**；但也因此
//    **只能分享 cacheDir 或外部目录下的文件** —— 别改成写 app 私有 dataDir（那种路径 FileProvider 不认）。
package com.apibalance.monitor

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.util.Log
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class ConfigExportPlugin(private val activity: Activity) : Plugin(activity) {

    companion object {
        private const val TAG = "ConfigExport"

        /**
         * 「保存到本地」待写内容：ACTION_CREATE_DOCUMENT 的结果在 @ActivityCallback 里才回来，
         * 而回调只拿得到 invoke + result（拿不到原 args），故先存在这里。
         * 放 companion（而非实例字段）：Activity 被系统回收重建时插件实例会重建，静态字段才能活下来。
         */
        @Volatile
        private var pendingFileName: String = ""

        @Volatile
        private var pendingContent: String = ""
    }

    /** 写进 cacheDir/exports/ —— 该目录被模板的 file_paths.xml（cache-path path="."）覆盖 */
    private fun writeCacheFile(fileName: String, content: String): File {
        val dir = File(activity.cacheDir, "exports")
        if (!dir.exists() && !dir.mkdirs()) throw IllegalStateException("无法创建导出目录")
        val f = File(dir, fileName)
        f.writeText(content, Charsets.UTF_8)
        Log.d(TAG, "cache file written: ${f.absolutePath} (${content.length} chars)")
        return f
    }

    /** ① 系统分享：把**文件**发出去（微信/QQ/网盘/蓝牙/邮件等，由系统分享面板决定） */
    @Command
    fun share(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ExportArgs::class.java)
            val file = writeCacheFile(args.fileName, args.content)
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, uri)
                putExtra(Intent.EXTRA_SUBJECT, args.fileName)
                // FLAG_GRANT_READ_URI_PERMISSION 给接收方临时读权限；clipData 是部分目标（老系统/微信）
                // 能拿到授权的关键 —— 只给 EXTRA_STREAM 时它们会因无权限读不到文件。
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newRawUri(args.fileName, uri)
            }
            activity.runOnUiThread {
                try {
                    activity.startActivity(Intent.createChooser(send, "分享配置文件"))
                    invoke.resolve(outcome(ok = true, mode = "share", path = file.absolutePath, message = "已打开分享面板"))
                } catch (e: Exception) {
                    Log.d(TAG, "share chooser failed: ${e.message}")
                    invoke.reject("打开分享面板失败：${e.message}")
                }
            }
        } catch (e: Exception) {
            Log.d(TAG, "share failed: ${e.message}")
            invoke.reject("分享失败：${e.message}")
        }
    }

    /** ② 保存到本地：走系统「保存文件」界面（ACTION_CREATE_DOCUMENT），零存储权限 */
    @Command
    fun save(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ExportArgs::class.java)
            pendingFileName = args.fileName
            pendingContent = args.content
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_TITLE, args.fileName)
            }
            // 结果在 saveResult（@ActivityCallback）里回来
            startActivityForResult(invoke, intent, "saveResult")
        } catch (e: Exception) {
            Log.d(TAG, "save failed: ${e.message}")
            invoke.reject("保存失败：${e.message}")
        }
    }

    /** 「保存到本地」的回调：把内容写进用户选定的 URI */
    @ActivityCallback
    private fun saveResult(invoke: Invoke, activityResult: ActivityResult) {
        val uri = activityResult.data?.data
        if (activityResult.resultCode != Activity.RESULT_OK || uri == null) {
            Log.d(TAG, "save cancelled by user")
            // 用户取消不算错误：resolve 一个 cancelled 结果，前端显示中性提示而不报红
            invoke.resolve(outcome(ok = false, mode = "save", cancelled = true, message = "已取消"))
            return
        }
        try {
            activity.contentResolver.openOutputStream(uri)?.use { out ->
                out.write(pendingContent.toByteArray(Charsets.UTF_8))
            } ?: throw IllegalStateException("无法写入所选位置")
            Log.d(TAG, "saved to $uri (${pendingContent.length} chars, name=$pendingFileName)")
            invoke.resolve(outcome(ok = true, mode = "save", path = uri.toString(), message = "已保存到所选位置"))
        } catch (e: Exception) {
            Log.d(TAG, "write to picked uri failed: ${e.message}")
            invoke.reject("写入所选位置失败：${e.message}")
        } finally {
            pendingFileName = ""
            pendingContent = ""
        }
    }

    private fun outcome(
        ok: Boolean,
        mode: String,
        path: String = "",
        cancelled: Boolean = false,
        message: String = "",
    ): JSObject = JSObject().apply {
        put("ok", ok)
        put("mode", mode)
        put("path", path)
        put("cancelled", cancelled)
        put("message", message)
    }
}

/** 导出参数（camelCase 与 Rust 侧 serde 命名对齐） */
@InvokeArg
class ExportArgs {
    lateinit var fileName: String
    lateinit var content: String
}

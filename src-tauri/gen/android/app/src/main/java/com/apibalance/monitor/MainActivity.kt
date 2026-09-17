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
}
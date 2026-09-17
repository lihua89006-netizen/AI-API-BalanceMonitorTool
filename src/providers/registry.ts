// 7 个内置适配器 + 注册表（Sub2API / One-API / New-API 框架已统一由 generic_login_html
// 自动识别接管——见 generic_login_html.ts：账号密码登录 + 登录路径自动探测 + 余额自动识别）
//
// 注册顺序 = 「添加站点」类型选择列表顺序（用户指定）：DeepSeek → 自动识别 → 阿里云 → 火山引擎 → OpenCode → 其余
// 「模拟浏览器登录」为兜底方案，排在最后（其它方式识别不了时用）

import { aliyunProvider } from './aliyun'
import { browserLoginProvider } from './browser_login'
import { codeAiProvider } from './code_ai'
import { deepseekProvider } from './deepseek'
import { genericLoginHtmlProvider } from './generic_login_html'
import { openaiCompatProvider } from './openai_compat'
import { openrouterProvider } from './openrouter'
import { volcengineProvider } from './volcengine'
import type { Provider } from './types'

export const PROVIDERS: Provider[] = [
  deepseekProvider, // 1 DeepSeek 官方
  genericLoginHtmlProvider, // 2 自动识别(中转站用这个)：账号登录 + 自动识别（Sub2API / One-API / New-API 通用）
  aliyunProvider, // 3 阿里云账户余额（AccessKey + BssOpenApi）
  volcengineProvider, // 4 火山引擎账户余额（AccessKey + 火山签名）
  codeAiProvider, // 5 Code AI（OpenCode / CommandCode，下拉选择）
  openaiCompatProvider, // 6 OpenAI 兼容计费接口
  openrouterProvider, // 7 OpenRouter
  browserLoginProvider, // 8 模拟浏览器登录（兜底：Edge 无头 + 账号密码抓余额接口）
]

export function getProvider(id: string): Provider | undefined {
  // 兼容旧版独立「OpenCode」适配器 id（合并进 Code AI 入口后保留别名）
  if (id === 'opencode') return codeAiProvider
  return PROVIDERS.find((p) => p.id === id)
}


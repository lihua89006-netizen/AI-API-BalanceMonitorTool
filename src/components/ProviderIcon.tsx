// 官方品牌图标（@lobehub/icons）：DeepSeek / 阿里云 / 火山引擎
// 使用官方彩色（Color）变体

import { AlibabaCloud, DeepSeek, Volcengine } from '@lobehub/icons'

export default function ProviderIcon({ providerId }: { providerId: string }) {
  if (providerId === 'deepseek_official') return <DeepSeek.Color size={20} />
  if (providerId === 'aliyun') return <AlibabaCloud.Color size={20} />
  if (providerId === 'volcengine') return <Volcengine.Color size={20} />
  return null
}

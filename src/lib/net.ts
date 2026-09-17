// 生产环境的 NetClient：走 Tauri Rust 网络层（Rust 侧 reqwest，cookie 保持）

import { invoke } from '@tauri-apps/api/core'
import type { NetClient, NetRequest, NetResponse } from '../providers/types'

export const tauriNetClient: NetClient = {
  async request(req: NetRequest): Promise<NetResponse> {
    return invoke<NetResponse>('http_request', { req })
  },
}

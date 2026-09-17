/* 开发期量测中间件（仅 vite serve 生效）：
 *  - GET  /__aqm/trigger  读取 probe/trigger.json（由外部脚本改写 run 号即触发一轮量测）
 *  - POST /__aqm/trace    把探针回传的逐帧采样写入 probe/traces/
 *  - 向 index.html 注入探针模块（仅挂件窗口会真正工作）
 * 生产构建（apply: 'serve'）完全不参与。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { PluginOption } from 'vite'

export function aqmProbe(): PluginOption {
  const root = process.cwd()
  const probeDir = path.join(root, 'probe')
  const triggerFile = path.join(probeDir, 'trigger.json')
  const traceDir = path.join(probeDir, 'traces')

  return {
    name: 'aqm-probe',
    apply: 'serve',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module', src: '/probe/zoom-probe.ts' },
          injectTo: 'body',
        },
      ]
    },
    configureServer(server) {
      fs.mkdirSync(traceDir, { recursive: true })
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const url = req.url.split('?')[0]

        if (url === '/__aqm/trigger') {
          let body = '{"run":0,"notches":6,"deltaY":-100,"gapMs":70,"anchorFx":0.4,"anchorFy":0.45,"paint":true,"settleMs":1600}'
          try {
            if (fs.existsSync(triggerFile)) body = fs.readFileSync(triggerFile, 'utf8')
          } catch {
            /* 读失败就用默认计划 */
          }
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.end(body)
          return
        }

        if (url === '/__aqm/trace' && req.method === 'POST') {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              const run = data?.plan?.run ?? 0
              const name = `run-${String(run).padStart(3, '0')}-${Date.now()}.json`
              fs.writeFileSync(path.join(traceDir, name), JSON.stringify(data, null, 1))
              console.log(`[aqm-probe] trace 落盘 ${name}（帧数 ${data?.samples?.length ?? 0}）`)
            } catch (e) {
              console.error('[aqm-probe] trace 写入失败', e)
            }
            res.setHeader('content-type', 'application/json')
            res.end('{"ok":true}')
          })
          return
        }

        next()
      })
    },
  }
}

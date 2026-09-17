// 配置文件导入 / 导出：**只走文件**（导入选 .json，导出把文件本身放进剪贴板）
// + 方案 B（二维码，支持口令加密，**暂时禁用**见下方开关）

import { useRef, useState } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { Download, Upload } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import {
  buildExportFileText,
  buildExportText,
  buildQRPayload,
  decompressBytes,
  exportFileName,
  parseAnyImportPayload,
} from '../lib/sync'
import { decryptPayload, isEncryptedPayload } from '../lib/crypto'
import type { AppConfig, ProviderEntry } from '../lib/store'

/**
 * 方案 B（二维码导出/导入）**暂时禁用** —— 2026-09/16 用户口径。
 * 实现、状态与 handler 全部保留，仅不渲染这一段的入口；把这里改回 `true` 即恢复。
 * 恢复时请顺带复核：`qrcode`/`jsqr` 两个依赖仍在打包产物体积里（禁用期不做摇树），
 * 以及 §4.9 的容量结论（L 级约 28 站上限、超 10 站建议剪贴板）。
 * 注：被包住的 JSX **保持原有缩进**，好让「恢复/再禁用」都是两行以内的 diff，不产生整块重排噪声。
 */
const ENABLE_QR_SECTION: boolean = false

/** 安卓端判定（与 SiteDialog / SettingsDialog / App 同口径：main.tsx 写入的 dataset.platform） */
function isAndroidPlatform(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android'
}

/** Rust `export_config_file` 的返回（camelCase 与 ExportOutcome 对齐） */
interface ExportOutcome {
  ok: boolean
  /** `clipboard`（Windows）/ `share` / `save`（安卓） */
  mode: string
  path: string
  /** 用户主动取消（安卓「保存到本地」被取消）——不是错误 */
  cancelled: boolean
  message: string
}

interface SyncDialogProps {
  cfg: AppConfig
  onClose: () => void
  onApplyProviders: (providers: ProviderEntry[]) => void
}

/** 从图片文件解析二维码（本地解析，数据不出设备）。返回文本 + 原始字节（jsQR 保留 byte 模式原字节） */
async function decodeQRFile(file: File): Promise<{ text: string; bytes: number[] | null }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('读取图片失败'))
    r.readAsDataURL(file)
  })
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('图片解码失败'))
    img.src = dataUrl
  })
  // 降采样到最长边 1024，避免大图解析缓慢
  const canvas = document.createElement('canvas')
  const scale = Math.min(1, 1024 / Math.max(img.width, img.height))
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建画布')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const result = jsQR(data, width, height, { inversionAttempts: 'dontInvert' })
  // 二进制 byte 模式（压缩二维码）时 data 为空串但 binaryData 含原始字节，两者任一有效即成功
  if (!result || (!result.data && !(result.binaryData && result.binaryData.length > 0))) {
    throw new Error('未识别出二维码，请确认图片清晰完整')
  }
  return { text: result.data, bytes: result.binaryData ?? null }
}

export default function SyncDialog({ cfg, onClose, onApplyProviders }: SyncDialogProps) {
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // 导入：从文件读取的文本（加密文件要先存下来，等用户填口令后再解）
  const [importFileText, setImportFileText] = useState('')
  // 导出：是否加密（滑动开关，与设置页「自动打开鲸鱼娘窗口」同款控件）+ 口令
  // 默认**开启**（2026-09/16 用户口径）：导出物含 API Key 甚至云厂商 AccessKey Secret，
  // 让"加密"成为默认路径、明文需要用户主动关掉；口令为空时按钮会报错而不是退回明文。
  const [encryptExport, setEncryptExport] = useState(true)
  const [exportPwd, setExportPwd] = useState('')
  // 安卓端：点导出后先让用户二选一（系统分享 / 保存到本地）
  const [androidPick, setAndroidPick] = useState(false)
  const [showImportPwd, setShowImportPwd] = useState(false)
  const [importPwd, setImportPwd] = useState('')
  const importFileRef = useRef<HTMLInputElement>(null)
  // 方案 B 二维码：生成 / 导入（暂时禁用，见 ENABLE_QR_SECTION）
  const [qrImageUrl, setQrImageUrl] = useState('')
  const [qrPwdStep, setQrPwdStep] = useState(false)
  const [qrPwd, setQrPwd] = useState('')
  const [qrImportPwdStep, setQrImportPwdStep] = useState(false)
  const [qrImportPwd, setQrImportPwd] = useState('')
  const [qrPending, setQrPending] = useState('') // 待口令解密的二维码文本
  const qrFileRef = useRef<HTMLInputElement>(null)

  // ===== 导入 / 导出配置文件（2026-09/16 改版：**只走文件**，文本粘贴方案已删除）=====
  /**
   * 导出配置文件。**按平台分流**：
   * - Windows：Rust 把文件写成 `.json` 并把**文件本身**放进剪贴板（`CF_HDROP`）→ 到资源管理器/
   *   微信/QQ 里 `Ctrl+V` 粘出来的就是文件（用户口径：不做"另存为"对话框）。
   * - 安卓（2026-09/16 用户口径「AB 结合」）：先选**系统分享**（ACTION_SEND + FileProvider）
   *   或**保存到本地**（ACTION_CREATE_DOCUMENT），由 Kotlin 插件 `ConfigExportPlugin.kt` 实现。
   * 明文还是密文由滑动开关决定，口径在 `buildExportFileText`（lib/sync.ts，含单测）：
   * 开关打开但口令为空时**抛错，绝不回退成明文**（否则用户以为已加密）。
   * @param mode 仅安卓用：`share` / `save`
   */
  const handleExport = async (mode?: 'share' | 'save') => {
    try {
      const text = await buildExportFileText(cfg, { encrypt: encryptExport, password: exportPwd })
      const fileName = exportFileName()
      const r = await invoke<ExportOutcome>('export_config_file', {
        text,
        fileName,
        mode: mode ?? null,
      })
      setAndroidPick(false)
      if (r.cancelled) {
        setStatus({ kind: 'ok', text: '已取消导出' })
        return
      }
      if (r.mode === 'clipboard') {
        setStatus({
          kind: 'ok',
          text: encryptExport
            ? `已把配置文件放进剪贴板：${fileName}\n到文件夹 / 微信 / QQ 里直接粘贴（Ctrl+V）即可；导入时需输入同一口令，口令丢失无法恢复。\n文件位置：${r.path}`
            : `已把配置文件放进剪贴板：${fileName}\n到文件夹 / 微信 / QQ 里直接粘贴（Ctrl+V）即可。注意：文件含明文 API Key，请妥善保管。\n文件位置：${r.path}`,
        })
        return
      }
      // 安卓：share = 已打开分享面板；save = 已写进用户选定的位置
      setStatus({
        kind: 'ok',
        text: `${r.message}：${fileName}${r.mode === 'save' ? `\n保存位置：${r.path}` : ''}`,
      })
    } catch (e) {
      setStatus({ kind: 'err', text: `导出失败：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  /** 选好文件后读取内容并走导入流程（加密文件会先要口令） */
  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text()
      if (!text.trim()) {
        setStatus({ kind: 'err', text: `文件是空的：${file.name}` })
        return
      }
      setImportFileText(text)
      await applyImportText(text, {
        pwdStep: false,
        pwd: '',
        setPwdStep: setShowImportPwd,
        setPwd: setImportPwd,
      })
    } catch (e) {
      setStatus({
        kind: 'err',
        text: `读取文件失败：${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }

  /** 解析并应用配置文本（含口令解密、确认、合并）—— 文件导入 / 二维码导入共用 */
  const applyImportText = async (
    raw: string,
    opts: { pwdStep: boolean; pwd: string; setPwdStep: (v: boolean) => void; setPwd: (v: string) => void },
  ): Promise<boolean> => {
    let text = raw.trim()
    if (isEncryptedPayload(text)) {
      if (!opts.pwdStep) {
        opts.setPwdStep(true)
        setStatus({ kind: 'ok', text: '检测到加密配置，请输入口令后继续导入' })
        return false
      }
      if (!opts.pwd.trim()) {
        setStatus({ kind: 'err', text: '口令不能为空' })
        return false
      }
      try {
        text = (await decryptPayload(text, opts.pwd)).trim()
      } catch {
        setStatus({ kind: 'err', text: '口令错误或数据已损坏' })
        return false
      }
      opts.setPwdStep(false)
      opts.setPwd('')
    } else if (opts.pwdStep) {
      opts.setPwdStep(false)
    }
    const result = await parseAnyImportPayload(text)
    if (!result.ok) {
      setStatus({ kind: 'err', text: result.message })
      return false
    }
    if (!window.confirm(`${result.message}\n\n导入规则：同 ID 站点覆盖，新站点追加。`)) return false
    onApplyProviders(result.entries)
    setStatus({ kind: 'ok', text: `${result.message}，已应用` })
    return true
  }

  // ===== 方案 B：二维码 =====
  /** 导出为二维码：qrPwdStep 打开时用口令加密内容；deflate 压缩 payload + 低纠错级控制二维码密度 */
  const handleQRExport = async () => {
    try {
      let data: string | { data: Uint8Array; mode: 'byte' }[]
      if (qrPwdStep) {
        // 加密路径：与方案 A 共用 buildExportText（同格式同压缩，二维码/剪贴板两路产物一致可互认）
        data = await buildExportText(cfg, { encrypt: true, password: qrPwd })
        setQrPwdStep(false)
        setQrPwd('')
        setStatus({ kind: 'ok', text: '已加密生成二维码（导入时需输入同一口令）' })
      } else {
        // 明文路径：二进制 byte 模式直编（魔数 + deflate 原始字节），无 base64 膨胀、模块更少更易识别
        data = [{ data: await buildQRPayload(cfg), mode: 'byte' }]
        setStatus({ kind: 'ok', text: '二维码已生成（内容为明文，含 API Key，请注意周围环境）' })
      }
      const url = await QRCode.toDataURL(data, {
        width: 512, // 渲染分辨率足够大，模块边缘清晰
        margin: 4, // 标准安静区，手机扫码更稳
        errorCorrectionLevel: 'L', // 低纠错 = 最大容量、最低密度，识别更稳
      })
      setQrImageUrl(url)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/too big|overflow|data.*large/i.test(msg)) {
        setStatus({
          kind: 'err',
          text: '配置内容超出二维码容量，请改用方案 A（剪贴板）导出。',
        })
      } else {
        setStatus({ kind: 'err', text: `生成二维码失败：${msg}` })
      }
    }
  }

  const handleQRFile = async (file: File) => {
    try {
      const { text, bytes } = await decodeQRFile(file)
      setQrImageUrl('') // 导入成功后清掉旧的导出二维码，避免混淆
      // 二进制 byte 模式（新版压缩二维码）：直接解压原始字节
      if (bytes && bytes.length >= 2 && bytes[0] === 0x5a && bytes[1] === 0x31) {
        const plain = await decompressBytes(new Uint8Array(bytes))
        await applyImportText(plain, {
          pwdStep: false,
          pwd: '',
          setPwdStep: setQrImportPwdStep,
          setPwd: setQrImportPwd,
        })
        return
      }
      // 加密内容：先存文本，等用户输入口令后由「确认导入」解密
      if (isEncryptedPayload(text)) {
        setQrPending(text)
        setQrImportPwdStep(true)
        setStatus({ kind: 'ok', text: '检测到加密配置，请输入口令后继续导入' })
        return
      }
      await applyImportText(text, {
        pwdStep: false,
        pwd: '',
        setPwdStep: setQrImportPwdStep,
        setPwd: setQrImportPwd,
      })
    } catch (e) {
      setStatus({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog sync-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">导出到其他设备</h2>

        {/* 配置文件：**只走文件**（2026-09/16 用户口径：删掉文本粘贴方案，导入/导出都针对 .json 文件） */}
        <div className="sync-section">
          <div className="sync-section-title">配置文件</div>
          {/* 是否加密：滑动开关（与设置页「自动打开鲸鱼娘窗口」同款控件，不加说明文本） */}
          <div className="switch-row">
            <span className="switch-label">加密导出</span>
            <button
              type="button"
              role="switch"
              aria-checked={encryptExport}
              aria-label="加密导出"
              className={`switch ${encryptExport ? 'on' : ''}`}
              onClick={() => setEncryptExport((v) => !v)}
            >
              <span className="switch-thumb" />
            </button>
          </div>
          {encryptExport && (
            <div className="sync-pwd-row">
              <input
                className="field-input"
                type="password"
                value={exportPwd}
                onChange={(e) => setExportPwd(e.target.value)}
                placeholder="设置口令（导入时需输入同一口令）"
              />
            </div>
          )}
          {/* 按钮按用户要求：**导入靠左、导出靠右**（.split = space-between）；两个都用次级样式，
              **导出不再是蓝色**（2026-09/16）。图标：导入沿用主界面那颗 `Download`、导出用 `Upload`
              （尺寸/描边对齐 SiteActionsDialog 的约定） */}
          <div className="sync-actions split">
            <button className="btn secondary" onClick={() => importFileRef.current?.click()}>
              <Download size={14} strokeWidth={2.2} /> 导入配置文件
            </button>
            <button
              className="btn secondary"
              onClick={() => {
                // 安卓没有"文件放进剪贴板"这条路，先让用户选分享还是保存（用户口径：AB 结合）
                if (isAndroidPlatform()) setAndroidPick(true)
                else void handleExport()
              }}
            >
              <Upload size={14} strokeWidth={2.2} /> 导出配置文件
            </button>
            <input
              ref={importFileRef}
              type="file"
              accept=".json,.txt,application/json,text/plain"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleImportFile(f)
                e.target.value = ''
              }}
            />
          </div>
          {/* 安卓：导出方式二选一（AB 结合 —— 系统分享面板 / 保存到本地） */}
          {androidPick && (
            <div className="sync-actions">
              <button className="btn secondary" onClick={() => void handleExport('share')}>
                系统分享
              </button>
              <button className="btn secondary" onClick={() => void handleExport('save')}>
                保存到本地
              </button>
              <button className="btn secondary" onClick={() => setAndroidPick(false)}>
                取消
              </button>
            </div>
          )}
          {showImportPwd && (
            <div className="sync-pwd-row">
              <input
                className="field-input"
                type="password"
                value={importPwd}
                onChange={(e) => setImportPwd(e.target.value)}
                placeholder="输入该配置文件的口令"
              />
              <button
                className="btn primary"
                onClick={() =>
                  void applyImportText(importFileText, {
                    pwdStep: true,
                    pwd: importPwd,
                    setPwdStep: setShowImportPwd,
                    setPwd: setImportPwd,
                  })
                }
              >
                确认导入
              </button>
            </div>
          )}
        </div>

        {/* 方案 B：二维码（本地生成/解析，支持口令加密）—— 暂时禁用（ENABLE_QR_SECTION） */}
        {ENABLE_QR_SECTION && (
        <div className="sync-section">
          <div className="sync-section-title">方案 B · 二维码</div>
          <p className="field-hint">手机/另一台设备扫码即可传输，数据全程本地生成与解析。</p>
          <div className="sync-actions">
            <button className="btn primary" onClick={handleQRExport}>
              导出为二维码
            </button>
            <button
              className="btn secondary"
              onClick={() => {
                if (!qrPwdStep) {
                  setQrPwdStep(true)
                  setStatus({ kind: 'ok', text: '请输入口令，用于加密二维码内容' })
                } else {
                  void handleQRExport()
                }
              }}
            >
              {qrPwdStep ? '确认生成' : '加密导出二维码'}
            </button>
          </div>
          {qrPwdStep && (
            <div className="sync-pwd-row">
              <input
                className="field-input"
                type="password"
                value={qrPwd}
                onChange={(e) => setQrPwd(e.target.value)}
                placeholder="设置口令（导入时需输入同一口令）"
              />
              <button className="btn primary" onClick={handleQRExport}>
                生成
              </button>
            </div>
          )}
          {qrImageUrl && (
            <div className="qr-box">
              <img className="qr-img" src={qrImageUrl} alt="配置二维码" />
              <p className="field-hint">
                用另一台设备扫码：截屏/拍照保存为图片，再在对方设备点「从图片识别导入」
              </p>
            </div>
          )}
          <div className="sync-actions">
            <button className="btn secondary" onClick={() => qrFileRef.current?.click()}>
              从图片识别导入
            </button>
            <input
              ref={qrFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleQRFile(f)
                e.target.value = ''
              }}
            />
          </div>
          {qrImportPwdStep && (
            <div className="sync-pwd-row">
              <input
                className="field-input"
                type="password"
                value={qrImportPwd}
                onChange={(e) => setQrImportPwd(e.target.value)}
                placeholder="输入加密二维码的口令"
              />
              <button
                className="btn primary"
                onClick={() =>
                  void applyImportText(qrPending, {
                    pwdStep: true,
                    pwd: qrImportPwd,
                    setPwdStep: setQrImportPwdStep,
                    setPwd: setQrImportPwd,
                  })
                }
              >
                确认导入
              </button>
            </div>
          )}
        </div>
        )}

        {status && (
          <div className={`test-result ${status.kind === 'ok' ? 'ok' : 'err'}`}>{status.text}</div>
        )}

        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn secondary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

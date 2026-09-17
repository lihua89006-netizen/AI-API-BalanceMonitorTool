// 轻量 Toast 提示：短暂显示成功/失败/信息，自动消失
// 用法：setToast({ kind: 'ok' | 'err', text: '...' })

export interface ToastData {
  kind: 'ok' | 'err'
  text: string
}

export default function Toast({ toast }: { toast: ToastData | null }) {
  if (!toast) return null
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      {toast.kind === 'ok' ? '✓ ' : '✕ '}
      {toast.text}
    </div>
  )
}
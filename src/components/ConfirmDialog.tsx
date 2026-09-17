// 自绘确认框（替代 window.confirm：Android WebView 不可靠 + 深色模式样式可控）

interface ConfirmDialogProps {
  title: string
  message: string
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title,
  message,
  confirmText = '删除',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="dialog-title">{title}</h2>
        <p className="confirm-message">{message}</p>
        <div className="dialog-actions">
          <span className="spacer" />
          <button className="btn secondary" onClick={onCancel}>
            取消
          </button>
          <button className="btn danger-solid" onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

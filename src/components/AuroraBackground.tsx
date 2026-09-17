// 极光背景：弥散光球画布（对应原 Python 版 aurora.py，CSS 动画实现）

export default function AuroraBackground() {
  return (
    <div className="aurora" aria-hidden="true">
      <div className="aurora-orb orb-1" />
      <div className="aurora-orb orb-2" />
      <div className="aurora-orb orb-3" />
    </div>
  )
}

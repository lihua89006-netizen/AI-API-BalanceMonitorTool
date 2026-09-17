// 自制下拉菜单（替代原生 select）：完全 CSS 控制配色，避免 Windows 原生下拉面板在深色模式下看不清

import { useEffect, useRef, useState } from 'react'

export interface MenuOption<T extends string> {
  value: T
  label: string
}

interface MenuSelectProps<T extends string> {
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  title?: string
  className?: string
  /** 下拉面板对齐方向（默认 right） */
  align?: 'left' | 'right'
}

export default function MenuSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  title,
  className = '',
  align = 'right',
}: MenuSelectProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className={`menu-select ${className}`} ref={rootRef}>
      <button
        type="button"
        className="menu-select-btn"
        disabled={disabled}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? value}</span>
        <span className="menu-select-arrow">▾</span>
      </button>
      {open && (
        <div className={`menu-select-pop ${align === 'left' ? 'align-left' : ''}`}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`menu-select-item ${o.value === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

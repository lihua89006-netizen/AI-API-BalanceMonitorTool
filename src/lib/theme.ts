// 主题系统：浅色 / 深色 / 跟随系统（CSS 变量驱动，data-theme 切换）

export type ThemeChoice = 'light' | 'dark' | 'system'

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return choice
}

export function applyTheme(choice: ThemeChoice): 'light' | 'dark' {
  const effective = resolveTheme(choice)
  document.documentElement.dataset.theme = effective
  return effective
}

/** 订阅系统主题变化（跟随系统时自动切换） */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => onChange(e.matches)
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}

// 悬浮提示：JS 动态创建 fixed 定位 tooltip（脱离滚动容器，不被裁剪/遮挡）
// 鼠标移入带 .tip[data-tip] 的元素时，在按钮上方显示；移出移除
// 支持 data-tip 内 \n 换行（pre-line），左对齐按钮左缘，超右缘自动收拢

let tipEl: HTMLDivElement | null = null

function getTip(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div')
    tipEl.className = 'float-tip'
    document.body.appendChild(tipEl)
  }
  return tipEl
}

function showTip(target: HTMLElement) {
  const text = target.dataset.tip ?? ''
  if (!text) return
  const tip = getTip()
  tip.textContent = text // 保留 \n，CSS pre-line 显示
  const rect = target.getBoundingClientRect()
  tip.style.display = 'block'
  tip.style.visibility = 'hidden'
  tip.style.left = '0px'
  tip.style.top = '0px'
  const tw = tip.offsetWidth
  const th = tip.offsetHeight
  const gap = 4 // 悬浮文本与按钮的间距（近一些）
  // 水平居中于目标按钮，超出视口边缘时自动收拢
  let left = rect.left + rect.width / 2 - tw / 2
  if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8
  // .tip-below：强制显示在按钮下方（如方案筛选按钮）；其余默认上方，放不下才转下方
  let top
  if (target.classList.contains('tip-below')) {
    top = rect.bottom + gap
  } else {
    top = rect.top - th - gap
    if (top < 4) top = rect.bottom + gap // 上方放不下（窗口顶部）则显示在下方
  }
  tip.style.left = `${Math.max(4, left)}px`
  tip.style.top = `${top}px`
  tip.style.visibility = 'visible'
}

function hideTip() {
  if (tipEl) tipEl.style.display = 'none'
}

/** 初始化全局悬浮提示（在每个窗口入口调用一次） */
export function setupTooltips() {
  // Android/触摸端悬浮提示无意义（没有 hover 概念），且触摸时模拟的 mouseover
  // 会让按钮上粘连悬浮文字；桌面端才启用
  if (typeof document !== 'undefined' && document.documentElement.dataset.platform === 'android') {
    return
  }
  document.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest?.('.tip[data-tip]') as HTMLElement | null
    if (target) showTip(target)
    else hideTip()
  })
  document.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest?.('.tip[data-tip]') as HTMLElement | null
    if (!target) hideTip()
  })
  document.addEventListener('mousedown', hideTip)
}

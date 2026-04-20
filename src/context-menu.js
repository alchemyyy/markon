import { createElement } from './utils.js'

// Single shared context menu — only one is ever on screen at a time.
// Callers pass a position and a list of items; we render, position
// safely inside the viewport, and dismiss on outside-click or Escape.
//
// items: [{ label, disabled?, onClick }]

let activeMenu = null

const dismiss = () => {
	if (!activeMenu) return
	activeMenu.remove()
	activeMenu = null
	document.removeEventListener('pointerdown', onOutsidePointer, true)
	document.removeEventListener('keydown', onMenuKey, true)
}

const onOutsidePointer = e => {
	if (activeMenu && !activeMenu.contains(e.target)) dismiss()
}
const onMenuKey = e => {
	if (e.key === 'Escape') dismiss()
}

export const showContextMenu = ({ x, y }, items) => {
	dismiss()
	if (!items?.length) return

	const menu = createElement('div', { className: 'context-menu' })
	for (const it of items) {
		const btn = createElement('button', { className: 'context-menu-item', textContent: it.label })
		if (it.disabled) btn.disabled = true
		btn.addEventListener('click', () => {
			dismiss()
			try {
				it.onClick()
			} catch (e) {
				console.warn('context menu action failed', e)
			}
		})
		menu.appendChild(btn)
	}

	document.body.appendChild(menu)
	// Clamp to viewport so menus near the right/bottom edge don't clip.
	const rect = menu.getBoundingClientRect()
	const px = Math.min(x, window.innerWidth - rect.width - 8)
	const py = Math.min(y, window.innerHeight - rect.height - 8)
	menu.style.left = `${Math.max(8, px)}px`
	menu.style.top = `${Math.max(8, py)}px`

	activeMenu = menu
	// Capture-phase so we beat the targeted element's own pointerdown
	// listeners (e.g. tab drag init) when clicking outside.
	document.addEventListener('pointerdown', onOutsidePointer, true)
	document.addEventListener('keydown', onMenuKey, true)
}

export const dismissContextMenu = dismiss

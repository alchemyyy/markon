import { createButtons } from './actions.js'
import { setupHotkeys } from './hotkeys.js'
import { createPreviewManager, createResizeHandler } from './resize.js'
import { createSettingsDialog } from './settings.js'
import { createScrollSync } from './sync.js'
import { observeTheme } from './syntax.js'
import { createTOC } from './toc.js'
import createToolbar from './toolbar.js'
import { applyTheme, createPointerHandler, createToast, getPrefTheme } from './utils.js'

// Initialize UI components
export const initUI = async ({ getMarkdown, setMarkdown, scrollToLine, view }) => {
	// Setup toast
	const toast = document.getElementById('toast')
	const showToast = createToast(toast)

	// Setup theme
	const { theme, mode } = getPrefTheme()
	await applyTheme(theme, mode)

	// Setup settings system
	const settingsDialog = createSettingsDialog(showToast)

	// Setup all buttons (including settings)
	createButtons(showToast, settingsDialog)

	// Tooltip clip avoidance: each toolbar button's tooltip is centered under
	// the button via translateX(-50%); the leftmost buttons would push their
	// tooltip off the left edge of the screen. Compute the would-be position
	// from the button rect + tip offsetWidth (transform-independent), and
	// shift just enough to keep an 8px margin to either edge.
	//
	// Re-runs on every hover (delegated, bubbling event) so the shift adapts
	// to window resize and to moving directly between buttons without ever
	// leaving the actions container.
	const adjustTooltip = btn => {
		const tip = btn.querySelector(':scope > span')
		if (!tip) return
		const btnRect = btn.getBoundingClientRect()
		const btnCenter = btnRect.left + btnRect.width / 2
		const tipWidth = tip.offsetWidth
		const naturalLeft = btnCenter - tipWidth / 2
		const naturalRight = btnCenter + tipWidth / 2
		const margin = 8
		let shift = 0
		if (naturalLeft < margin) shift = margin - naturalLeft
		else if (naturalRight > window.innerWidth - margin) shift = window.innerWidth - margin - naturalRight
		tip.style.transform = shift !== 0 ? `translateX(calc(-50% + ${shift}px)) translateY(0)` : ''
	}
	const actionsContainer = document.getElementById('actions')
	if (actionsContainer) {
		// `mouseover` bubbles, unlike `mouseenter`/`pointerenter`, so a single
		// listener handles all buttons including ones added later, and fires
		// reliably when moving directly between adjacent buttons.
		actionsContainer.addEventListener('mouseover', e => {
			const btn = e.target.closest('button')
			if (btn && actionsContainer.contains(btn)) adjustTooltip(btn)
		})
	}

	// Setup hotkeys
	setupHotkeys(settingsDialog)

	// Setup theme observer
	observeTheme()

	// Setup preview manager and toggle button
	const previewManager = createPreviewManager(document.getElementById('wrap'))

	// Setup resize functionality
	const split = document.getElementById('split')
	const resizeHandle = document.getElementById('resize-handle')
	const previewAside = document.getElementById('preview')
	const wrap = document.getElementById('wrap')
	createPointerHandler(split, createResizeHandler(split, previewAside, wrap, previewManager))
	createPointerHandler(resizeHandle, createResizeHandler(split, previewAside, wrap, previewManager))

	// Setup toolbar with auto-hide behavior
	createToolbar()

	// Setup TOC
	const previewHtml = document.getElementById('previewhtml')
	const previewContainer = document.getElementById('preview')
	if (previewHtml && previewContainer) {
		createTOC(previewHtml, previewContainer, { getMarkdown, scrollToLine })
	}

	// Setup editor sync
	let editorSync = null
	if (view && previewContainer) {
		editorSync = createScrollSync(view, previewContainer, getMarkdown, scrollToLine)
		const syncEnabled = localStorage.getItem('editor-sync-enabled') === 'true'
		if (syncEnabled) {
			editorSync.enable()
		}
		const btn = document.getElementById('toggle-editor-sync')
		if (btn) {
			btn.setAttribute('aria-pressed', String(syncEnabled))
		}
	}

	// Expose markdown functions globally for button access
	window.getMarkdown = getMarkdown
	window.setMarkdown = setMarkdown
	window.previewManager = previewManager
	window.showToast = showToast
	window.editorSync = editorSync
	window.readClipboardSmart = async () => {
		const { readClipboardSmart } = await import('./utils.js')
		return readClipboardSmart()
	}

	// Return preview HTML element for preview module
	return { previewHtml: document.getElementById('previewhtml'), showToast }
}

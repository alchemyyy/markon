import { createEventHandler, createElement, createClickHandler } from './utils.js'

const SNAP_THRESHOLD = 80

const applySnap = (width, maxWidth) =>
	width < SNAP_THRESHOLD ? 0 : width > maxWidth - SNAP_THRESHOLD ? maxWidth : width

const setPreviewWidth = (width, wrap) => {
	const finalWidth = Math.max(width, 0)
	// Tree column width is owned by the --tree-w CSS variable (toggled by html.tree-open).
	wrap.style.gridTemplateColumns = `var(--tree-w, 0px) 1fr 14px ${finalWidth}px`
}

export const createPreviewManager = wrap => {
	// Default split: 60% editor, 40% preview (of the editor+split+preview area).
	const splitGap = 14
	const initialWrapW = wrap.getBoundingClientRect().width || window.innerWidth
	let _width = Math.max(0, Math.round((initialWrapW - splitGap) * 0.4))
	const previewToggleIcon = document.getElementById('preview-toggle')

	// Wrap iconify-icon in a button container (like toolbar buttons)
	const previewToggle = createElement('button', {
		className: 'preview-toggle',
		id: 'preview-toggle-wrapper',
	})

	// Move the iconify-icon into the button
	if (previewToggleIcon) {
		previewToggleIcon.parentNode?.insertBefore(previewToggle, previewToggleIcon)
		previewToggle.appendChild(previewToggleIcon)

		// Add popover span with hotkey
		const popoverSpan = createElement('span', {
			textContent: 'Toggle • ctrl+p',
		})
		previewToggle.appendChild(popoverSpan)
	}

	const setWidth = newWidth => {
		_width = newWidth
		setPreviewWidth(newWidth, wrap)
		previewToggleIcon?.setAttribute('aria-pressed', String(newWidth > 0))
	}

	const toggle = () => setWidth(_width === 0 ? 400 : 0)

	createClickHandler(previewToggle, toggle)

	setWidth(_width)

	return {
		toggle,
		setWidth,
		get width() {
			return _width
		},
		set width(value) {
			_width = value
		},
	}
}

export const createResizeHandler = (split, previewAside, wrap, previewManager) => e => {
	const startX = e.clientX
	const startWidth = previewAside.getBoundingClientRect().width

	split.classList.add('active')

	let pendingWidth = null
	let rafId = null

	const applyPending = () => {
		if (pendingWidth == null) {
			rafId = null
			return
		}
		setPreviewWidth(pendingWidth, wrap)
		if (previewManager) previewManager.width = pendingWidth
		pendingWidth = null
		rafId = null
	}

	const onMove = ev => {
		const dx = startX - ev.clientX
		pendingWidth = Math.max(0, startWidth + dx)

		if (!rafId) {
			rafId = requestAnimationFrame(applyPending)
		}
	}

	const onUp = () => {
		split.classList.remove('active')
		removeMoveListener()
		removeUpListener()

		const finalWidth = previewAside.getBoundingClientRect().width
		const maxWidth = wrap.getBoundingClientRect().width - 14
		const snappedWidth = applySnap(finalWidth, maxWidth)

		if (snappedWidth !== finalWidth) {
			setPreviewWidth(snappedWidth, wrap)
		}

		if (previewManager) {
			previewManager.width = snappedWidth
		}
	}

	const removeMoveListener = createEventHandler(window, 'pointermove', onMove)
	const removeUpListener = createEventHandler(window, 'pointerup', onUp)
}

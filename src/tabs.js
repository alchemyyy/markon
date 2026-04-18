import { createElement } from './utils.js'

// Pointer-event based reorder: more reliable than HTML5 drag in WebView2,
// and lets us add nice visual feedback (the dragged tab follows the cursor;
// other tabs stay put; we drop into the slot under the cursor on release).
const DRAG_THRESHOLD = 4 // px of movement before treating a press as a drag

// Chrome-style tear-off: if the pointer strays this far above or below the tab
// bar while dragging, releasing will pop the tab out into its own native
// window. Chosen generously so casual vertical jitter doesn't accidentally
// tear off a tab the user just wanted to reorder.
const TEAROFF_Y_THRESHOLD = 40 // px beyond the tab-bar edge

export const createTabBar = ({ docs, container }) => {
	const bar = createElement('div', { id: 'tab-bar' })
	container.appendChild(bar)

	let drag = null // { el, from, startX, started, to, tearingOff, lastClientX, lastClientY }
	let lastDragEndAt = 0

	const tabElements = () => [...bar.children].filter(c => c.classList.contains('tab'))

	// Trigger a reorder when the dragged tab has been displaced by more than
	// 25% of a tab-width. Each additional full tab-width of drag past that
	// point bumps the target by one more slot. Symmetric for left/right.
	const REORDER_OVERLAP = 0.25
	const computeTarget = (dx, fromIdx, totalTabs, draggedW) => {
		let slots = 0
		if (Math.abs(dx) >= REORDER_OVERLAP * draggedW) {
			// Boundaries: |dx| >= 0.25w → 1 slot, >= 1.25w → 2 slots, etc.
			slots = Math.sign(dx) * Math.floor((Math.abs(dx) + (1 - REORDER_OVERLAP) * draggedW) / draggedW)
		}
		return Math.max(0, Math.min(totalTabs - 1, fromIdx + slots))
	}

	// Apply Chrome-style live displacement: while the dragged tab follows the
	// cursor, every other tab is shifted left/right by exactly one tab-width
	// to open up the destination slot. Driven entirely by inline transforms
	// — no DOM mutation, no docs state change — until the user releases.
	const applyShifts = () => {
		if (!drag || drag.to == null) return
		const w = drag.el.offsetWidth
		const all = tabElements()
		for (let i = 0; i < all.length; i++) {
			const t = all[i]
			if (t === drag.el) continue
			let shift = 0
			if (i > drag.from && i <= drag.to) shift = -w
			else if (i < drag.from && i >= drag.to) shift = w
			t.style.transform = shift ? `translateX(${shift}px)` : ''
		}
	}

	const onMove = e => {
		if (!drag) return
		// If a structural re-render swapped out the dragged element behind our
		// back, abort cleanly instead of mutating a detached node.
		if (!bar.contains(drag.el)) {
			endDrag()
			return
		}
		const dx = e.clientX - drag.startX
		const dy = e.clientY - drag.startY
		drag.lastClientX = e.clientX
		drag.lastClientY = e.clientY
		// MouseEvent.screenX/Y is in CSS pixels relative to the primary screen.
		// We use this (rather than window.screenX + clientX) for the drop
		// hit-test because it's what the spec guarantees and avoids any
		// Tauri-vs-browser divergence in how window.screenX is reported.
		drag.lastScreenX = e.screenX
		drag.lastScreenY = e.screenY
		if (!drag.started) {
			if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
			drag.started = true
			drag.el.classList.add('dragging')
		}

		// Tear-off detection: once the pointer leaves the tab bar vertically by
		// more than the threshold, flip into tear-off mode. The tab still
		// follows horizontally inside the bar (so live-reorder shifts revert),
		// but we visually mark it as ready-to-tear and skip reorder math.
		// We always allow the visual state — docs.tearOff() decides whether
		// the drop spawns a new window, rejoins another window, or bounces.
		const rect = bar.getBoundingClientRect()
		const outOfBar = e.clientY < rect.top - TEAROFF_Y_THRESHOLD || e.clientY > rect.bottom + TEAROFF_Y_THRESHOLD
		const tearingOff = outOfBar
		if (tearingOff !== drag.tearingOff) {
			drag.tearingOff = tearingOff
			drag.el.classList.toggle('tearing-off', tearingOff)
			if (tearingOff) {
				// Revert live-reorder shifts on siblings while in tear-off mode.
				for (const t of tabElements()) if (t !== drag.el) t.style.transform = ''
				drag.to = drag.from
			}
		}

		drag.el.style.transform = `translateX(${dx}px)${tearingOff ? ` translateY(${Math.max(-20, Math.min(20, dy * 0.25))}px)` : ''}`

		if (tearingOff) return

		const newTo = computeTarget(dx, drag.from, tabElements().length, drag.el.offsetWidth)
		if (newTo !== drag.to) {
			drag.to = newTo
			applyShifts()
		}
	}

	const endDrag = () => {
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', endDrag)
		window.removeEventListener('pointercancel', endDrag)
		if (!drag) return
		const captured = drag
		drag = null
		if (!captured.started) return

		lastDragEndAt = Date.now()

		if (captured.tearingOff) {
			const id = captured.el.dataset.id
			// Tauri's window APIs (outerPosition/outerSize, new window x/y) use
			// physical pixels — convert the release's CSS-pixel screen coords
			// by DPR. No cursor offset here; tearOff() nudges the spawn
			// position itself when it creates a new window.
			const dpr = window.devicePixelRatio || 1
			const dropAt = {
				x: Math.round((captured.lastScreenX ?? 0) * dpr),
				y: Math.round((captured.lastScreenY ?? 0) * dpr),
			}
			const resetVisual = () => {
				for (const t of tabElements()) t.style.transform = ''
				captured.el.classList.remove('dragging', 'tearing-off')
			}
			docs.tearOff(id, dropAt).then(ok => {
				// Tear-off rejected (web mode, only tab, or Tauri error) —
				// snap the tab back into place. On success, docs renders the
				// new state and naturally drops the transforms.
				if (!ok) resetVisual()
			})
			return
		}

		if (captured.to != null && captured.to !== captured.from) {
			// reorder() fires a render that replaces every tab element with a
			// fresh one in the new order — that naturally drops every transform
			// and the .dragging class, so the swap looks instantaneous.
			docs.reorder(captured.from, captured.to)
		} else {
			// No reorder happened — manually reset the shifts we applied.
			for (const t of tabElements()) t.style.transform = ''
			captured.el.classList.remove('dragging')
		}
	}

	const makeTab = doc => {
		const el = createElement('div', {
			className: 'tab' + (doc.id === docs.getActive()?.id ? ' active' : '') + (docs.isDirty(doc) ? ' dirty' : ''),
			title: doc.path ?? doc.name,
		})
		el.dataset.id = doc.id

		const label = createElement('span', { className: 'tab-label', textContent: doc.name })
		const close = createElement('button', { className: 'tab-close', title: 'Close' })
		close.innerHTML = '<iconify-icon icon="tabler:x" width="14"></iconify-icon>'
		el.append(label, close)

		el.addEventListener('pointerdown', e => {
			if (e.button !== 0) return // left button only
			if (e.target.closest('.tab-close')) return
			const idx = tabElements().indexOf(el)
			if (idx < 0) return
			drag = {
				el,
				from: idx,
				startX: e.clientX,
				startY: e.clientY,
				started: false,
				to: null,
				tearingOff: false,
				lastClientX: e.clientX,
				lastClientY: e.clientY,
				lastScreenX: e.screenX,
				lastScreenY: e.screenY,
			}
			window.addEventListener('pointermove', onMove)
			window.addEventListener('pointerup', endDrag)
			window.addEventListener('pointercancel', endDrag)
		})

		el.addEventListener('click', e => {
			// Swallow the click event the browser fires right after a real drag
			// so the drop doesn't also fire a tab switch.
			if (Date.now() - lastDragEndAt < 150) {
				e.stopPropagation()
				return
			}
			if (e.target.closest('.tab-close')) return
			docs.switchTo(doc.id)
		})

		// Middle-click closes (common convention)
		el.addEventListener('auxclick', e => {
			if (e.button === 1) {
				e.preventDefault()
				docs.close(doc.id)
			}
		})

		close.addEventListener('click', e => {
			e.stopPropagation()
			docs.close(doc.id)
		})

		return el
	}

	const render = ({ tabs, activeId }) => {
		bar.replaceChildren()
		bar.classList.toggle('hidden', tabs.length === 0)

		for (const doc of tabs) {
			const el = makeTab(doc)
			if (doc.id === activeId) el.classList.add('active')
			bar.appendChild(el)
		}

		const addBtn = createElement('button', { className: 'tab-new', title: 'New tab' })
		addBtn.innerHTML = '<iconify-icon icon="tabler:plus" width="16"></iconify-icon>'
		addBtn.addEventListener('click', () => docs.newUntitled())
		bar.appendChild(addBtn)
	}

	docs.onChange(render)
	return { bar }
}

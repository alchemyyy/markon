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

		// Post tear-off, the tab has popped into its own window. The new
		// window will ask the OS for the current cursor position directly
		// (via snap_and_drag in Rust) once its tab is built, so we don't
		// need to keep pumping coords — just swallow pointer events here
		// until the user releases.
		if (drag.tornOff) return

		// If a structural re-render swapped out the dragged element behind our
		// back, abort cleanly instead of mutating a detached node.
		if (!bar.contains(drag.el)) {
			endDrag()
			return
		}
		const dx = e.clientX - drag.startX
		const dy = e.clientY - drag.startY
		if (!drag.started) {
			if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
			drag.started = true
			drag.el.classList.add('dragging')
		}

		// Chrome-style tear-off: the moment the pointer leaves the tab bar
		// beyond the threshold, pop the tab into a brand-new native window.
		// We mark the drag `tornOff` but keep listeners alive so we still
		// see the user's pointerup (needed to avoid a stuck drag state).
		const rect = bar.getBoundingClientRect()
		const outOfBar = e.clientY < rect.top - TEAROFF_Y_THRESHOLD || e.clientY > rect.bottom + TEAROFF_Y_THRESHOLD
		if (outOfBar) {
			const id = drag.el.dataset.id
			// MouseEvent.screenX/Y are CSS pixels — pass through to Tauri's
			// logical-pixel window options unscaled.
			const dropAt = { x: Math.round(e.screenX), y: Math.round(e.screenY) }
			drag.tornOff = true
			docs.tearOffInFlight(id, dropAt)
			return
		}

		drag.el.style.transform = `translateX(${dx}px)`

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

		// After tear-off the tab no longer belongs to this window — nothing
		// to reset or reorder here. OS drag (if it caught in time) ends on
		// its own when the user releases. Stamp lastDragEndAt so the
		// trailing click event doesn't fire a tab switch on a tab that
		// was just torn out from under it.
		if (captured.tornOff) {
			lastDragEndAt = Date.now()
			return
		}

		// Pure click (no drag past the threshold) — leave lastDragEndAt
		// alone so the click handler doesn't get swallowed as post-drag
		// noise. Tab switching depends on this.
		if (!captured.started) return

		lastDragEndAt = Date.now()

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

	// When a tab is docked into this window mid-drag (source window is
	// about to destroy), the OS drag session ends and the cursor becomes
	// "free" again. Pointer events start reaching us, but there's no
	// preceding pointerdown to enter a normal drag state. To support
	// Chrome-style "continue dragging after dock", we arm a one-shot
	// listener here: on the next pointermove, if the user's mouse button
	// is still held, we spin up a drag on the newly-inserted tab as if
	// they had just pointerdown'd on it. From there all the usual drag
	// machinery (reorder within bar, tear-off past threshold) just works.
	const armDragContinuation = tabId => {
		let timer = null
		const cleanup = () => {
			if (timer) clearTimeout(timer)
			timer = null
			window.removeEventListener('pointermove', onFirstMove)
			window.removeEventListener('pointerup', onFirstUp)
			window.removeEventListener('pointercancel', onFirstUp)
		}
		const onFirstMove = e => {
			cleanup()
			// Button already released (pointermove with no buttons held) —
			// user just dropped, no continuation needed.
			if (e.buttons === 0) return
			const all = tabElements()
			const tabEl = all.find(t => t.dataset.id === tabId)
			if (!tabEl) return
			const idx = all.indexOf(tabEl)
			if (idx < 0) return
			drag = {
				el: tabEl,
				from: idx,
				startX: e.clientX,
				startY: e.clientY,
				// Skip the DRAG_THRESHOLD gate — we know the user is
				// already mid-gesture; treat the drag as active right away.
				started: true,
				to: null,
				tornOff: false,
			}
			tabEl.classList.add('dragging')
			window.addEventListener('pointermove', onMove)
			window.addEventListener('pointerup', endDrag)
			window.addEventListener('pointercancel', endDrag)
		}
		const onFirstUp = () => cleanup()
		// Safety: if no pointer events fire at all (e.g. user clicked the
		// tab bar with a stylus that doesn't report buttons), give up.
		timer = setTimeout(cleanup, 1500)
		window.addEventListener('pointermove', onFirstMove)
		window.addEventListener('pointerup', onFirstUp)
		window.addEventListener('pointercancel', onFirstUp)
	}

	docs.onTabDocked?.(armDragContinuation)

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

			// If this is the only tab in the window, dragging it drags the
			// whole window (nothing to reorder or tear off). docs handles
			// this — it starts OS drag AND watches for the drag settling
			// over another window's tab bar, in which case the tab docks
			// into that window and ours closes/empties.
			if (tabElements().length === 1) {
				docs.dockTabViaWindowDrag(doc.id, e.screenX, e.screenY)
				return
			}

			const idx = tabElements().indexOf(el)
			if (idx < 0) return
			drag = {
				el,
				from: idx,
				startX: e.clientX,
				startY: e.clientY,
				started: false,
				to: null,
				tornOff: false,
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

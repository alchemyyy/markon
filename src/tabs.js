import { createElement } from './utils.js'

// Pointer-event based reorder: more reliable than HTML5 drag in WebView2,
// and lets us add nice visual feedback (the dragged tab follows the cursor;
// other tabs stay put; we drop into the slot under the cursor on release).
const DRAG_THRESHOLD = 4 // px of movement before treating a press as a drag

export const createTabBar = ({ docs, container }) => {
	const bar = createElement('div', { id: 'tab-bar' })
	container.appendChild(bar)

	let drag = null // { el, from, startX, started, to }
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
		if (!drag.started) {
			if (Math.abs(dx) < DRAG_THRESHOLD) return
			drag.started = true
			drag.el.classList.add('dragging')
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
			drag = { el, from: idx, startX: e.clientX, started: false, to: null }
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

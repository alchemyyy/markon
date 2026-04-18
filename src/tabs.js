import { createElement } from './utils.js'

// Chrome-like tab bar with drag-reorder and close buttons.
// Hidden when only 0–1 tabs exist.
export const createTabBar = ({ docs, container }) => {
	const bar = createElement('div', { id: 'tab-bar' })
	container.appendChild(bar)

	let dragState = null

	const makeTab = doc => {
		const el = createElement('div', {
			className: 'tab' + (doc.id === docs.getActive()?.id ? ' active' : '') + (docs.isDirty(doc) ? ' dirty' : ''),
			draggable: 'true',
			title: doc.path ?? doc.name,
		})
		el.dataset.id = doc.id

		const label = createElement('span', { className: 'tab-label', textContent: doc.name })
		const close = createElement('button', { className: 'tab-close', title: 'Close' })
		close.innerHTML = '<iconify-icon icon="tabler:x" width="14"></iconify-icon>'

		el.append(label, close)

		el.addEventListener('click', e => {
			if (e.target.closest('.tab-close')) return
			docs.switchTo(doc.id)
		})

		// Middle-click also closes (common convention)
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

		el.addEventListener('dragstart', e => {
			dragState = { id: doc.id, from: [...bar.children].indexOf(el) }
			el.classList.add('dragging')
			e.dataTransfer.effectAllowed = 'move'
			e.dataTransfer.setData('text/plain', doc.id)
		})

		el.addEventListener('dragend', () => {
			el.classList.remove('dragging')
			for (const c of bar.children) c.classList.remove('drag-over')
			dragState = null
		})

		el.addEventListener('dragover', e => {
			if (!dragState) return
			e.preventDefault()
			e.dataTransfer.dropEffect = 'move'
			// Simple insertion indicator: class on target
			for (const c of bar.children) c.classList.remove('drag-over')
			el.classList.add('drag-over')
		})

		el.addEventListener('drop', e => {
			if (!dragState) return
			e.preventDefault()
			const tabs = [...bar.children]
			const toIdx = tabs.indexOf(el)
			const fromIdx = dragState.from
			if (toIdx >= 0 && fromIdx >= 0) docs.reorder(fromIdx, toIdx)
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

		const addBtn = createElement('button', {
			className: 'tab-new',
			title: 'New tab',
		})
		addBtn.innerHTML = '<iconify-icon icon="tabler:plus" width="16"></iconify-icon>'
		addBtn.addEventListener('click', () => docs.newUntitled())
		bar.appendChild(addBtn)
	}

	docs.onChange(render)
	return { bar }
}

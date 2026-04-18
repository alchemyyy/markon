import { clearRecent, getRecent, removeRecent } from './recent.js'
import { createElement } from './utils.js'

const basename = p => (p ? p.split(/[\\/]/).pop() : '')
const dirname = p => {
	if (!p) return ''
	const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
	return i > 0 ? p.slice(0, i) : ''
}

export const createRecentDropdown = ({ docs, showToast }) => {
	const dropdown = createElement('div', { id: 'recent-dropdown', hidden: true })
	document.body.appendChild(dropdown)

	const render = () => {
		dropdown.replaceChildren()
		const list = getRecent()

		const header = createElement('div', { className: 'recent-header' })
		header.append(
			createElement('span', { textContent: 'Recent files' }),
			(() => {
				const btn = createElement('button', {
					className: 'recent-clear',
					textContent: 'Clear',
					title: 'Clear recent files',
				})
				btn.addEventListener('click', e => {
					e.stopPropagation()
					clearRecent()
					render()
				})
				return btn
			})(),
		)
		dropdown.appendChild(header)

		if (!list.length) {
			dropdown.appendChild(createElement('div', { className: 'recent-empty', textContent: 'No recent files' }))
			return
		}

		for (const path of list) {
			const row = createElement('div', { className: 'recent-row', title: path })
			const name = createElement('span', { className: 'recent-name', textContent: basename(path) })
			const dir = createElement('span', { className: 'recent-dir', textContent: dirname(path) })
			const del = createElement('button', { className: 'recent-remove', title: 'Remove from recent' })
			del.innerHTML = '<iconify-icon icon="tabler:x" width="12"></iconify-icon>'

			row.append(name, dir, del)

			row.addEventListener('click', async e => {
				if (e.target.closest('.recent-remove')) return
				hide()
				const doc = await docs.openPath(path)
				if (!doc) {
					showToast?.('file unavailable', 1200, 'tabler:alert-circle')
					removeRecent(path)
					render()
				}
			})

			del.addEventListener('click', e => {
				e.stopPropagation()
				removeRecent(path)
				render()
			})

			dropdown.appendChild(row)
		}
	}

	const show = anchor => {
		render()
		dropdown.hidden = false
		const rect = anchor.getBoundingClientRect()
		dropdown.style.top = `${rect.bottom + 4}px`
		dropdown.style.right = `${window.innerWidth - rect.right}px`
	}

	const hide = () => {
		dropdown.hidden = true
	}

	const toggle = anchor => {
		if (dropdown.hidden) show(anchor)
		else hide()
	}

	// Close on outside click
	document.addEventListener('click', e => {
		if (dropdown.hidden) return
		if (dropdown.contains(e.target)) return
		if (e.target.closest('#recent-files')) return
		hide()
	})

	return { show, hide, toggle }
}

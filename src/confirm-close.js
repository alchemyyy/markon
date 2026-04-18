import { createElement } from './utils.js'

// Modal save/discard/cancel prompt. Resolves to 'save' | 'discard' | 'cancel'.
// Promise never rejects — ESC, backdrop click, or Cancel all resolve to 'cancel'.
export const confirmCloseFile = name =>
	new Promise(resolve => {
		let resolved = false
		const finish = choice => {
			if (resolved) return
			resolved = true
			dialog.close()
			resolve(choice)
		}

		const dialog = createElement('dialog', { className: 'confirm-close-dialog', closedby: 'any' })
		const title = createElement('div', {
			className: 'confirm-close-title',
			textContent: 'Unsaved changes',
		})
		const message = createElement('div', { className: 'confirm-close-message' })
		message.append(
			document.createTextNode('Save changes to '),
			createElement('strong', { textContent: name }),
			document.createTextNode(' before closing?'),
		)

		const actions = createElement('div', { className: 'confirm-close-actions' })
		const cancelBtn = createElement('button', { className: 'confirm-close-btn', textContent: 'Cancel' })
		const discardBtn = createElement('button', {
			className: 'confirm-close-btn danger',
			textContent: 'Discard',
		})
		const saveBtn = createElement('button', { className: 'confirm-close-btn primary', textContent: 'Save' })
		actions.append(cancelBtn, discardBtn, saveBtn)

		cancelBtn.addEventListener('click', () => finish('cancel'))
		discardBtn.addEventListener('click', () => finish('discard'))
		saveBtn.addEventListener('click', () => finish('save'))

		// ESC, backdrop click, or any other implicit dismissal → cancel
		dialog.addEventListener('cancel', e => {
			e.preventDefault()
			finish('cancel')
		})
		dialog.addEventListener('click', e => {
			if (e.target === dialog) finish('cancel')
		})
		dialog.addEventListener('close', () => {
			if (!resolved) {
				resolved = true
				resolve('cancel')
			}
			dialog.remove()
		})

		dialog.append(title, message, actions)
		document.body.appendChild(dialog)
		dialog.showModal()
		// Default focus on Save (most common safe action) but selectable via Tab.
		saveBtn.focus()
	})

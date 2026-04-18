import { getActionHandlers } from './actions.js'
import { HOTKEYS } from './settings.js'
import { $ } from './utils.js'

// Key event handler
export const createKeyHandler = settingsDialog => e => {
	// Allow hotkeys to work even when editor is focused
	// Only skip if it's a regular input/textarea (not CodeMirror)
	if (e.target.matches('input:not([data-cm-editor]), textarea:not([data-cm-editor])')) return

	const key = e.key.toLowerCase()
	const hasCtrl = e.ctrlKey || e.metaKey
	const hasAlt = e.altKey
	const hasShift = e.shiftKey

	// Build modifier string (ctrl → alt → shift, matches HOTKEYS format)
	let modifierString = ''
	if (hasCtrl) modifierString += 'ctrl+'
	if (hasAlt) modifierString += 'alt+'
	if (hasShift) modifierString += 'shift+'
	const fullKey = modifierString + key

	// Regular hotkeys
	const hotkey = HOTKEYS.find(([k]) => k === fullKey)
	if (hotkey) {
		e.preventDefault()
		const [, , targetId] = hotkey

		// Special handling for settings
		if (targetId === 'settings') {
			settingsDialog.show()
			return
		}

		// Special handling for toggle-preview
		if (targetId === 'preview-toggle' && window.previewManager) {
			window.previewManager.toggle()
			return
		}

		// Button present? click it. Otherwise invoke handler directly
		// (some actions like save-as / toggle-editor-sync live outside the toolbar).
		const el = $(targetId)
		if (el) {
			el.click()
			return
		}
		const handler = getActionHandlers()[targetId]
		if (handler && window.showToast) handler(window.showToast)
	}
}

// Setup hotkeys
export const setupHotkeys = settingsDialog => {
	window.addEventListener('keydown', createKeyHandler(settingsDialog), true)
}

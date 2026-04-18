export const $ = sel => document.getElementById(sel)
export const el = (tag, attrs = {}) => Object.assign(document.createElement(tag), attrs)

const styles = `
#toast {
	position: fixed;
	bottom: 60px;
	left: 50%;
	color: var(--accent);
	transform: translateX(-50%);
	background: var(--bg-light);
	border: 2px solid var(--accent);
	padding: 16px 24px;
	border-radius: 16px;
	box-shadow: 0 4px 12px var(--shadow-strong);
	backdrop-filter: blur(16px);
	z-index: 10001;
	max-width: 90vw;
	white-space: nowrap;
	opacity: 0;
	transition: all 0.3s ease;
	font-size: 14px;
	font-weight: 500;
	display: flex;
	align-items: center;
	gap: 8px;
}

#toast:not([hidden]) {
	opacity: 1;
	transform: translateX(-50%) translateY(-4px);
}

#toast iconify-icon {
	flex-shrink: 0;
}

`

const styleSheet = document.createElement('style')
styleSheet.textContent = styles
document.head.appendChild(styleSheet)


export const createToast =
	toast =>
	(msg, ms = 1_200, icon = null) => {
		// Clear existing content
		toast.innerHTML = ''

		// Add icon if provided
		if (icon) {
			const iconEl = el('iconify-icon', { icon, width: '18', height: '18' })
			toast.appendChild(iconEl)
		}

		// Add text content
		const textEl = el('span', { textContent: msg })
		toast.appendChild(textEl)

		// Move toast into open dialog if one exists (to appear above dialog)
		const openDialog = document.querySelector('dialog[open]')
		const originalParent = toast.parentNode
		if (openDialog && toast.parentNode !== openDialog) {
			openDialog.appendChild(toast)
		}

		toast.removeAttribute('hidden')
		clearTimeout(window.__toastTimer)
		window.__toastTimer = setTimeout(() => {
			toast.setAttribute('hidden', '')
			// Move toast back to original location if it was moved
			if (originalParent && toast.parentNode !== originalParent) {
				originalParent.appendChild(toast)
			}
		}, ms)
	}

export const copySmart = async (text, notify) => {
	const fallback = () => {
		const ta = el('textarea', {
			value: text,
			style: 'position:fixed;top:-9999px;left:-9999px;opacity:0;width:1px;height:1px;border:none;outline:none;resize:none;overflow:hidden;'
		})
		document.body.appendChild(ta)
		ta.focus()
		ta.select()
		const ok = document.execCommand('copy')
		notify(ok ? 'copied to clipboard' : 'copy failed', 1200, ok ? 'tabler:check' : 'tabler:alert-circle')
		ta.remove()
	}

	return (
		navigator.clipboard
			?.writeText?.(text)
			?.then(() => notify('copied to clipboard', 1200, 'tabler:check'))
			?.catch(fallback) ?? fallback()
	)
}

export const readClipboardSmart = async () =>
	!navigator.clipboard?.readText ? null : await navigator.clipboard.readText().catch(() => null)

export const downloadText = (name, text) => {
	const extension = name.split('.').pop().toLowerCase()
	const mimeTypes = {
		css: 'text/css;charset=utf-8',
		js: 'text/javascript;charset=utf-8',
		html: 'text/html;charset=utf-8',
		md: 'text/markdown;charset=utf-8',
		json: 'application/json;charset=utf-8',
		txt: 'text/plain;charset=utf-8'
	}
	const mimeType = mimeTypes[extension] || 'text/plain;charset=utf-8'

	const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
	const a = el('a', { href: url, download: name })
	document.body.appendChild(a)
	a.click()
	a.remove()
	URL.revokeObjectURL(url)
}

export const openFileText = () =>
	new Promise(resolve => {
		const input = el('input', { type: 'file', accept: '.md,text/markdown,text/plain' })
		input.onchange = async () => {
			const file = input.files?.[0]
			resolve(file ? await file.text() : null)
		}
		input.click()
	})

export const openFileCSS = () =>
	new Promise(resolve => {
		const input = el('input', { type: 'file', accept: '.css,text/css' })
		input.onchange = async () => {
			const file = input.files?.[0]
			resolve(file ? await file.text() : null)
		}
		input.click()
	})

export const saveCustomThemesCSS = (cssText) => {
	localStorage.setItem('custom-themes-css', cssText)
	injectCustomThemesCSS()
}

export const loadCustomThemesCSS = () => {
	return localStorage.getItem('custom-themes-css')
}

export const clearCustomThemesCSS = () => {
	localStorage.removeItem('custom-themes-css')
	removeCustomThemesCSS()
}

export const injectCustomThemesCSS = () => {
	const customCSS = loadCustomThemesCSS()
	if (!customCSS) return

	removeCustomThemesCSS()

	const style = document.createElement('style')
	style.id = 'custom-themes'
	style.textContent = customCSS
	document.head.appendChild(style)
}

export const removeCustomThemesCSS = () => {
	const existing = document.getElementById('custom-themes')
	if (existing) existing.remove()
}



export const extractThemesFromCSS = () => {
	const themesSheet = findThemesSheet()
	if (!themesSheet) return []

	const themeNames = extractThemeNames(themesSheet)
	return themeNames.map(name => ({ id: name, colors: getThemeColors(name) }))
		.filter(theme => theme.colors.length > 0)
}

const findThemesSheet = () =>
	Array.from(document.styleSheets).find(sheet =>
		sheet.href?.includes('themes.css') ||
		hasThemeRules(sheet))

const hasThemeRules = sheet => {
	try {
		return Array.from(sheet.cssRules).some(rule =>
			rule.selectorText?.includes('[data-theme="panda"]'))
	} catch {
		return false
	}
}

const extractThemeNames = sheet => {
	try {
		return [...new Set(Array.from(sheet.cssRules)
			.filter(rule => rule.selectorText?.includes('[data-theme='))
			.map(rule => rule.selectorText.match(/\[data-theme="([^"]+)"/)?.[1])
			.filter(Boolean))]
	} catch {
		return []
	}
}

const getThemeColors = themeName => {
	const themesSheet = findThemesSheet()
	if (!themesSheet) return []

	try {
		const themeRule = Array.from(themesSheet.cssRules)
			.find(rule => rule.selectorText?.includes(`[data-theme="${themeName}"][data-mode="dark"]`))

		if (!themeRule) return []

		return ['--brand', '--accent', '--primary', '--secondary']
			.map(varName => themeRule.style?.getPropertyValue(varName)?.trim())
			.filter(Boolean)
	} catch {
		return []
	}
}


export const getPrefTheme = () => {
	const params = new URLSearchParams(window.location.search)
	const theme = params.get('theme') || localStorage.getItem('theme-name') || 'github-modified'
	const mode = params.get('mode') || localStorage.getItem('theme-mode') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')

	return { theme, mode }
}

const updateThemeColor = () => {
	const brandColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-light').trim()
	const meta = document.querySelector('meta[name="theme-color"]')
	if (meta && brandColor) meta.setAttribute('content', brandColor)
}

export const applyTheme = async (themeName, mode) => {
	const validTheme = themeName && themeName !== 'undefined' ? themeName : 'github-modified'
	const validMode = mode && mode !== 'undefined' ? mode : 'dark'

	const html = document.documentElement
	html.setAttribute('data-theme', validTheme)
	html.setAttribute('data-mode', validMode)
	html.classList.toggle('light', validMode === 'light')
	localStorage.setItem('theme-name', validTheme)
	localStorage.setItem('theme-mode', validMode)

	const { setHlTheme } = await import('./syntax.js')
	setHlTheme(validMode)

	updateThemeColor()
}

export const applySpell = (on = document.querySelector('#toggle-spell')?.getAttribute('aria-pressed') === 'true') => {
	document.querySelector('.cm-content')?.setAttribute('spellcheck', String(on))
}


export const createElement = (tag, attributes = {}, children = []) => {
	const element = Object.assign(document.createElement(tag), attributes)
	children.forEach(child => {
		element.appendChild(child)
	})
	return element
}

export const createEventHandler = (element, event, handler, options = {}) => {
	element.addEventListener(event, handler, options)
	return () => element.removeEventListener(event, handler, options)
}

export const createClickHandler = (element, handler) => createEventHandler(element, 'click', handler)
export const createPointerHandler = (element, handler) => createEventHandler(element, 'pointerdown', handler)


import { downloadText, openFileCSS, openFileText } from './utils.js'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const basename = path => (path ? path.split(/[\\/]/).pop() : null)

const MD_FILTERS = [
	{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
	{ name: 'All Files', extensions: ['*'] },
]

const CSS_FILTERS = [
	{ name: 'CSS', extensions: ['css'] },
	{ name: 'All Files', extensions: ['*'] },
]

export const setWindowTitle = async name => {
	if (!isTauri()) return
	const { getCurrentWindow } = await import('@tauri-apps/api/window')
	getCurrentWindow().setTitle(name ? `markon — ${name}` : 'markon')
}

export const setCurrentFile = async file => {
	await setWindowTitle(file?.name ?? null)
}

export const saveAs = async (text, defaultName = 'document.md') => {
	if (!isTauri()) {
		const name = prompt('filename:', defaultName) || defaultName
		downloadText(name, text)
		return { path: null, name }
	}

	const { save } = await import('@tauri-apps/plugin-dialog')
	const { writeTextFile } = await import('@tauri-apps/plugin-fs')

	const path = await save({ defaultPath: defaultName, filters: MD_FILTERS })
	if (!path) return null

	await writeTextFile(path, text)
	return { path, name: basename(path) }
}

export const saveToPath = async (path, text) => {
	if (!isTauri() || !path) return false
	const { writeTextFile } = await import('@tauri-apps/plugin-fs')
	try {
		await writeTextFile(path, text)
		return true
	} catch (e) {
		console.warn('saveToPath failed', e)
		return false
	}
}

export const readFileAt = async path => {
	if (!isTauri() || !path) return null
	const { readTextFile } = await import('@tauri-apps/plugin-fs')
	try {
		return await readTextFile(path)
	} catch (e) {
		console.warn('readFileAt failed', e)
		return null
	}
}

export const openText = async () => {
	if (!isTauri()) {
		const text = await openFileText()
		return text == null ? null : { path: null, name: null, content: text }
	}

	const { open } = await import('@tauri-apps/plugin-dialog')
	const path = await open({ multiple: false, directory: false, filters: MD_FILTERS })
	if (!path) return null

	const content = await readFileAt(path)
	if (content == null) return null
	return { path, name: basename(path), content }
}

export const openFolder = async () => {
	if (!isTauri()) return null
	const { open } = await import('@tauri-apps/plugin-dialog')
	const path = await open({ multiple: false, directory: true })
	return path || null
}

// Watch a folder. Defaults to non-recursive — callers compose per-folder
// watchers when they want partial coverage. Returns an unwatch function
// (no-op in browser/PWA or when the watch fails).
export const watchPath = async (path, onChange, { recursive = false } = {}) => {
	if (!isTauri() || !path) return () => {}
	try {
		const { watch } = await import('@tauri-apps/plugin-fs')
		const stop = await watch(path, () => onChange(), { recursive, delayMs: 100 })
		return typeof stop === 'function' ? stop : () => {}
	} catch (e) {
		console.warn('watchPath failed', e)
		return () => {}
	}
}

export const readDirEntries = async path => {
	if (!isTauri() || !path) return []
	const { readDir, stat } = await import('@tauri-apps/plugin-fs')
	try {
		const entries = await readDir(path)
		const sep = path.includes('\\') ? '\\' : '/'
		// Stat each entry to get mtime — readDir() doesn't include it. We do this
		// for every entry so callers can sort/display by mtime without a second pass.
		// Fan out via Promise.all so a folder of N entries costs ~one round trip.
		return await Promise.all(
			entries.map(async e => {
				const fullPath = `${path}${sep}${e.name}`
				let mtimeMs = 0
				try {
					const s = await stat(fullPath)
					mtimeMs = s?.mtime ? s.mtime.getTime() : 0
				} catch {}
				return { name: e.name, path: fullPath, isDir: e.isDirectory, mtimeMs }
			}),
		)
	} catch (e) {
		console.warn('readDirEntries failed', e)
		return []
	}
}

export const openCSS = async () => {
	if (!isTauri()) {
		const text = await openFileCSS()
		return text == null ? null : { path: null, content: text }
	}

	const { open } = await import('@tauri-apps/plugin-dialog')
	const path = await open({ multiple: false, directory: false, filters: CSS_FILTERS })
	if (!path) return null
	const content = await readFileAt(path)
	if (content == null) return null
	return { path, content }
}

export const registerDropHandler = async onFile => {
	if (!isTauri()) {
		const onDragOver = e => e.preventDefault()
		const onDrop = async e => {
			e.preventDefault()
			const file = e.dataTransfer?.files?.[0]
			if (!file) return
			const content = await file.text()
			onFile({ path: null, name: file.name, content })
		}
		window.addEventListener('dragover', onDragOver)
		window.addEventListener('drop', onDrop)
		return
	}

	const { getCurrentWebview } = await import('@tauri-apps/api/webview')
	await getCurrentWebview().onDragDropEvent(async event => {
		if (event.payload.type !== 'drop') return
		const paths = event.payload.paths ?? []
		for (const path of paths) {
			const content = await readFileAt(path)
			if (content == null) continue
			onFile({ path, name: basename(path), content })
		}
	})
}

// Key prefix for the short-lived localStorage handoff between a source window
// and its spawned tear-off window. Tauri webviews share localStorage origin, so
// this is the simplest payload channel — no Tauri event timing/race to manage.
export const TEAROFF_PAYLOAD_PREFIX = 'markon-tearoff-payload__'

export const createTearoffWindow = async (doc, { x, y } = {}) => {
	if (!isTauri()) return false

	const windowId = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
	try {
		localStorage.setItem(TEAROFF_PAYLOAD_PREFIX + windowId, JSON.stringify(doc))
	} catch (e) {
		console.warn('tearoff payload write failed', e)
		return false
	}

	try {
		const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
		const label = `tearoff-${windowId}`
		// Relative URL — Tauri resolves this against the current webview's base
		// (devUrl in dev, frontendDist in prod).
		const url = `index.html?windowId=${encodeURIComponent(windowId)}`
		const opts = {
			url,
			title: `markon — ${doc.name ?? 'Untitled'}`,
			width: 900,
			height: 700,
			minWidth: 600,
			minHeight: 400,
		}
		if (Number.isFinite(x) && Number.isFinite(y)) {
			opts.x = Math.round(x)
			opts.y = Math.round(y)
		}
		new WebviewWindow(label, opts)
		return true
	} catch (e) {
		console.warn('createTearoffWindow failed', e)
		try {
			localStorage.removeItem(TEAROFF_PAYLOAD_PREFIX + windowId)
		} catch {}
		return false
	}
}

export const closeCurrentWindow = async () => {
	if (!isTauri()) {
		window.close()
		return
	}
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		// destroy() bypasses the closeRequested event so nothing can
		// accidentally intercept teardown — cleaner than wiring a custom
		// prevent-close flow. We only call this from tear-off windows that
		// have already confirmed their last tab was handed off elsewhere.
		await getCurrentWindow().destroy()
	} catch (e) {
		console.warn('closeCurrentWindow failed', e)
	}
}

export const focusCurrentWindow = async () => {
	if (!isTauri()) return
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		await getCurrentWindow().setFocus()
	} catch (e) {
		console.warn('focusCurrentWindow failed', e)
	}
}

export const getCurrentWindowLabel = async () => {
	if (!isTauri()) return null
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		return getCurrentWindow().label
	} catch {
		return null
	}
}

// Does the given physical-pixel screen point lie inside the current
// window's outer frame? Each window runs this against incoming tab
// offers to decide whether the drop was on itself.
export const isPointOverCurrentWindow = async ({ x, y }) => {
	if (!isTauri()) return false
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		const w = getCurrentWindow()
		const [pos, size] = await Promise.all([w.outerPosition(), w.outerSize()])
		return x >= pos.x && x < pos.x + size.width && y >= pos.y && y < pos.y + size.height
	} catch (e) {
		console.warn('isPointOverCurrentWindow failed', e)
		return false
	}
}

// Cross-window tab handoff: broadcast + targeted ACK, keyed by tab UUID.
//
// 1. Source broadcasts `markon://tab-offer` with the full doc, the source
//    window label, the tab id, and the drop point (physical px).
// 2. Every other window's offer listener checks if the drop point lies
//    over its own outer frame. If yes, it adopts the doc, then sends
//    `markon://tab-adopted` directly back to the source label.
// 3. Source has a per-tabId pending resolver; the ACK resolves it. Only
//    after the ACK does the source remove the tab locally (and close the
//    window if that emptied it). No ACK within the timeout = no taker,
//    fall back to spawning a new window.
const TAB_OFFER_EVENT = 'markon://tab-offer'
const TAB_ADOPTED_EVENT = 'markon://tab-adopted'

export const broadcastTabOffer = async payload => {
	if (!isTauri()) return false
	try {
		const { emit } = await import('@tauri-apps/api/event')
		await emit(TAB_OFFER_EVENT, payload)
		return true
	} catch (e) {
		console.warn('broadcastTabOffer failed', e)
		return false
	}
}

export const subscribeTabOffer = async onOffer => {
	if (!isTauri()) return () => {}
	try {
		const { listen } = await import('@tauri-apps/api/event')
		return await listen(TAB_OFFER_EVENT, ev => {
			if (ev?.payload) onOffer(ev.payload)
		})
	} catch (e) {
		console.warn('subscribeTabOffer failed', e)
		return () => {}
	}
}

export const confirmTabAdopted = async (sourceLabel, payload) => {
	if (!isTauri() || !sourceLabel) return
	try {
		const { emitTo } = await import('@tauri-apps/api/event')
		await emitTo(sourceLabel, TAB_ADOPTED_EVENT, payload)
	} catch (e) {
		console.warn('confirmTabAdopted failed', e)
	}
}

export const subscribeTabAdopted = async onAdopted => {
	if (!isTauri()) return () => {}
	try {
		const { listen } = await import('@tauri-apps/api/event')
		return await listen(TAB_ADOPTED_EVENT, ev => {
			if (ev?.payload) onAdopted(ev.payload)
		})
	} catch (e) {
		console.warn('subscribeTabAdopted failed', e)
		return () => {}
	}
}

export const getCliArgs = async () => {
	if (!isTauri()) return []
	try {
		const { getMatches } = await import('@tauri-apps/plugin-cli')
		const matches = await getMatches()
		const filesArg = matches?.args?.files?.value
		if (!filesArg) return []
		return Array.isArray(filesArg) ? filesArg : [filesArg]
	} catch (e) {
		console.warn('getCliArgs failed', e)
		return []
	}
}

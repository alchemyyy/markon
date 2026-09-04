import { resolveLocalReferencePath } from './link-targets.js'
import { downloadText, openFileCSS, openFileText } from './utils.js'

export const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const previewAssetScopeRequests = new Map()

const basename = path => (path ? path.split(/[\\/]/).pop() : null)

/** Resolves a local Markdown reference against the active document path. */
export const resolveLocalReference = async (reference, documentPath) => {
	if (!isTauri()) return null
	const pathAPI = await import('@tauri-apps/api/path')
	return await resolveLocalReferencePath(reference, documentPath, pathAPI)
}

/** Converts a local file path into an asset URL after granting that exact file access. */
export const convertPreviewAsset = async path => {
	if (!isTauri() || !path) return null

	let scopeRequest = previewAssetScopeRequests.get(path)
	if (!scopeRequest) {
		const { invoke } = await import('@tauri-apps/api/core')
		scopeRequest = invoke('allow_preview_asset', { path }).catch(error => {
			previewAssetScopeRequests.delete(path)
			throw error
		})
		previewAssetScopeRequests.set(path, scopeRequest)
	}
	await scopeRequest

	const { convertFileSrc } = await import('@tauri-apps/api/core')
	return convertFileSrc(path)
}

/** Opens a web URL in the system browser instead of replacing the editor webview. */
export const openExternalURL = async url => {
	if (!isTauri()) {
		window.open(url, '_blank', 'noopener')
		return
	}
	const { openUrl } = await import('@tauri-apps/plugin-opener')
	await openUrl(url)
}

/** Opens a non-Markdown local file with its system-default application. */
export const openPathExternally = async path => {
	if (!isTauri() || !path) return
	const { openPath } = await import('@tauri-apps/plugin-opener')
	await openPath(path)
}

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

// Spawns a new tear-off window. Returns its Tauri label on success, null
// on failure — callers (e.g. tabs.js) need the label so they can pipe
// cursor-position updates to the new window while it's loading.
export const createTearoffWindow = async (doc, { x, y, dragNow = false } = {}) => {
	if (!isTauri()) return null

	const windowId = `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
	try {
		localStorage.setItem(TEAROFF_PAYLOAD_PREFIX + windowId, JSON.stringify(doc))
	} catch (e) {
		console.warn('tearoff payload write failed', e)
		return null
	}

	try {
		const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
		const label = `tearoff-${windowId}`
		// Relative URL — Tauri resolves this against the current webview's base
		// (devUrl in dev, frontendDist in prod). dragNow tells the spawning
		// window to call startDragging() as early as possible so the OS
		// picks up the in-flight mouse drag (Chrome-style tear-off).
		const qs = new URLSearchParams({ windowId })
		if (dragNow) qs.set('dragNow', '1')
		const url = `index.html?${qs}`
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
		return label
	} catch (e) {
		console.warn('createTearoffWindow failed', e)
		try {
			localStorage.removeItem(TEAROFF_PAYLOAD_PREFIX + windowId)
		} catch {}
		return null
	}
}

// Hand the current mouse drag off to the OS's native window drag. Must be
// called while the user's mouse button is still held down — on Windows
// this posts WM_NCLBUTTONDOWN(HTCAPTION) which only enters the modal drag
// loop if the button is pressed. Used for Chrome-style tab tear-off.
export const startNativeWindowDrag = async () => {
	if (!isTauri()) return
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		await getCurrentWindow().startDragging()
	} catch (e) {
		console.warn('startNativeWindowDrag failed', e)
	}
}

// Atomically snap the current window to the cursor's current screen
// position AND initiate the OS's native window drag. The cursor coords
// come from the OS inside the Rust command (not passed through JS) so
// there's no IPC drift — the position is queried microseconds before
// start_dragging fires, in the same Rust function.
export const snapAndDrag = async () => {
	if (!isTauri()) return
	try {
		const { invoke } = await import('@tauri-apps/api/core')
		await invoke('snap_and_drag')
	} catch (e) {
		console.warn('snapAndDrag failed', e)
	}
}

// Move the current window to the given logical (CSS-pixel) screen position.
// Used right before startDragging to snap a just-spawned tear-off window
// under the user's current cursor (they kept moving while we were loading).
export const setCurrentWindowPosition = async ({ x, y }) => {
	if (!isTauri()) return
	try {
		const { getCurrentWindow, LogicalPosition } = await import('@tauri-apps/api/window')
		await getCurrentWindow().setPosition(new LogicalPosition(Math.round(x), Math.round(y)))
	} catch (e) {
		console.warn('setCurrentWindowPosition failed', e)
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

// Fetches the current window's content-area top-left in physical pixels.
// Authoritative source for mapping DOM rects to screen coordinates —
// unlike `window.screenX`, Tauri's innerPosition is consistent across
// platforms (window.screenX on Windows WebView2 sometimes returns the
// outer-frame left, which shifts DOM-derived rects up by the title bar).
export const getCurrentInnerPosition = async () => {
	if (!isTauri()) return null
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		return await getCurrentWindow().innerPosition()
	} catch (e) {
		console.warn('getCurrentInnerPosition failed', e)
		return null
	}
}

// Subscribe to window moved/resized so callers can keep a cached
// innerPosition in sync without polling. Returns an unlisten function.
export const onWindowGeometryChange = async onChange => {
	if (!isTauri()) return () => {}
	try {
		const { getCurrentWindow } = await import('@tauri-apps/api/window')
		const w = getCurrentWindow()
		const offMoved = await w.onMoved(onChange)
		const offResized = await w.onResized(onChange)
		return () => {
			offMoved?.()
			offResized?.()
		}
	} catch (e) {
		console.warn('onWindowGeometryChange failed', e)
		return () => {}
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

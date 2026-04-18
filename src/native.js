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

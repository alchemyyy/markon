import { openFolder, readDirEntries, watchPath } from './native.js'
import { createElement } from './utils.js'

const MD_EXTS = new Set(['md', 'markdown', 'mdown', 'mkd', 'txt'])

const extOf = name => {
	const i = name.lastIndexOf('.')
	return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

const isMarkdownFile = name => MD_EXTS.has(extOf(name))

const basename = p => (p ? p.split(/[\\/]/).pop() : '')

const TREE_W_KEY = 'markon-tree-w'
const TREE_W_DEFAULT = 240
const TREE_W_MIN = 140
const TREE_W_MAX = 600

const readSavedWidth = () => {
	const raw = Number.parseInt(localStorage.getItem(TREE_W_KEY) ?? '', 10)
	return Number.isFinite(raw) ? Math.min(TREE_W_MAX, Math.max(TREE_W_MIN, raw)) : TREE_W_DEFAULT
}

export const createFileTree = ({ docs, container, showToast }) => {
	const panel = createElement('div', { id: 'tree-panel' })
	const header = createElement('div', { className: 'tree-header' })
	const title = createElement('span', { className: 'tree-title', textContent: '' })

	const refreshBtn = createElement('button', { className: 'tree-header-btn', title: 'Refresh' })
	refreshBtn.innerHTML = '<iconify-icon icon="tabler:refresh" width="16"></iconify-icon>'

	const closeBtn = createElement('button', { className: 'tree-header-btn', title: 'Close folder' })
	closeBtn.innerHTML = '<iconify-icon icon="tabler:x" width="16"></iconify-icon>'

	const actions = createElement('div', { className: 'tree-header-actions' })
	actions.append(refreshBtn, closeBtn)
	header.append(title, actions)

	const list = createElement('div', { className: 'tree-list' })
	const resizeHandle = createElement('div', { className: 'tree-resize-handle', title: 'Drag to resize' })
	panel.append(header, list, resizeHandle)
	container.appendChild(panel)

	let rootPath = null
	let currentWidth = readSavedWidth()
	let watchDebounce = null
	const expanded = new Set() // paths currently expanded
	const watchers = new Map() // path -> stop fn (one per expanded folder, non-recursive)

	const scheduleRebuild = () => {
		clearTimeout(watchDebounce)
		watchDebounce = setTimeout(() => {
			if (rootPath) rebuild()
		}, 250)
	}

	const isDescendantPath = (parent, child) =>
		child === parent || child.startsWith(`${parent}/`) || child.startsWith(`${parent}\\`)

	const watchFolder = async path => {
		if (watchers.has(path)) return
		const expectedRoot = rootPath
		const stop = await watchPath(path, scheduleRebuild) // non-recursive
		// guard against close()/open() racing the await
		if (rootPath !== expectedRoot || !expanded.has(path)) {
			try {
				stop()
			} catch {}
			return
		}
		watchers.set(path, stop)
	}

	const unwatchFolder = path => {
		const stop = watchers.get(path)
		if (!stop) return
		try {
			stop()
		} catch {}
		watchers.delete(path)
	}

	const stopAllWatchers = () => {
		for (const stop of watchers.values()) {
			try {
				stop()
			} catch {}
		}
		watchers.clear()
		clearTimeout(watchDebounce)
		watchDebounce = null
	}

	// Collapse a folder: remove it and any descendants from `expanded`,
	// and tear down their watchers.
	const collapseFolder = path => {
		for (const exp of [...expanded]) {
			if (isDescendantPath(path, exp)) {
				expanded.delete(exp)
				unwatchFolder(exp)
			}
		}
	}

	// Expand a folder: add to `expanded`, start its watcher. The subsequent
	// rebuild() re-reads the directory contents (refresh-on-expand).
	const expandFolder = async path => {
		expanded.add(path)
		await watchFolder(path)
	}

	const applyWidth = w => {
		currentWidth = Math.min(TREE_W_MAX, Math.max(TREE_W_MIN, Math.round(w)))
		document.documentElement.style.setProperty('--tree-w', `${currentWidth}px`)
	}

	const setOpen = shouldShow => {
		document.documentElement.classList.toggle('tree-open', shouldShow)
		if (shouldShow) {
			applyWidth(currentWidth) // re-assert inline width whenever we open
		} else {
			document.documentElement.style.removeProperty('--tree-w')
		}
	}

	resizeHandle.addEventListener('pointerdown', e => {
		e.preventDefault()
		const startX = e.clientX
		const startW = currentWidth
		resizeHandle.setPointerCapture(e.pointerId)
		resizeHandle.classList.add('active')
		document.body.style.cursor = 'col-resize'

		const onMove = ev => applyWidth(startW + (ev.clientX - startX))
		const onUp = () => {
			resizeHandle.removeEventListener('pointermove', onMove)
			resizeHandle.removeEventListener('pointerup', onUp)
			resizeHandle.removeEventListener('pointercancel', onUp)
			resizeHandle.classList.remove('active')
			document.body.style.cursor = ''
			try {
				localStorage.setItem(TREE_W_KEY, String(currentWidth))
			} catch {}
		}
		resizeHandle.addEventListener('pointermove', onMove)
		resizeHandle.addEventListener('pointerup', onUp)
		resizeHandle.addEventListener('pointercancel', onUp)
	})

	const close = () => {
		stopAllWatchers()
		rootPath = null
		expanded.clear()
		list.replaceChildren()
		title.textContent = ''
		setOpen(false)
		try {
			localStorage.removeItem('markon-folder')
		} catch {}
	}

	const renderRow = (entry, depth) => {
		const row = createElement('div', { className: 'tree-row' + (entry.isDir ? ' dir' : ' file') })
		row.style.paddingLeft = `${8 + depth * 14}px`
		row.dataset.path = entry.path

		const chevron = createElement('span', { className: 'tree-chevron' })
		if (entry.isDir) {
			chevron.innerHTML = `<iconify-icon icon="${expanded.has(entry.path) ? 'tabler:chevron-down' : 'tabler:chevron-right'}" width="14"></iconify-icon>`
		} else {
			chevron.innerHTML = '<span class="tree-chevron-spacer"></span>'
		}

		const icon = createElement('span', { className: 'tree-icon' })
		if (entry.isDir) {
			icon.innerHTML = `<iconify-icon icon="${expanded.has(entry.path) ? 'tabler:folder-open' : 'tabler:folder'}" width="14"></iconify-icon>`
		} else {
			icon.innerHTML = `<iconify-icon icon="${isMarkdownFile(entry.name) ? 'tabler:file-text' : 'tabler:file'}" width="14"></iconify-icon>`
		}

		const name = createElement('span', { className: 'tree-name', textContent: entry.name })
		row.append(chevron, icon, name)

		if (!entry.isDir) {
			// Mark by dirty/active against current docs state
			const tabs = docs.list()
			const match = tabs.find(t => t.path === entry.path)
			if (match) {
				row.classList.add('is-open')
				if (docs.isDirty(match)) row.classList.add('is-dirty')
			}
		}

		row.addEventListener('click', async () => {
			if (entry.isDir) {
				if (expanded.has(entry.path)) collapseFolder(entry.path)
				else await expandFolder(entry.path)
				await rebuild()
			} else {
				const doc = await docs.openPath(entry.path)
				if (doc) showToast?.(`opened ${entry.name}`, 1000, 'tabler:check')
			}
		})

		return row
	}

	const walk = async (dirPath, depth, out) => {
		const entries = await readDirEntries(dirPath)
		for (const entry of entries) {
			out.push(renderRow(entry, depth))
			if (entry.isDir && expanded.has(entry.path)) {
				await walk(entry.path, depth + 1, out)
			}
		}
	}

	const rebuild = async () => {
		if (!rootPath) return
		const rows = []
		await walk(rootPath, 0, rows)
		list.replaceChildren(...rows)
	}

	const open = async path => {
		stopAllWatchers()
		rootPath = path
		expanded.clear()
		expanded.add(path) // show root contents initially
		title.textContent = basename(path)
		title.title = path
		setOpen(true)
		try {
			localStorage.setItem('markon-folder', path)
		} catch {}
		await rebuild()
		await watchFolder(path) // watch the root only; subdirs get watched as they're expanded
	}

	const openPicker = async () => {
		const path = await openFolder()
		if (path) await open(path)
	}

	refreshBtn.addEventListener('click', rebuild)
	closeBtn.addEventListener('click', close)

	// Re-render when doc state changes (active/dirty indicators)
	docs.onChange(() => {
		if (rootPath) rebuild()
	})

	return { open, close, openPicker, rebuild }
}

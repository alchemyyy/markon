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

const TREE_TIMES_KEY = 'markon-tree-show-times'
const readSavedShowTimes = () => localStorage.getItem(TREE_TIMES_KEY) !== 'false' // default true

const TREE_SORT_KEY = 'markon-tree-sort'
const SORT_NAME = 'name'
const SORT_MTIME = 'mtime'
const SORT_MODES = [
	{ id: SORT_NAME, label: 'Name' },
	{ id: SORT_MTIME, label: 'Date modified' },
]

const readSavedSort = () => {
	const raw = localStorage.getItem(TREE_SORT_KEY)
	return raw === SORT_MTIME ? SORT_MTIME : SORT_NAME
}

// Format a millisecond age into a fixed-width compact stamp.
// Secondary unit is always 2-digit zero-padded; once the primary unit
// reaches two digits we drop the secondary entirely.
//   <1h        "XXm"     e.g. "09m", "55m"
//   1h–9h59m   "Xh" / "XhYY"  e.g. "1h", "1h09", "9h55"
//   10h–23h    "XXh"     e.g. "10h", "23h"
//   1d–9d23h   "Xd" / "XdYY"  e.g. "1d", "1d10", "9d23"
//   ≥10d       "XXd"     e.g. "10d", "50d"
const pad2 = n => n.toString().padStart(2, '0')
// Use NBSP for left-padding so the spaces survive HTML collapsing and
// every timestamp occupies at least 4 character cells (e.g. "1h" -> "  1h").
const NBSP = '\u00A0'
const padTo4 = s => (s.length < 4 ? NBSP.repeat(4 - s.length) + s : s)
const fmtAge = ms => {
	if (!ms || ms < 0) return ''
	const min = Math.floor(ms / 60000)
	let base
	if (min < 60) base = `${pad2(Math.max(0, min))}m`
	else {
		const h = Math.floor(min / 60)
		const m = min % 60
		if (h < 10) base = m === 0 ? `${h}h` : `${h}h${pad2(m)}`
		else if (h < 24) base = `${h}h`
		else {
			const d = Math.floor(h / 24)
			const remH = h % 24
			if (d < 10) base = remH === 0 ? `${d}d` : `${d}d${pad2(remH)}`
			else base = `${d}d`
		}
	}
	return padTo4(base)
}

const sortEntries = (entries, mode) => {
	const cmp =
		mode === SORT_MTIME
			? (a, b) => {
					if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
					return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) // most recent first
				}
			: (a, b) => {
					if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
					return a.name.localeCompare(b.name)
				}
	return [...entries].sort(cmp)
}

const readSavedWidth = () => {
	const raw = Number.parseInt(localStorage.getItem(TREE_W_KEY) ?? '', 10)
	return Number.isFinite(raw) ? Math.min(TREE_W_MAX, Math.max(TREE_W_MIN, raw)) : TREE_W_DEFAULT
}

export const createFileTree = ({ docs, container, showToast }) => {
	const panel = createElement('div', { id: 'tree-panel' })
	const header = createElement('div', { className: 'tree-header' })
	const title = createElement('span', { className: 'tree-title', textContent: '' })

	const timesBtn = createElement('button', { className: 'tree-header-btn' })
	timesBtn.innerHTML = '<iconify-icon icon="tabler:clock" width="16"></iconify-icon>'
	const sortBtn = createElement('button', { className: 'tree-header-btn', title: 'Sort' })
	sortBtn.innerHTML = '<iconify-icon icon="tabler:arrows-sort" width="16"></iconify-icon>'
	const refreshBtn = createElement('button', { className: 'tree-header-btn', title: 'Refresh' })
	refreshBtn.innerHTML = '<iconify-icon icon="tabler:refresh" width="16"></iconify-icon>'

	const closeBtn = createElement('button', { className: 'tree-header-btn', title: 'Close folder' })
	closeBtn.innerHTML = '<iconify-icon icon="tabler:x" width="16"></iconify-icon>'

	const actions = createElement('div', { className: 'tree-header-actions' })
	actions.append(timesBtn, sortBtn, refreshBtn, closeBtn)
	header.append(title, actions)

	const list = createElement('div', { className: 'tree-list' })
	const resizeHandle = createElement('div', { className: 'tree-resize-handle', title: 'Drag to resize' })
	panel.append(header, list, resizeHandle)
	container.appendChild(panel)

	let rootPath = null
	let currentWidth = readSavedWidth()
	let currentSort = readSavedSort()
	let showTimes = readSavedShowTimes()
	let watchDebounce = null
	const expanded = new Set() // paths currently expanded
	const watchers = new Map() // path -> stop fn (one per expanded folder, non-recursive)

	const renderTimesBtn = () => {
		timesBtn.title = showTimes ? 'Hide modification times' : 'Show modification times'
		timesBtn.classList.toggle('off', !showTimes)
	}
	renderTimesBtn()
	timesBtn.addEventListener('click', () => {
		showTimes = !showTimes
		try {
			localStorage.setItem(TREE_TIMES_KEY, String(showTimes))
		} catch {}
		renderTimesBtn()
		if (rootPath) rebuild()
	})

	// Sort mode popup menu (one-of-N selector anchored under the sort button).
	const sortMenu = createElement('div', { className: 'tree-sort-menu', hidden: true })
	document.body.appendChild(sortMenu)

	const renderSortMenu = () => {
		sortMenu.replaceChildren()
		for (const { id, label } of SORT_MODES) {
			const item = createElement('button', {
				className: `tree-sort-item${id === currentSort ? ' selected' : ''}`,
				textContent: label,
			})
			item.addEventListener('click', () => {
				currentSort = id
				try {
					localStorage.setItem(TREE_SORT_KEY, currentSort)
				} catch {}
				hideSortMenu()
				if (rootPath) rebuild()
			})
			sortMenu.appendChild(item)
		}
	}

	const showSortMenu = () => {
		renderSortMenu()
		sortMenu.hidden = false
		const rect = sortBtn.getBoundingClientRect()
		sortMenu.style.top = `${rect.bottom + 4}px`
		sortMenu.style.left = `${rect.left}px`
	}
	const hideSortMenu = () => {
		sortMenu.hidden = true
	}

	sortBtn.addEventListener('click', e => {
		e.stopPropagation()
		if (sortMenu.hidden) showSortMenu()
		else hideSortMenu()
	})

	document.addEventListener('click', e => {
		if (sortMenu.hidden) return
		if (sortMenu.contains(e.target)) return
		if (e.target === sortBtn || sortBtn.contains(e.target)) return
		hideSortMenu()
	})

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

		// Single leading slot shared by:
		//   - dirs: their expand/collapse chevron
		//   - files: a compact age stamp (or the dirty ● if unsaved)
		const leading = createElement('span', { className: 'tree-leading' })
		if (entry.isDir) {
			leading.innerHTML = `<iconify-icon icon="${expanded.has(entry.path) ? 'tabler:chevron-down' : 'tabler:chevron-right'}" width="14"></iconify-icon>`
		} else if (entry.mtimeMs && showTimes) {
			leading.textContent = fmtAge(Date.now() - entry.mtimeMs)
		}

		const icon = createElement('span', { className: 'tree-icon' })
		if (entry.isDir) {
			icon.innerHTML = `<iconify-icon icon="${expanded.has(entry.path) ? 'tabler:folder-open' : 'tabler:folder'}" width="14"></iconify-icon>`
		} else {
			icon.innerHTML = `<iconify-icon icon="${isMarkdownFile(entry.name) ? 'tabler:file-text' : 'tabler:file'}" width="14"></iconify-icon>`
		}

		const name = createElement('span', { className: 'tree-name', textContent: entry.name })
		row.append(leading, icon, name)

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
		const entries = sortEntries(await readDirEntries(dirPath), currentSort)
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

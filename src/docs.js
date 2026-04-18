import { confirmCloseFile } from './confirm-close.js'
import { openText, readFileAt, saveAs, saveToPath, setCurrentFile } from './native.js'
import { addRecent } from './recent.js'

const STORAGE_KEY = 'markon-tabs-v1'
const LEGACY_DB_NAME = 'markon-storage'
const LEGACY_STORE = 'content'
const LEGACY_KEY = 'markon-content'
const PERSIST_DEBOUNCE_MS = 600

const loadLegacyIndexedDB = () =>
	new Promise(resolve => {
		try {
			const req = indexedDB.open(LEGACY_DB_NAME, 1)
			req.onerror = () => resolve(null)
			req.onsuccess = () => {
				try {
					const db = req.result
					if (!db.objectStoreNames.contains(LEGACY_STORE)) {
						resolve(null)
						return
					}
					const tx = db.transaction([LEGACY_STORE], 'readonly')
					const getReq = tx.objectStore(LEGACY_STORE).get(LEGACY_KEY)
					getReq.onsuccess = () => resolve(getReq.result ?? null)
					getReq.onerror = () => resolve(null)
				} catch {
					resolve(null)
				}
			}
		} catch {
			resolve(null)
		}
	})

const uuid = () => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

const basename = p => (p ? p.split(/[\\/]/).pop() : null)

const createDoc = ({ id = uuid(), path = null, name = null, content = '', savedContent = '' } = {}) => ({
	id,
	path,
	name: name ?? (path ? basename(path) : 'Untitled'),
	content,
	savedContent,
})

const isDirty = doc => doc.content !== doc.savedContent

export const createDocsStore = ({ editor, showToast, onActiveChange }) => {
	let tabs = []
	let activeId = null
	let suppressEditorSync = false
	let persistTimer = null
	const subscribers = []
	const dirtyIds = new Set()

	const getActive = () => tabs.find(t => t.id === activeId) ?? null

	const recomputeDirty = () => {
		dirtyIds.clear()
		for (const t of tabs) if (isDirty(t)) dirtyIds.add(t.id)
	}

	const notify = () => {
		for (const fn of subscribers) fn({ tabs: [...tabs], activeId })
		schedulePersist()
	}

	const persistNow = () => {
		clearTimeout(persistTimer)
		persistTimer = null
		try {
			const snapshot = { tabs: tabs.map(t => ({ ...t })), activeId }
			localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
		} catch (e) {
			console.warn('persist failed', e)
		}
	}

	const schedulePersist = () => {
		clearTimeout(persistTimer)
		persistTimer = setTimeout(persistNow, PERSIST_DEBOUNCE_MS)
	}

	window.addEventListener('beforeunload', persistNow)
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'hidden') persistNow()
	})

	const switchTo = id => {
		const doc = tabs.find(t => t.id === id)
		if (!doc) return
		activeId = id
		suppressEditorSync = true
		editor.setContent(doc.content)
		suppressEditorSync = false
		setCurrentFile(doc.path ? { path: doc.path, name: doc.name } : null)
		if (onActiveChange) onActiveChange(doc)
		notify()
	}

	const add = doc => {
		tabs.push(doc)
		switchTo(doc.id)
	}

	const openPath = async (path, { silent = false } = {}) => {
		const existing = tabs.find(t => t.path === path)
		if (existing) {
			switchTo(existing.id)
			return existing
		}
		const content = await readFileAt(path)
		if (content == null) {
			if (!silent) showToast?.('could not read file', 1200, 'tabler:alert-circle')
			return null
		}
		const doc = createDoc({ path, content, savedContent: content })
		add(doc)
		addRecent(path)
		return doc
	}

	const openViaDialog = async () => {
		const file = await openText()
		if (!file) return null
		if (file.path) return openPath(file.path)
		// Browser fallback — untitled tab seeded with content
		const doc = createDoc({ content: file.content ?? '', savedContent: file.content ?? '' })
		add(doc)
		return doc
	}

	const newUntitled = () => {
		const doc = createDoc({ content: '', savedContent: '' })
		add(doc)
		return doc
	}

	const close = async id => {
		const idx = tabs.findIndex(t => t.id === id)
		if (idx < 0) return
		const doc = tabs[idx]
		if (isDirty(doc)) {
			const choice = await confirmCloseFile(doc.name)
			if (choice === 'cancel') return
			if (choice === 'save') {
				const saved = await save(doc.id)
				if (!saved) return // save failed or user cancelled the Save-As dialog
			}
			// 'discard' → fall through and close without saving
		}
		// Re-find the index in case state shifted while awaiting the dialog/save.
		const finalIdx = tabs.findIndex(t => t.id === id)
		if (finalIdx < 0) return
		tabs.splice(finalIdx, 1)
		dirtyIds.delete(id)

		if (tabs.length === 0) {
			// Never leave zero tabs — seed a fresh Untitled.
			newUntitled()
			return
		}

		if (activeId === id) {
			const next = tabs[finalIdx] ?? tabs[finalIdx - 1]
			switchTo(next.id)
		} else {
			notify()
		}
	}

	const updateActiveContent = content => {
		if (suppressEditorSync) return
		const doc = getActive()
		if (!doc) return
		doc.content = content
		const dirtyNow = isDirty(doc)
		const dirtyBefore = dirtyIds.has(doc.id)
		if (dirtyNow !== dirtyBefore) {
			if (dirtyNow) dirtyIds.add(doc.id)
			else dirtyIds.delete(doc.id)
			notify() // dirty flipped → UI needs update
		} else {
			schedulePersist() // content changed, but UI dirty badge is already correct
		}
	}

	const markSaved = (id, { path, content } = {}) => {
		const doc = tabs.find(t => t.id === id)
		if (!doc) return
		if (path) {
			doc.path = path
			doc.name = basename(path)
		}
		doc.savedContent = content ?? doc.content
		dirtyIds.delete(doc.id)
		if (doc.id === activeId && doc.path) {
			setCurrentFile({ path: doc.path, name: doc.name })
		}
		notify()
	}

	const save = async id => {
		const doc = tabs.find(t => t.id === id) ?? getActive()
		if (!doc) return null
		if (!doc.path) return saveAsDoc(doc.id)
		const ok = await saveToPath(doc.path, doc.content)
		if (!ok) return null
		markSaved(doc.id, { content: doc.content })
		addRecent(doc.path)
		return doc
	}

	const saveAsDoc = async id => {
		const doc = tabs.find(t => t.id === id) ?? getActive()
		if (!doc) return null
		const result = await saveAs(doc.content, doc.name ?? 'document.md')
		if (!result) return null
		markSaved(doc.id, { path: result.path, content: doc.content })
		if (result.path) addRecent(result.path)
		return doc
	}

	const saveAll = async () => {
		const dirty = tabs.filter(isDirty)
		if (!dirty.length) {
			showToast?.('nothing to save', 1200, 'tabler:check')
			return 0
		}
		let saved = 0
		for (const doc of dirty) {
			const res = await save(doc.id)
			if (res) saved++
		}
		showToast?.(`saved ${saved}/${dirty.length}`, 1200, 'tabler:check')
		return saved
	}

	const reorder = (fromIdx, toIdx) => {
		if (fromIdx === toIdx) return
		const [moved] = tabs.splice(fromIdx, 1)
		tabs.splice(toIdx, 0, moved)
		notify()
	}

	const onChange = fn => {
		subscribers.push(fn)
		fn({ tabs: [...tabs], activeId })
		return () => {
			const i = subscribers.indexOf(fn)
			if (i >= 0) subscribers.splice(i, 1)
		}
	}

	const list = () => [...tabs]

	// Boot: restore persisted tabs, or migrate legacy single-doc storage
	const boot = async () => {
		let raw = null
		try {
			raw = localStorage.getItem(STORAGE_KEY)
		} catch {}

		if (raw) {
			try {
				const { tabs: savedTabs, activeId: savedActive } = JSON.parse(raw)
				if (Array.isArray(savedTabs) && savedTabs.length) {
					tabs = savedTabs
					recomputeDirty()
					const activeExists = savedTabs.some(t => t.id === savedActive)
					switchTo(activeExists ? savedActive : savedTabs[0].id)
					return
				}
			} catch (e) {
				console.warn('bad saved tabs, ignoring', e)
			}
		}

		// Nothing persisted — try legacy IndexedDB (pre-tabs storage), else current editor content.
		const legacy = await loadLegacyIndexedDB()
		const seedContent = legacy ?? editor.getContent()
		const doc = createDoc({ content: seedContent, savedContent: seedContent })
		tabs = [doc]
		switchTo(doc.id)
	}

	// Wire editor changes → active doc
	editor.onContentChange(content => updateActiveContent(content))

	return {
		boot,
		getActive,
		list,
		openPath,
		openViaDialog,
		newUntitled,
		switchTo,
		close,
		save,
		saveAs: saveAsDoc,
		saveAll,
		reorder,
		onChange,
		isDirty,
	}
}

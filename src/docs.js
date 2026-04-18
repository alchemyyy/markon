import { confirmCloseFile } from './confirm-close.js'
import {
	broadcastTabOffer,
	closeCurrentWindow,
	confirmTabAdopted,
	createTearoffWindow,
	focusCurrentWindow,
	getCurrentWindowLabel,
	isPointOverCurrentWindow,
	openText,
	readFileAt,
	saveAs,
	saveToPath,
	setCurrentFile,
	subscribeTabAdopted,
	subscribeTabOffer,
	TEAROFF_PAYLOAD_PREFIX,
} from './native.js'
import { addRecent } from './recent.js'

const BASE_STORAGE_KEY = 'markon-tabs-v1'
const LEGACY_DB_NAME = 'markon-storage'
const LEGACY_STORE = 'content'
const LEGACY_KEY = 'markon-content'
const PERSIST_DEBOUNCE_MS = 600

// Each window maintains its own tab list. The main window keeps the original
// `markon-tabs-v1` key for backwards compatibility; tear-off windows namespace
// under `...__<windowId>` so concurrent windows don't clobber each other.
const getWindowId = () => {
	try {
		return new URLSearchParams(location.search).get('windowId')
	} catch {
		return null
	}
}

const STORAGE_KEY = (() => {
	const id = getWindowId()
	return id ? `${BASE_STORAGE_KEY}__${id}` : BASE_STORAGE_KEY
})()

const IS_TEAROFF_WINDOW = !!getWindowId()

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

	// Cross-window IPC state. currentLabel is resolved once at init; pending
	// acks map a tab UUID → resolver callback so multiple tearOff() calls
	// can be in flight simultaneously without clobbering each other's acks.
	let currentLabel = null
	const pendingAcks = new Map()
	const ADOPT_ACK_TIMEOUT_MS = 300

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
			// Tear-off windows mirror Chrome — closing the last tab closes the window.
			// Main window keeps the original invariant: seed a fresh Untitled.
			if (IS_TEAROFF_WINDOW) {
				try {
					localStorage.removeItem(STORAGE_KEY)
				} catch {}
				closeCurrentWindow()
				return
			}
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

	// Remove a doc from the local tab list without any confirmation.
	// Caller is responsible for already having persisted it elsewhere.
	const detachLocal = id => {
		const idx = tabs.findIndex(t => t.id === id)
		if (idx < 0) return
		tabs.splice(idx, 1)
		dirtyIds.delete(id)
		if (tabs.length === 0) {
			// Closing the tab left this window empty — mirror the close()
			// behavior: tear-off windows close, main window seeds Untitled.
			if (IS_TEAROFF_WINDOW) {
				try {
					localStorage.removeItem(STORAGE_KEY)
				} catch {}
				closeCurrentWindow()
				return
			}
			newUntitled()
			return
		}
		if (activeId === id) {
			const next = tabs[idx] ?? tabs[idx - 1]
			if (next) switchTo(next.id)
			else notify()
		} else {
			notify()
		}
	}

	// Accept a doc handed off from another window via the cross-window
	// tab-transfer channel. Deduplicates by path (same behavior as openPath).
	const adopt = payload => {
		if (!payload || typeof payload !== 'object') return
		if (payload.path) {
			const existing = tabs.find(t => t.path === payload.path)
			if (existing) {
				switchTo(existing.id)
				focusCurrentWindow()
				return
			}
		}
		const doc = createDoc(payload)
		tabs.push(doc)
		if (isDirty(doc)) dirtyIds.add(doc.id)
		switchTo(doc.id)
		focusCurrentWindow()
	}

	// Detach a doc from this window. Protocol:
	//   1. Broadcast `tab-offer` with the tab UUID, full doc, source label,
	//      and drop point (physical px).
	//   2. Every other window checks its own outer frame; the one the drop
	//      landed on adopts the doc and emits `tab-adopted` back.
	//   3. On ACK (within ADOPT_ACK_TIMEOUT_MS), remove the tab locally; if
	//      that emptied the source and we're a tear-off window, close.
	//   4. No ACK = no taker, spawn a fresh window seeded with the doc
	//      (unless that'd leave us empty — main/tear-off both bounce).
	//
	// Returns true if the tear-off was handled; false leaves the tab in place.
	const tearOff = async (id, dropAt) => {
		const idx = tabs.findIndex(t => t.id === id)
		if (idx < 0) return false

		const payload = { ...tabs[idx] }
		const hasDropAt = dropAt && Number.isFinite(dropAt.x) && Number.isFinite(dropAt.y)

		if (hasDropAt && currentLabel) {
			const adopted = await new Promise(resolve => {
				const timer = setTimeout(() => {
					pendingAcks.delete(id)
					resolve(false)
				}, ADOPT_ACK_TIMEOUT_MS)
				pendingAcks.set(id, () => {
					clearTimeout(timer)
					resolve(true)
				})
				broadcastTabOffer({
					tabId: id,
					doc: payload,
					sourceLabel: currentLabel,
					dropX: dropAt.x,
					dropY: dropAt.y,
				})
			})
			if (adopted) {
				detachLocal(id)
				return true
			}
		}

		// No other window claimed the drop — fall back to a new window. Skip
		// when that'd leave the source empty (main repopulates Untitled,
		// tear-off self-replaces, neither is useful).
		if (tabs.length === 1) return false
		// Nudge the new window up-left of the cursor so the title bar lands
		// near the drop point rather than under it.
		const spawnAt = hasDropAt ? { x: dropAt.x - 60, y: dropAt.y - 20 } : {}
		const spawned = await createTearoffWindow(payload, spawnAt)
		if (!spawned) return false
		detachLocal(id)
		return true
	}

	// Cross-window IPC wiring. Resolves the current window label, then
	// listens for offers (to adopt) and acks (to unblock tearOff waiters).
	;(async () => {
		currentLabel = await getCurrentWindowLabel()

		subscribeTabOffer(async offer => {
			if (!offer || !offer.doc) return
			// Skip our own broadcast echo.
			if (offer.sourceLabel && offer.sourceLabel === currentLabel) return
			const over = await isPointOverCurrentWindow({ x: offer.dropX, y: offer.dropY })
			if (!over) return
			adopt(offer.doc)
			if (offer.sourceLabel) {
				confirmTabAdopted(offer.sourceLabel, { tabId: offer.tabId, targetLabel: currentLabel })
			}
		})

		subscribeTabAdopted(ack => {
			if (!ack?.tabId) return
			const resolver = pendingAcks.get(ack.tabId)
			if (!resolver) return
			pendingAcks.delete(ack.tabId)
			resolver()
		})
	})()

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
		// Tear-off windows: if there's a pending handoff payload for this window
		// id, seed with that doc. The payload is a one-shot — remove it so a
		// reload of this window falls through to normal persisted-tabs restore.
		if (IS_TEAROFF_WINDOW) {
			const id = getWindowId()
			const payloadKey = TEAROFF_PAYLOAD_PREFIX + id
			let payload = null
			try {
				const raw = localStorage.getItem(payloadKey)
				if (raw) {
					payload = JSON.parse(raw)
					localStorage.removeItem(payloadKey)
				}
			} catch (e) {
				console.warn('bad tearoff payload, ignoring', e)
			}
			if (payload) {
				const doc = createDoc(payload)
				tabs = [doc]
				recomputeDirty()
				switchTo(doc.id)
				return
			}
		}

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
		tearOff,
		onChange,
		isDirty,
		isTearoffWindow: () => IS_TEAROFF_WINDOW,
	}
}

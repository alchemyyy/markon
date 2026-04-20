import { confirmCloseFile } from './confirm-close.js'
import {
	broadcastTabOffer,
	closeCurrentWindow,
	confirmTabAdopted,
	createTearoffWindow,
	focusCurrentWindow,
	getCurrentInnerPosition,
	getCurrentWindowLabel,
	onWindowGeometryChange,
	openText,
	readFileAt,
	saveAs,
	saveToPath,
	setCurrentFile,
	startNativeWindowDrag,
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

	// Cross-window IPC state. currentLabel is the Tauri window label; used
	// to tag outgoing offers (so our own listener can ignore echoes) and
	// as the target for adopt-ACKs coming back from other windows.
	// pendingAcks maps tabId → resolver callback so multiple in-flight
	// dock offers can coexist without clobbering each other's resolution.
	// cachedInnerPos is the content-area top-left in physical pixels,
	// refreshed on window move/resize so the tab-bar hit-test can resolve
	// incoming offers synchronously.
	let currentLabel = null
	let cachedInnerPos = null
	const pendingAcks = new Map()
	// Fired when a tab is adopted into this window via the dock channel.
	// The tab bar subscribes to this to continue the user's in-flight mouse
	// drag on the newly-inserted tab (Chrome-style "hook onto" behavior).
	const dockListeners = []

	const pointOverOurTabBar = ({ x, y }) => {
		if (!cachedInnerPos) return false
		const bar = document.getElementById('tab-bar')
		if (!bar || bar.classList.contains('hidden')) return false
		const rect = bar.getBoundingClientRect()
		if (rect.width === 0 || rect.height === 0) return false
		const dpr = window.devicePixelRatio || 1
		const left = cachedInnerPos.x + rect.left * dpr
		const top = cachedInnerPos.y + rect.top * dpr
		const right = left + rect.width * dpr
		const bottom = top + rect.height * dpr
		return x >= left && x < right && y >= top && y < bottom
	}

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

	// Right-click "Close others": close every tab except `id`. Routes
	// through close() so dirty tabs still get the save prompt.
	const closeOthers = async id => {
		const ids = tabs.filter(t => t.id !== id).map(t => t.id)
		for (const otherId of ids) {
			await close(otherId)
		}
	}

	// Right-click "Close all to right": close every tab positioned after
	// `id` in the bar. Same dirty-tab handling as close().
	const closeAllToRight = async id => {
		const idx = tabs.findIndex(t => t.id === id)
		if (idx < 0) return
		const ids = tabs.slice(idx + 1).map(t => t.id)
		for (const rightId of ids) {
			await close(rightId)
		}
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
	// tab-transfer channel. Returns true if a new tab was actually added
	// (so callers can distinguish real adoption from idempotent no-ops —
	// continuous offer broadcasting during a drag will retrigger this
	// handler many times per second while the cursor is over our bar).
	// Deduplicates by tab id first (same offer resent), then by path
	// (different UUID for the same file already open here).
	const adopt = payload => {
		if (!payload || typeof payload !== 'object') return false
		if (tabs.some(t => t.id === payload.id)) return false
		if (payload.path) {
			const existing = tabs.find(t => t.path === payload.path)
			if (existing) {
				switchTo(existing.id)
				focusCurrentWindow()
				return false
			}
		}
		const doc = createDoc(payload)
		tabs.push(doc)
		if (isDirty(doc)) dirtyIds.add(doc.id)
		switchTo(doc.id)
		focusCurrentWindow()
		return true
	}

	// While an OS drag is already in progress on this window, broadcast
	// tab-offers on every window move so any target whose tab bar the
	// cursor enters can dock the tab (Chrome-style hover adoption). The
	// cursor is derived from `currentWindowPos + grabOffsetPhysical` —
	// the offset is invariant during OS drag (the OS just translates the
	// whole window, cursor-to-corner stays constant).
	//
	// Broadcasting: rAF-coalesced, at most one offer per animation frame.
	// Termination:
	//   - ACK received (target adopted) → cancel pending rAF, detach,
	//     destroy source. Happens mid-drag — user doesn't need to release.
	//   - pointerup without ACK → one last broadcast for the exact
	//     release position, 300ms grace for a late ACK, then clean up.
	//   - 30s safety cap (long to accommodate infinite tear↔rejoin
	//     cycling without the user ever releasing).
	//
	// Assumes OS drag has already been engaged by the caller. Used by
	// both single-tab pointerdown (dockTabViaWindowDrag) and tear-off
	// spawn (main.js after snap_and_drag).
	const armRejoinBroadcast = async (id, { grabOffsetPhysical }) => {
		const doc = tabs.find(t => t.id === id)
		if (!doc) return
		const payload = { ...doc }

		if (!currentLabel) currentLabel = await getCurrentWindowLabel()
		const sourceLabel = currentLabel

		let getCurrentWindow = null
		try {
			;({ getCurrentWindow } = await import('@tauri-apps/api/window'))
		} catch {
			return
		}
		const w = getCurrentWindow()

		const POST_RELEASE_ACK_MS = 300
		const SAFETY_TIMEOUT_MS = 30000

		let ended = false
		let rafId = null
		let unlistenMove = null
		let currentPos = null
		let safetyTimer = null

		const end = () => {
			if (ended) return
			ended = true
			if (rafId !== null) cancelAnimationFrame(rafId)
			rafId = null
			if (unlistenMove) unlistenMove()
			unlistenMove = null
			if (safetyTimer) clearTimeout(safetyTimer)
			window.removeEventListener('pointerup', onPointerUp)
			pendingAcks.delete(id)
		}

		const broadcastNow = () => {
			if (ended || !currentPos) return
			broadcastTabOffer({
				tabId: id,
				doc: payload,
				sourceLabel,
				dropX: currentPos.x + grabOffsetPhysical.x,
				dropY: currentPos.y + grabOffsetPhysical.y,
			})
		}

		const scheduleBroadcast = () => {
			if (ended || rafId !== null) return
			rafId = requestAnimationFrame(() => {
				rafId = null
				broadcastNow()
			})
		}

		pendingAcks.set(id, () => {
			if (ended) return
			end()
			detachLocal(id)
		})

		const onPointerUp = () => {
			if (ended) return
			broadcastNow()
			setTimeout(end, POST_RELEASE_ACK_MS)
		}
		window.addEventListener('pointerup', onPointerUp, { once: true })

		try {
			unlistenMove = await w.onMoved(ev => {
				if (ev?.payload) currentPos = { x: ev.payload.x, y: ev.payload.y }
				scheduleBroadcast()
			})
			safetyTimer = setTimeout(end, SAFETY_TIMEOUT_MS)
		} catch (e) {
			console.warn('armRejoinBroadcast: onMoved failed', e)
			end()
		}
	}

	// Single-tab window drag: pointerdown on the only tab in this window
	// hands off to the OS drag loop, then spins up the rejoin-broadcast
	// loop so the user can drop onto another window's tab bar to merge.
	// `grabScreenX/Y` are the cursor's CSS-pixel screen coords at the
	// moment of pointerdown (before OS drag kicked in).
	const dockTabViaWindowDrag = async (id, grabScreenX, grabScreenY) => {
		const doc = tabs.find(t => t.id === id)
		if (!doc) return

		let getCurrentWindow = null
		try {
			;({ getCurrentWindow } = await import('@tauri-apps/api/window'))
		} catch {
			return
		}
		const w = getCurrentWindow()

		// Capture the grab offset BEFORE starting the OS drag so
		// outerPosition() is still at its resting value.
		let grabOffsetPhysical
		try {
			const outerPos = await w.outerPosition()
			const dpr = window.devicePixelRatio || 1
			grabOffsetPhysical = {
				x: grabScreenX * dpr - outerPos.x,
				y: grabScreenY * dpr - outerPos.y,
			}
		} catch (e) {
			console.warn('dockTabViaWindowDrag: outerPosition failed', e)
			return
		}

		startNativeWindowDrag()
		await armRejoinBroadcast(id, { grabOffsetPhysical })
	}

	// Chrome-style tear-off: the moment the user drags a tab out of the bar,
	// spawn a new native window seeded with that tab and flip it into
	// OS-managed drag mode (`dragNow=1` in the URL → the new window's
	// main.js calls startDragging() as its first action). The user's
	// in-flight mouse drag is picked up by the OS, so the new window
	// follows the cursor seamlessly until they release.
	//
	// Returns the spawned window's Tauri label (or null on failure) so the
	// caller can keep piping live cursor-position updates to it — the new
	// window snaps itself under the cursor right before startDragging, so
	// any cursor drift during the spawn latency is corrected.
	//
	// Order matters: we await the spawn IPC *before* detaching locally.
	// detachLocal may destroy this window (if this was our last tab), and
	// destroying mid-promise would kill the create-window command before
	// Tauri dispatches it.
	const tearOffInFlight = async (id, dropAt) => {
		const idx = tabs.findIndex(t => t.id === id)
		if (idx < 0) return null
		const payload = { ...tabs[idx] }
		const hasDropAt = dropAt && Number.isFinite(dropAt.x) && Number.isFinite(dropAt.y)
		// Spawn directly at the cursor; main.js will re-snap to the latest
		// cursor position (source keeps pumping via cursor-update) right
		// before handing off to the OS drag. Any initial spawn offset
		// would just be drift we'd immediately correct anyway.
		const spawnAt = hasDropAt ? { x: dropAt.x, y: dropAt.y, dragNow: true } : { dragNow: true }
		const label = await createTearoffWindow(payload, spawnAt)
		if (!label) return null
		detachLocal(id)
		return label
	}

	// Resolve our window label + prime the innerPosition cache, then wire
	// up the cross-window dock channel. On offers, adopt the doc only if
	// the drop point lands on our tab bar. On acks, resolve the pending
	// dock promise so the source can close itself.
	;(async () => {
		currentLabel = await getCurrentWindowLabel()
		cachedInnerPos = await getCurrentInnerPosition()
		onWindowGeometryChange(async () => {
			cachedInnerPos = await getCurrentInnerPosition()
		})

		subscribeTabOffer(async offer => {
			if (!offer || !offer.doc) return
			if (offer.sourceLabel && offer.sourceLabel === currentLabel) return
			// First offer after launch may race the cache prime — fetch
			// synchronously just this once so we don't silently miss a
			// legitimate dock attempt.
			if (!cachedInnerPos) cachedInnerPos = await getCurrentInnerPosition()
			if (!pointOverOurTabBar({ x: offer.dropX, y: offer.dropY })) return
			const freshlyAdopted = adopt(offer.doc)
			// Always ACK on a hit-test match: if the source is still
			// broadcasting, it needs the handshake to close itself. An
			// ACK for an already-adopted tab is harmless — first ACK
			// already fired the source's resolver, subsequent ones are
			// filtered by the pendingAcks.get check.
			if (offer.sourceLabel) {
				confirmTabAdopted(offer.sourceLabel, { tabId: offer.tabId, targetLabel: currentLabel })
			}
			// Only arm the drag-continuation on the first real adoption.
			// Repeated offers for the same tab must not re-arm (would
			// stack listeners and clobber the user's ongoing drag).
			if (freshlyAdopted) {
				for (const cb of dockListeners) {
					try {
						cb(offer.doc.id)
					} catch (e) {
						console.warn('dockListener failed', e)
					}
				}
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
		closeOthers,
		closeAllToRight,
		save,
		saveAs: saveAsDoc,
		saveAll,
		reorder,
		tearOffInFlight,
		dockTabViaWindowDrag,
		armRejoinBroadcast,
		onTabDocked: cb => {
			dockListeners.push(cb)
			return () => {
				const i = dockListeners.indexOf(cb)
				if (i >= 0) dockListeners.splice(i, 1)
			}
		},
		onChange,
		isDirty,
		isTearoffWindow: () => IS_TEAROFF_WINDOW,
	}
}

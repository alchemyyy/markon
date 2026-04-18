import '@fontsource/bungee'
import '@fontsource/monaspace-argon'
import '@fontsource/monaspace-argon/400-italic.css'
import '@fontsource/monaspace-argon/700.css'
import '@fontsource/monaspace-krypton'
import '@fontsource/monaspace-krypton/400-italic.css'
import '@fontsource/monaspace-krypton/700.css'
import 'iconify-icon'
import tablerIcons from '@iconify-json/tabler/icons.json' with { type: 'json' }
import './style.css'
import './components.css'
import './themes.css'
import { updatePWAUI } from './actions.js'
import { createEditor } from './core.js'
import { createDocsStore } from './docs.js'
import { getCliArgs, registerDropHandler, snapAndDrag } from './native.js'
import { setupPreview } from './preview.js'
import { createRecentDropdown } from './recent-ui.js'
import { applyScrollbarSide } from './settings.js'
import { createTabBar } from './tabs.js'
import { createFileTree } from './tree.js'
import { initUI } from './ui.js'
import { injectCustomThemesCSS } from './utils.js'

// Chrome-style tear-off: when this window was spawned mid-drag (source
// window passed `?dragNow=1`), hand off to the OS's native drag loop as
// the VERY first thing. startDragging uses WM_NCLBUTTONDOWN / AppKit /
// GTK equivalents under the hood, all of which only latch onto an
// in-flight drag if the mouse button is still down — so every ms we
// spend here before firing risks losing the drag.
//
// Window spawn + webview load takes ~100-300ms, during which the cursor
// may have drifted from where the source spawned us. To correct for that,
// the source keeps emitting `markon://cursor-update` on every pointermove;
// we wait for the first one, setPosition to it, THEN startDragging. If
// no update arrives within FALLBACK_MS (user stopped moving or released),
// we start drag at the spawn position anyway.
const DRAG_NOW = (() => {
	try {
		return new URLSearchParams(location.search).get('dragNow') === '1'
	} catch {
		return false
	}
})()

// Must match GRAB_OFFSET_X / GRAB_OFFSET_Y in src-tauri/src/lib.rs —
// after snap_and_drag, the cursor is at (window + this offset) in
// logical pixels, which armRejoinBroadcast needs in physical.
const GRAB_OFFSET_X_LOGICAL = 60
const GRAB_OFFSET_Y_LOGICAL = 85

// Chrome-style tear-off: when this window was spawned mid-drag (source
// passed `?dragNow=1`), fire the atomic snap+drag Rust command AFTER
// the adopted tab has actually finished building (tab bar rendered,
// editor populated). boot() awaits docs.boot() and calls this — that's
// the "tab is built" moment. The cursor position is read from the OS
// by Rust itself (inside snap_and_drag), so there's no stale-coord
// ferry through JS.
//
// Then arm the rejoin-broadcast loop so the user can keep holding the
// mouse and drop this torn-off window onto another window's tab bar
// for infinite tear ↔ rejoin cycling.
let dragNowStarted = false
const triggerDragNow = async docs => {
	if (!DRAG_NOW || dragNowStarted) return
	dragNowStarted = true
	await snapAndDrag()
	const activeId = docs?.getActive?.()?.id
	if (!activeId || !docs?.armRejoinBroadcast) return
	const dpr = window.devicePixelRatio || 1
	docs.armRejoinBroadcast(activeId, {
		grabOffsetPhysical: {
			x: GRAB_OFFSET_X_LOGICAL * dpr,
			y: GRAB_OFFSET_Y_LOGICAL * dpr,
		},
	})
}

// One-shot kill switch: nuke any service worker + caches we may have registered
// in earlier dev sessions. Runs before anything else so a stale SW can't keep
// serving an out-of-date index.html (the bug that pinned the tab bar to the
// editor's column width even after the HTML structure changed).
const killStaleServiceWorker = async () => {
	try {
		if ('serviceWorker' in navigator) {
			const regs = await navigator.serviceWorker.getRegistrations()
			let killed = false
			for (const r of regs) {
				await r.unregister()
				killed = true
			}
			if ('caches' in window) {
				const keys = await caches.keys()
				for (const k of keys) await caches.delete(k)
			}
			// If we just unregistered something, the page is still being served by
			// the dead SW — force one fresh fetch from the server.
			if (killed) {
				location.reload()
				// stop boot; the reload will re-enter
				return new Promise(() => {})
			}
		}
	} catch (e) {
		console.warn('SW cleanup failed', e)
	}
}

const boot = async () => {
	await killStaleServiceWorker()
	applyScrollbarSide() // before createEditor so the scroller mounts on the right side from the start
	injectCustomThemesCSS()

	// Configure iconify to use local Tabler icons instead of API
	// Wait for iconify-icon to be ready, then add the collection
	const addTablerIcons = () => {
		if (window.Iconify && window.Iconify.addCollection) {
			window.Iconify.addCollection(tablerIcons)
		} else if (window.customElements && window.customElements.get('iconify-icon')) {
			const iconifyIcon = window.customElements.get('iconify-icon')
			if (iconifyIcon.addCollection) {
				iconifyIcon.addCollection(tablerIcons)
			}
		}
	}

	// Try immediately and also when DOM is ready
	addTablerIcons()
	document.addEventListener('DOMContentLoaded', addTablerIcons)

	const { getMarkdown, setMarkdown, onMarkdownUpdated, cleanup, profiler, scrollToLine, view } = await createEditor()
	const { previewHtml, showToast } = await initUI({ getMarkdown, setMarkdown, scrollToLine, view })
	setupPreview({ getMarkdown, onMarkdownUpdated, previewHtml, profiler })

	// Documents / tabs / tree / recent files
	const docs = createDocsStore({
		editor: {
			getContent: getMarkdown,
			setContent: setMarkdown,
			onContentChange: onMarkdownUpdated,
		},
		showToast,
	})
	window.docs = docs

	createTabBar({ docs, container: document.getElementById('tab-bar-slot') })

	const fileTree = createFileTree({ docs, container: document.getElementById('tree-sidebar'), showToast })
	window.fileTree = fileTree

	const recentDropdown = createRecentDropdown({ docs, showToast })
	window.recentDropdown = recentDropdown

	await docs.boot()

	// Adopted tab is now rendered in the DOM and populated in the editor —
	// this is the authoritative "tab is built" moment. Fire the atomic
	// snap-to-cursor + start-OS-drag Rust command and arm rejoin-broadcast
	// so the user can keep the mouse held and tear/rejoin indefinitely.
	triggerDragNow(docs)

	// Secondary (tear-off) windows skip folder-restore and CLI-arg open —
	// those are main-window concerns. The tear-off was seeded from a handoff
	// payload inside docs.boot() and shouldn't be polluted with other state.
	if (!docs.isTearoffWindow()) {
		// Restore previously-opened folder (cleared when the user closes the folder panel)
		const savedFolder = localStorage.getItem('markon-folder')
		if (savedFolder) await fileTree.open(savedFolder).catch(() => {})

		// Open any files passed on CLI (`markon foo.md bar.md`) — after boot so they land in tabs
		const cliFiles = await getCliArgs()
		for (const p of cliFiles) await docs.openPath(p)
	}

	// Handle PWA install prompt - setup after UI is initialized
	window.addEventListener('beforeinstallprompt', event => {
		event.preventDefault()
		// If pwa-installed flag was set, app was uninstalled - clear flags
		if (localStorage.getItem('pwa-installed') === 'true') {
			localStorage.removeItem('pwa-installed')
			localStorage.removeItem('pwa-banner-dismissed')
		}
		window.deferredPrompt = event
		updatePWAUI()
	})

	// Clear install prompt after successful install
	window.addEventListener('appinstalled', () => {
		localStorage.setItem('pwa-installed', 'true')
		window.deferredPrompt = null
		updatePWAUI()
	})

	// Update PWA UI on initial load (check if already installed)
	updatePWAUI()

	// Expose profiler globally for console inspection
	window.__MARKON_PERF__ = profiler

	// Drag-drop open: each dropped file becomes (or activates) its own tab
	registerDropHandler(async file => {
		if (file.path) {
			const doc = await docs.openPath(file.path)
			if (doc) window.showToast?.(`opened ${file.name}`, 1200, 'tabler:check')
		} else {
			setMarkdown(file.content)
		}
	})

	// Cleanup storage on page unload
	window.addEventListener('beforeunload', cleanup)
}

boot()

import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
	redo,
	redoDepth,
	undo,
	undoDepth,
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import sampleMd from '../sample.md?raw'
import { showContextMenu } from './context-menu.js'
import { createProfiler } from './profiler.js'
import { editorThemeExtensions } from './style.js'

const readDefaultMarkdown = async () => sampleMd || '# markon\n\nStart typing...'

export const LINE_NUMBERS_KEY = 'markon-line-numbers'
const lineNumbersOnByDefault = () => {
	const raw = localStorage.getItem(LINE_NUMBERS_KEY)
	return raw == null ? true : raw === 'true'
}
const lineNumbersExt = enabled => (enabled ? lineNumbers() : [])

// CodeMirror's built-in drag-selection autoscroll is glacially slow — it
// scrolls a fixed handful of px per tick regardless of how far past the
// viewport edge the pointer is. Add our own rAF-driven scroller that ramps
// with pointer distance, capped to a sane max so fullscreen doesn't fly
// off. The bottom trigger zone is the bottom 4% of the scroller (so it
// stays proportional from a small window all the way up to fullscreen).
const AUTOSCROLL_TOP_ZONE = 80 // px inside the top edge where the ramp begins
const AUTOSCROLL_BOTTOM_ZONE_RATIO = 0.06 // bottom 6% of the scroller
const AUTOSCROLL_RAMP = 0.18 // px-per-frame added per px past the trigger line
const AUTOSCROLL_BASE = 2 // px/frame at the trigger line
const AUTOSCROLL_MAX = 28 // hard cap (fullscreen-friendly)

const attachFastAutoscroll = view => {
	const scroller = view.scrollDOM
	let dragging = false
	let pointerY = 0
	let rafId = 0

	const tick = () => {
		if (!dragging) {
			rafId = 0
			return
		}
		const rect = scroller.getBoundingClientRect()
		const bottomZone = rect.height * AUTOSCROLL_BOTTOM_ZONE_RATIO
		const above = rect.top + AUTOSCROLL_TOP_ZONE - pointerY
		const below = pointerY - (rect.bottom - bottomZone)
		let dy = 0
		if (above > 0) dy = -Math.min(AUTOSCROLL_MAX, AUTOSCROLL_BASE + above * AUTOSCROLL_RAMP)
		else if (below > 0) dy = Math.min(AUTOSCROLL_MAX, AUTOSCROLL_BASE + below * AUTOSCROLL_RAMP)
		if (dy !== 0) scroller.scrollTop += dy
		rafId = requestAnimationFrame(tick)
	}

	const stop = () => {
		dragging = false
		if (rafId) cancelAnimationFrame(rafId)
		rafId = 0
		window.removeEventListener('pointermove', onMove)
		window.removeEventListener('pointerup', stop)
		window.removeEventListener('pointercancel', stop)
	}

	const onMove = e => {
		pointerY = e.clientY
	}

	scroller.addEventListener('pointerdown', e => {
		if (e.button !== 0) return
		dragging = true
		pointerY = e.clientY
		window.addEventListener('pointermove', onMove)
		window.addEventListener('pointerup', stop)
		window.addEventListener('pointercancel', stop)
		if (!rafId) rafId = requestAnimationFrame(tick)
	})
}

export const createEditor = async () => {
	let view = null
	const subscribers = []
	const profiler = createProfiler()
	const lineNumbersCompartment = new Compartment()

	const mountIfNeeded = () => {
		const html = document.documentElement
		if (!html.classList.contains('ready')) html.classList.add('ready')
	}

	const notify = () => {
		if (!subscribers.length) return
		const value = view.state.doc.toString()
		for (const fn of subscribers) fn(value)
	}

	const make = defaultValue => {
		view?.destroy?.()
		const state = EditorState.create({
			doc: defaultValue,
			extensions: [
				// minDepth controls how many history events we keep before pruning.
				// CM's default is 100 — way too small. 10k events covers any realistic
				// editing session and only costs a few MB of metadata at most.
				history({ minDepth: 10000 }),
				markdown({ base: markdownLanguage, codeLanguages: languages }),
				keymap.of([indentWithTab, ...historyKeymap, ...defaultKeymap]),
				EditorView.lineWrapping,
				lineNumbersCompartment.of(lineNumbersExt(lineNumbersOnByDefault())),
				EditorView.updateListener.of(v => {
					if (v.docChanged) {
						profiler.markInputStart()
						notify()
					}
				}),
				...editorThemeExtensions(),
			],
		})
		view = new EditorView({ state, parent: document.querySelector('#editor') })
		mountIfNeeded()
		attachFastAutoscroll(view)
		attachEditorContextMenu(view)
	}

	// Right-click menu inside the editor pane: cut/copy/paste/select-all/
	// undo/redo. CodeMirror commands handle the editor-state side; the
	// browser Clipboard API does the OS clipboard read/write so we don't
	// depend on document.execCommand (deprecated, behavior varies).
	const attachEditorContextMenu = view => {
		const cutSelection = async () => {
			const sel = view.state.selection.main
			if (sel.from === sel.to) return
			const text = view.state.sliceDoc(sel.from, sel.to)
			try {
				await navigator.clipboard.writeText(text)
			} catch {}
			view.dispatch(view.state.replaceSelection(''))
			view.focus()
		}
		const copySelection = async () => {
			const sel = view.state.selection.main
			if (sel.from === sel.to) return
			try {
				await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to))
			} catch {}
		}
		const pasteAtCursor = async () => {
			let text = ''
			try {
				text = await navigator.clipboard.readText()
			} catch {}
			if (!text) return
			view.dispatch(view.state.replaceSelection(text))
			view.focus()
		}

		view.dom.addEventListener('contextmenu', e => {
			e.preventDefault()
			const sel = view.state.selection.main
			const hasSelection = sel.from !== sel.to
			const canUndo = undoDepth(view.state) > 0
			const canRedo = redoDepth(view.state) > 0
			showContextMenu({ x: e.clientX, y: e.clientY }, [
				{ label: 'Cut', disabled: !hasSelection, onClick: cutSelection },
				{ label: 'Copy', disabled: !hasSelection, onClick: copySelection },
				{ label: 'Paste', onClick: pasteAtCursor },
				{
					label: 'Select all',
					onClick: () => {
						// Focus first so the highlight actually shows; calling
						// selectAll() on an unfocused view dispatches the
						// transaction but the visual selection isn't drawn.
						view.focus()
						view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
					},
				},
				{ label: 'Undo', disabled: !canUndo, onClick: () => undo(view) },
				{ label: 'Redo', disabled: !canRedo, onClick: () => redo(view) },
			])
		})
	}

	const setLineNumbers = enabled => {
		if (!view) return
		view.dispatch({ effects: lineNumbersCompartment.reconfigure(lineNumbersExt(enabled)) })
		localStorage.setItem(LINE_NUMBERS_KEY, String(enabled))
	}

	// Boot with sample content; docs.js owns all persistence/state.
	const initialContent = await readDefaultMarkdown()
	make(initialContent)

	const getMarkdown = () => view.state.doc.toString()
	const setMarkdown = markdown => {
		const doc = markdown ?? ''
		const tr = view.state.update({
			changes: { from: 0, to: view.state.doc.length, insert: doc },
		})
		view.update([tr])
		notify()
	}
	const onMarkdownUpdated = fn => subscribers.push(fn)

	const scrollToLine = lineNumber => {
		if (!view || lineNumber < 1) return
		const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines))
		view.dispatch({
			effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 20 }),
		})
	}

	// Expose global functions for worker
	window.getMarkdown = getMarkdown
	window.setMarkdown = setMarkdown
	window.setLineNumbers = setLineNumbers

	const cleanup = () => {}

	return { getMarkdown, setMarkdown, onMarkdownUpdated, cleanup, profiler, scrollToLine, view, setLineNumbers }
}

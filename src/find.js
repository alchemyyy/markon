// Find (ctrl+f): one query searched in the raw Markdown and in the rendered preview at once.
// - Source: a CodeMirror field holds the matches and marks them (`.cm-find-match`, `.cm-find-current`)
// - Preview: matches become DOM ranges painted with the CSS Custom Highlight API (`::highlight(markon-find)`),
//   so the rendered DOM is never touched and re-renders (morphdom, the GitHub renderer's patches) can't disturb them
// Enter / Shift+Enter step to the next / previous match in both panes; Escape closes and selects the source match.
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { createElement } from './utils.js'

/** Matches counted per pane; past this the count shows `+` */
const MAX_MATCHES = 5000
const HIGHLIGHT = 'markon-find'
const HIGHLIGHT_CURRENT = 'markon-find-current'
/** Scroll sync is held this long while a match is revealed in each pane */
const SYNC_HOLD_MS = 400
const PREFILL_MAX = 200
/** Text in different blocks never joins into one match */
const BLOCKS =
	'p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, div, table, tr, ul, ol, dl, dt, dd, section, article, details, summary, figure, figcaption, svg'
/** Text nobody sees: stylesheets in diagrams, MathJax's assistive copy of each formula */
const SKIPPED = 'style, script, title, desc, mjx-assistive-mml'

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `[from, to]` of each case-insensitive occurrence of `query` in `text`, at most MAX_MATCHES */
const findAll = (text, query) => {
	const matches = []
	if (!query) return matches
	for (const match of text.matchAll(new RegExp(escapeRegExp(query), 'gi'))) {
		matches.push([match.index, match.index + match[0].length])
		if (matches.length === MAX_MATCHES) break
	}
	return matches
}

// ---------------------------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------------------------

const setQuery = StateEffect.define()
const setCurrent = StateEffect.define()
const matchMark = Decoration.mark({ class: 'cm-find-match' })
const currentMark = Decoration.mark({ class: 'cm-find-match cm-find-current' })

const decorate = (matches, current) => {
	const builder = new RangeSetBuilder()
	matches.forEach(([from, to], index) => {
		builder.add(from, to, index === current ? currentMark : matchMark)
	})
	return builder.finish()
}

const findField = StateField.define({
	create: () => ({ query: '', matches: [], current: -1, decorations: Decoration.none }),
	update(value, tr) {
		let { query, current } = value
		let searched = tr.docChanged
		for (const effect of tr.effects) {
			if (effect.is(setQuery)) {
				query = effect.value
				searched = true
			} else if (effect.is(setCurrent)) {
				current = effect.value
			}
		}
		if (!searched && current === value.current) return value
		const matches = searched ? findAll(query ? tr.state.doc.toString() : '', query) : value.matches
		current = matches.length === 0 ? -1 : Math.min(current, matches.length - 1)
		return { query, matches, current, decorations: decorate(matches, current) }
	},
	provide: field => EditorView.decorations.from(field, value => value.decorations),
})

/** Called whenever the source matches change, typing included */
let onSourceMatches = null

/** The editor's part of find; core.js adds it to the editor */
export const findExtension = [
	findField,
	EditorView.updateListener.of(update => {
		if (update.state.field(findField) !== update.startState.field(findField)) onSourceMatches?.()
	}),
]

// ---------------------------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------------------------

/** DOM ranges of `query` in the visible text under `root`, in document order */
const previewRanges = (root, query) => {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: node => (node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
	})
	// The text of every node joined, with a line break between blocks; each segment records where its node starts
	const segments = []
	let text = ''
	let block = null
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const nodeBlock = node.parentElement?.closest(BLOCKS) ?? null
		if (block !== nodeBlock && text) text += '\n'
		block = nodeBlock
		segments.push({ node, start: text.length })
		text += node.data
	}
	// The segment holding character `offset`; matches never cover the line breaks between segments
	let index = 0
	const segmentAt = offset => {
		while (index + 1 < segments.length && segments[index + 1].start <= offset) index++
		return segments[index]
	}
	return findAll(text, query).map(([from, to]) => {
		const range = document.createRange()
		const first = segmentAt(from)
		range.setStart(first.node, from - first.start)
		const last = segmentAt(to - 1)
		range.setEnd(last.node, to - last.start)
		return range
	})
}

/** A range's top in its scroller's content */
const contentTop = (range, scroller) =>
	range.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop

const paintPreview = (ranges, current) => {
	if (!window.CSS?.highlights) return
	CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges.filter((_, index) => index !== current)))
	CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(...(current >= 0 ? [ranges[current]] : [])))
}

const clearPreview = () => {
	CSS.highlights?.delete(HIGHLIGHT)
	CSS.highlights?.delete(HIGHLIGHT_CURRENT)
}

// ---------------------------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------------------------

const iconButton = (icon, label) => {
	const button = createElement('button', { type: 'button', title: label, className: 'find-bar-button' })
	button.setAttribute('aria-label', label)
	button.appendChild(createElement('iconify-icon', { icon, width: '18', height: '18' }))
	return button
}

const countLabel = (current, total) => {
	if (total === 0) return '0'
	const count = `${total}${total === MAX_MATCHES ? '+' : ''}`
	return current < 0 ? count : `${current + 1}/${count}`
}

/** The find bar for the editor `view` and the preview controller `preview` (preview.js) */
export const createFindBar = ({ view, preview }) => {
	const input = createElement('input', { type: 'text', placeholder: 'Find in source and preview', spellcheck: false })
	const count = createElement('span', { className: 'find-bar-count' })
	const previous = iconButton('tabler:chevron-up', 'Previous match (shift+enter)')
	const next = iconButton('tabler:chevron-down', 'Next match (enter)')
	const close = iconButton('tabler:x', 'Close (escape)')
	const bar = createElement('div', { id: 'find-bar', hidden: true })
	bar.append(input, count, previous, next, close)
	document.body.appendChild(bar)

	let open = false
	let ranges = []
	let current = -1
	/** Where the search starts: the editor's cursor and the preview's scroll position when the bar opened */
	let anchor = { position: 0, top: 0 }

	const source = () => view.state.field(findField)

	const render = () => {
		const { matches, current: sourceCurrent } = source()
		const none = input.value !== '' && matches.length === 0 && ranges.length === 0
		input.classList.toggle('no-results', none)
		if (!input.value) count.textContent = ''
		else if (none) count.textContent = 'No results'
		else {
			count.textContent = `source ${countLabel(sourceCurrent, matches.length)} \u00b7 preview ${countLabel(current, ranges.length)}`
		}
	}

	/** Finds the query in the preview shown again, keeping the current match's index */
	const searchPreview = () => {
		const root = preview.contentRoot()
		ranges = root && input.value ? previewRanges(root, input.value) : []
		current = ranges.length === 0 ? -1 : Math.min(current, ranges.length - 1)
		paintPreview(ranges, current)
	}

	/** Makes match `sourceIndex` current in the source and `previewIndex` in the preview, scrolling each to it */
	const select = (sourceIndex, previewIndex) => {
		window.editorSync?.hold(SYNC_HOLD_MS)
		const match = source().matches[sourceIndex]
		view.dispatch({
			effects: [setCurrent.of(sourceIndex), ...(match ? [EditorView.scrollIntoView(match[0], { y: 'center' })] : [])],
		})
		current = previewIndex
		paintPreview(ranges, current)
		const scroller = preview.scroller()
		if (ranges[current] && scroller) {
			scroller.scrollTop = contentTop(ranges[current], scroller) - scroller.clientHeight / 2
		}
		render()
	}

	/** Searches both panes for the query, starting from where the bar opened */
	const search = () => {
		view.dispatch({ effects: setQuery.of(input.value) })
		current = -1
		searchPreview()
		const { matches } = source()
		const sourceIndex = matches.findIndex(([from]) => from >= anchor.position)
		const scroller = preview.scroller()
		const previewIndex = scroller ? ranges.findIndex(range => contentTop(range, scroller) >= anchor.top) : -1
		select(matches.length ? Math.max(0, sourceIndex) : -1, ranges.length ? Math.max(0, previewIndex) : -1)
	}

	/** Steps both panes `delta` matches on, wrapping at either end */
	const step = delta => {
		const wrap = (index, total) => {
			if (total === 0) return -1
			if (index < 0) return delta > 0 ? 0 : total - 1
			return (index + delta + total) % total
		}
		// A preview without a current match (another renderer, a re-render) starts from what it shows
		let previewIndex = current
		const scroller = preview.scroller()
		if (previewIndex < 0 && delta > 0 && scroller) {
			previewIndex = ranges.findIndex(range => contentTop(range, scroller) >= scroller.scrollTop) - 1
			if (previewIndex < -1) previewIndex = ranges.length - 1
		}
		select(wrap(source().current, source().matches.length), wrap(previewIndex, ranges.length))
	}

	/** Selected text to search for: the editor's selection when it has focus, else the page's (the preview) */
	const selectedText = () => {
		const { from, to } = view.state.selection.main
		const text = view.hasFocus ? view.state.sliceDoc(from, to) : (window.getSelection()?.toString() ?? '')
		return text && !text.includes('\n') && text.length <= PREFILL_MAX ? text : ''
	}

	const openBar = () => {
		const prefill = selectedText()
		if (!open) {
			open = true
			bar.hidden = false
			// Just below the tab bar, over the top right of the panes
			const tabs = document.getElementById('tab-bar-slot')
			bar.style.top = `${(tabs?.getBoundingClientRect().bottom ?? 0) + 8}px`
			anchor = { position: view.state.selection.main.from, top: preview.scroller()?.scrollTop ?? 0 }
		}
		if (prefill) input.value = prefill
		input.focus()
		input.select()
		if (input.value) search()
	}

	const closeBar = () => {
		if (!open) return
		open = false
		bar.hidden = true
		// The source match last shown stays selected, as in an editor's own find
		const { matches, current: sourceCurrent } = source()
		const match = matches[sourceCurrent]
		view.dispatch({
			effects: setQuery.of(''),
			...(match && { selection: { anchor: match[0], head: match[1] } }),
		})
		ranges = []
		current = -1
		clearPreview()
		view.focus()
	}

	input.addEventListener('input', search)
	input.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			e.preventDefault()
			step(e.shiftKey ? -1 : 1)
		} else if (e.key === 'Escape') {
			e.preventDefault()
			closeBar()
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
			// Already open: select the query instead of opening the WebView's own find
			e.preventDefault()
			input.select()
		}
	})
	previous.addEventListener('click', () => step(-1))
	next.addEventListener('click', () => step(1))
	close.addEventListener('click', closeBar)

	// Source matches change as the document is typed in or another tab is shown
	onSourceMatches = () => {
		if (open) render()
	}

	// Preview matches follow re-renders and the renderer shown
	let frame = 0
	const schedulePreviewSearch = () => {
		if (!open || !input.value || frame) return
		frame = requestAnimationFrame(() => {
			frame = 0
			searchPreview()
			render()
		})
	}
	const observer = new MutationObserver(schedulePreviewSearch)
	const observed = new Set()
	const observe = () => {
		const root = preview.contentRoot()
		if (!root || observed.has(root)) return
		observed.add(root)
		observer.observe(root, { childList: true, subtree: true, characterData: true })
	}
	observe()
	preview.onChange(() => {
		observe()
		schedulePreviewSearch()
	})

	return { open: openBar, close: closeBar }
}

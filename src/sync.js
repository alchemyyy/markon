const findLineInMarkdown = (markdown, text) => {
	const searchText = text.trim().toLowerCase()
	if (!searchText) return null
	
	const lines = markdown.split('\n')
	const index = lines.findIndex(line => {
		const normalized = line.trim().toLowerCase()
		return normalized === searchText || normalized.includes(searchText) || searchText.includes(normalized)
	})
	
	return index >= 0 ? index + 1 : null
}

const findHeaderInMarkdown = (markdown, header) => {
	const prefix = '#'.repeat(header.level) + ' '
	const escapedText = header.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const pattern = new RegExp(`^${prefix}${escapedText}\\s*(?:\\{#.*\\})?$`, 'm')
	const match = markdown.match(pattern)
	return match ? markdown.substring(0, match.index).split('\n').length : null
}

const matchesText = (elText, searchText) => {
	const normalized = elText.trim().toLowerCase()
	return normalized === searchText || normalized.includes(searchText) || searchText.includes(normalized)
}

const findElementInPreview = (previewHtml, lineText) => {
	const searchText = lineText.trim().toLowerCase()
	if (!searchText || !previewHtml) return null
	
	const selectors = [
		['h1, h2, h3, h4, h5, h6'],
		['p, li, code, pre, blockquote']
	]
	
	for (const selector of selectors) {
		const elements = previewHtml.querySelectorAll(selector)
		const found = Array.from(elements).find(el => matchesText(el.textContent, searchText))
		if (found) return found
	}
	
	return null
}

const getVisibleLineFromEditor = (view) => {
	if (!view) return null
	
	const scrollDOM = view.scrollDOM
	const rect = scrollDOM.getBoundingClientRect()
	const topPos = view.posAtCoords({ x: rect.left, y: rect.top })
	if (topPos === null) return null
	
	const line = view.state.doc.lineAt(topPos)
	return { line: line.number, text: line.text }
}

const getVisibleElementFromPreview = (previewContainer) => {
	const previewHtml = previewContainer.querySelector('#previewhtml')
	if (!previewHtml) return null
	
	const containerRect = previewContainer.getBoundingClientRect()
	const scrollTop = previewContainer.scrollTop || previewHtml.scrollTop
	const viewportTop = containerRect.top + 20
	
	const elements = Array.from(previewHtml.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, code, pre, blockquote'))
	
	const inViewport = elements
		.map(el => {
			const elRect = el.getBoundingClientRect()
			const elTop = elRect.top
			const inRange = elTop <= viewportTop && elRect.bottom >= viewportTop
			return { el, elTop, inRange, distance: Math.abs(elTop - viewportTop) }
		})
		.filter(({ inRange }) => inRange)
		.reduce((closest, current) => 
			current.distance < closest.distance ? current : closest, 
			{ distance: Infinity }
		)
	
	const closestEl = inViewport.distance < Infinity 
		? inViewport.el 
		: elements.find(el => el.getBoundingClientRect().top > viewportTop)
	
	if (!closestEl) return null
	
	const text = closestEl.textContent.trim()
	const isHeader = /^h[1-6]$/i.test(closestEl.tagName)
	return { 
		element: closestEl, 
		text,
		isHeader,
		level: isHeader ? parseInt(closestEl.tagName[1]) : null
	}
}

// The editor's scroll position for the GitHub renderer's preview to follow:
// `line` is the source line (1-based, fractional) at the top of the editor
const editorScrollPosition = view => {
	const scroller = view.scrollDOM
	const scrollable = scroller.scrollHeight - scroller.clientHeight
	const height = Math.max(0, scroller.getBoundingClientRect().top - view.documentTop)
	const block = view.lineBlockAtHeight(height)
	const fraction = block.height > 0 ? Math.min(1, Math.max(0, (height - block.top) / block.height)) : 0
	return {
		line: view.state.doc.lineAt(block.from).number + fraction,
		lineCount: view.state.doc.lines,
		atTop: scroller.scrollTop <= 1,
		atBottom: scrollable - scroller.scrollTop <= 2,
	}
}

// Scrolls the editor so source line `position` (1-based, fractional) is at its top
const scrollEditorToLine = (view, position) => {
	const doc = view.state.doc
	const number = Math.min(doc.lines, Math.max(1, Math.floor(position)))
	const block = view.lineBlockAt(doc.line(number).from)
	const scroller = view.scrollDOM
	const contentTop = view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
	scroller.scrollTop = contentTop + block.top + (position - number) * block.height
}

// An instant scroll has fired its scroll event two frames on
const afterScroll = release => requestAnimationFrame(() => requestAnimationFrame(release))

// Keeps the editor and the preview scrolled to the same place.
// The GitHub renderer marks blocks with their source lines and syncs by line;
// markon's renderer syncs by matching the text of the line at the top.
export const createScrollSync = (editorView, preview, previewContainer, getMarkdown, scrollToLine) => {
	let enabled = false
	let syncingEditor = false
	let syncingPreview = false
	let previewScrollers = []
	let editorDebounceTimer = null
	let previewDebounceTimer = null
	// Until then, scrolling in either pane doesn't move the other (find reveals a match in each)
	let heldUntil = 0
	const blocked = () => syncingEditor || syncingPreview || !enabled || performance.now() < heldUntil

	const syncEditorToPreview = () => {
		if (blocked()) return
		
		clearTimeout(editorDebounceTimer)
		editorDebounceTimer = setTimeout(() => {
			if (blocked()) return
			
			syncingEditor = true
			requestAnimationFrame(() => {
				const gfm = preview.gfm()
				if (gfm) {
					gfm.follow(editorScrollPosition(editorView))
					afterScroll(() => {
						syncingEditor = false
					})
					return
				}

				const visible = getVisibleLineFromEditor(editorView)
				if (!visible) {
					syncingEditor = false
					return
				}
				
				const previewHtml = previewContainer.querySelector('#previewhtml')
				if (!previewHtml) {
					syncingEditor = false
					return
				}
				
				const targetEl = findElementInPreview(previewHtml, visible.text)
				if (!targetEl) {
					syncingEditor = false
					return
				}
				
				targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
				setTimeout(() => { syncingEditor = false }, 300)
			})
		}, 50)
	}

	const syncPreviewToEditor = () => {
		if (blocked()) return
		
		clearTimeout(previewDebounceTimer)
		previewDebounceTimer = setTimeout(() => {
			if (blocked()) return
			
			syncingPreview = true
			requestAnimationFrame(() => {
				const gfm = preview.gfm()
				if (gfm) {
					const scroller = gfm.scroller
					const editorScroller = editorView.scrollDOM
					if (scroller.scrollTop <= 1) editorScroller.scrollTop = 0
					else if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2) {
						editorScroller.scrollTop = editorScroller.scrollHeight
					} else {
						scrollEditorToLine(editorView, gfm.topLine(editorView.state.doc.lines))
					}
					afterScroll(() => {
						syncingPreview = false
					})
					return
				}

				const visible = getVisibleElementFromPreview(previewContainer)
				if (!visible) {
					syncingPreview = false
					return
				}
				
				const markdown = getMarkdown()
				if (!markdown) {
					syncingPreview = false
					return
				}
				
				const lineNumber = (visible.isHeader && visible.level)
					? findHeaderInMarkdown(markdown, { text: visible.text, level: visible.level })
					: findLineInMarkdown(markdown, visible.text)
				
				if (!lineNumber || !scrollToLine) {
					syncingPreview = false
					return
				}
				
				scrollToLine(lineNumber)
				setTimeout(() => { syncingPreview = false }, 300)
			})
		}, 50)
	}

	const editorScrollHandler = () => syncEditorToPreview()
	const previewScrollHandler = () => syncPreviewToEditor()

	// Listens to the scrolling of the preview shown:
	// the GitHub renderer's shadow-root scroller, or #previewhtml and its container
	const watchPreview = () => {
		for (const scroller of previewScrollers) scroller.removeEventListener('scroll', previewScrollHandler)
		previewScrollers = []
		if (!enabled) return
		const gfm = preview.gfm()
		const previewHtml = previewContainer.querySelector('#previewhtml')
		previewScrollers = gfm ? [gfm.scroller] : [previewContainer, previewHtml].filter(Boolean)
		for (const scroller of previewScrollers) {
			scroller.addEventListener('scroll', previewScrollHandler, { passive: true })
		}
	}

	const enable = () => {
		if (enabled) return
		enabled = true
		editorView.scrollDOM.addEventListener('scroll', editorScrollHandler, { passive: true })
		watchPreview()
	}

	const disable = () => {
		if (!enabled) return
		enabled = false
		editorView.scrollDOM.removeEventListener('scroll', editorScrollHandler)
		watchPreview()
	}

	// Another renderer shown: follow its scrolling, and bring it to the editor's place
	preview.onChange(() => {
		watchPreview()
		syncEditorToPreview()
	})
	// A GitHub render can move blocks under the editor's top line
	preview.onRendered(syncEditorToPreview)

	return {
		enable,
		disable,
		/** Ignores scrolling in both panes for `ms`, so each can be scrolled on its own */
		hold: ms => {
			heldUntil = performance.now() + ms
		},
	}
}


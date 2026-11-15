// The GitHub renderer's preview: gh-gfm-preview's rendering in a shadow root,
// so its CSS neither leaks into markon nor inherits from it.
// Unchanged blocks keep their DOM as the text changes, so images, diagrams, math, and scroll position survive edits.
import { GfmEngine } from './engine.js'
import { GfmPage } from './page.js'
import { paletteScheme, previewStylesheet } from './palettes.js'
import { classifyReference, LOCAL_IMAGE_ATTRIBUTE, LOCAL_LINK_ATTRIBUTE, SOURCE_LINE_ATTRIBUTE } from './references.js'

/** Documents above this size render less often while they are edited */
const LARGE_DOCUMENT = 200_000
const RENDER_DELAY_MS = 30
const LARGE_RENDER_DELAY_MS = 250
const SOURCE_LINE_PATTERN = new RegExp(` ${SOURCE_LINE_ATTRIBUTE}="\\d+"`, 'g')

/** A node's identity for re-rendering: its HTML without its source line, which edits above it shift */
const nodeKey = node =>
	node instanceof Element ? node.outerHTML.replace(SOURCE_LINE_PATTERN, '') : `#${node.nodeType}:${node.textContent}`

/**
 * The preview scroll offset that shows source line `position` (1-based, fractional) at the top.
 * `anchors` are the rendered blocks in document order as `{ line, top }`;
 * `end` is the line after the document's last line at the bottom of the preview content.
 * Lines before the first block map from offset 0.
 */
const previewOffsetForLine = (anchors, position, end) => {
	const points = [{ line: 1, top: 0 }, ...anchors, end]
	for (let index = points.length - 2; index >= 0; index--) {
		const current = points[index]
		if (current.line > position) continue
		const next = points[index + 1]
		if (next.line <= current.line) return current.top
		const fraction = Math.min(1, (position - current.line) / (next.line - current.line))
		return current.top + fraction * (next.top - current.top)
	}
	return 0
}

/** The source line (1-based, fractional) at preview scroll offset `offset`; the inverse of previewOffsetForLine */
const lineForPreviewOffset = (anchors, offset, end) => {
	const points = [{ line: 1, top: 0 }, ...anchors, end]
	for (let index = points.length - 2; index >= 0; index--) {
		const current = points[index]
		if (current.top > offset) continue
		const next = points[index + 1]
		if (next.top <= current.top) return current.line
		const fraction = Math.min(1, (offset - current.top) / (next.top - current.top))
		return current.line + fraction * (next.line - current.line)
	}
	return 1
}

export class GfmPreview {
	keys = new WeakMap()
	/** The newest text to show, and the path of its document (null when unsaved) */
	text = null
	documentPath = null
	/** The newest render request, and the serial of the newest render shown */
	requested = null
	shownSerial = 0
	serial = 0
	/** The document whose rendering is shown; another document's rendering starts afresh */
	shownPath = undefined
	renderTimer = null

	/**
	 * `host` takes the shadow root. `actions`:
	 * - `imageUrl(reference, documentPath)`: a local image's URL, at once when cached, else a promise of it
	 * - `openLocal(target, documentPath)`: opens a local link target
	 * - `openExternal(url)`
	 * - `rendered()`: a render was shown; the preview's layout may have changed
	 */
	constructor(host, actions) {
		this.actions = actions
		this.engine = new GfmEngine()
		this.root = host.attachShadow({ mode: 'open' })
		this.style = document.createElement('style')
		this.scroller = document.createElement('div')
		this.scroller.className = 'gfm-root'
		this.status = document.createElement('div')
		this.status.className = 'gfm-status'
		this.status.textContent = 'Starting the GitHub renderer...'
		this.article = document.createElement('article')
		this.article.className = 'markdown-body'
		this.scroller.append(this.status, this.article)
		this.root.append(this.style, this.scroller)
		this.page = new GfmPage(this.engine, this.root)
		this.scroller.addEventListener('click', this.handleClick)
	}

	setPalette(palette, markonScheme) {
		const css = previewStylesheet(palette, markonScheme)
		if (this.style.textContent !== css) this.style.textContent = css
		this.page.setDark(paletteScheme(palette, markonScheme) === 'dark')
	}

	/** Shows `text`, the document at `documentPath` (null when unsaved), once typing pauses */
	setText(text, documentPath) {
		if (text === this.text && documentPath === this.documentPath) return
		const first = this.text === null
		this.text = text
		this.documentPath = documentPath
		clearTimeout(this.renderTimer)
		if (first) {
			this.render()
			return
		}
		const delay = text.length > LARGE_DOCUMENT ? LARGE_RENDER_DELAY_MS : RENDER_DELAY_MS
		this.renderTimer = setTimeout(() => this.render(), delay)
	}

	/**
	 * Rendered top-level blocks as `{ line, top }`, in document order, so lines map to offsets monotonically.
	 * Skipped: the footnote list, which gathers at the end under its first definition's line,
	 * and any other block rendered out of source order.
	 */
	anchors() {
		const anchors = []
		let last = 0
		for (const child of this.article.children) {
			const line = Number(child.getAttribute(SOURCE_LINE_ATTRIBUTE))
			if (!(line > last) || child.classList.contains('footnotes')) continue
			anchors.push({ line, top: child.offsetTop })
			last = line
		}
		return anchors
	}

	/**
	 * Scrolls so the editor's top line is at the top of the preview.
	 * `position`: `{ line, lineCount, atTop, atBottom }`, with `line` 1-based and fractional.
	 */
	follow(position) {
		const scroller = this.scroller
		const maximum = scroller.scrollHeight - scroller.clientHeight
		let target
		if (position.atTop) target = 0
		else if (position.atBottom) target = maximum
		else {
			const end = { line: position.lineCount + 1, top: scroller.scrollHeight }
			target = previewOffsetForLine(this.anchors(), position.line, end)
		}
		scroller.scrollTop = Math.max(0, Math.min(maximum, target))
	}

	/** The source line (1-based, fractional) at the top of the preview, of a document with `lineCount` lines */
	topLine(lineCount) {
		const end = { line: lineCount + 1, top: this.scroller.scrollHeight }
		return lineForPreviewOffset(this.anchors(), this.scroller.scrollTop, end)
	}

	/** Renders the current text; results arriving out of order never replace a newer one */
	render() {
		this.renderTimer = null
		const { text, documentPath } = this
		const requested = this.requested
		if (text === null || (text === requested?.text && documentPath === requested?.documentPath)) return
		const serial = ++this.serial
		this.requested = { text, documentPath, serial }
		this.engine.render(text).then(
			html => {
				if (serial < this.shownSerial) return
				this.shownSerial = serial
				this.status.hidden = true
				this.status.removeAttribute('data-error')
				const template = document.createElement('template')
				template.innerHTML = html
				this.patch(Array.from(template.content.childNodes), documentPath)
				this.actions.rendered()
			},
			error => {
				if (serial < this.shownSerial) return
				// The next edit tries again
				if (this.requested?.serial === serial) this.requested = null
				this.status.hidden = false
				this.status.setAttribute('data-error', '')
				this.status.textContent = `The GitHub renderer failed: ${error instanceof Error ? error.message : String(error)}`
			},
		)
	}

	/** Replaces only the changed run of top-level nodes between the unchanged head and tail */
	patch(next, documentPath) {
		if (documentPath !== this.shownPath) {
			// Another document: its relative images and links resolve elsewhere, so nothing shown is kept
			this.shownPath = documentPath
			const shown = Array.from(this.article.childNodes)
			this.page.release(shown)
			this.article.replaceChildren()
			this.scroller.scrollTop = 0
		}
		const current = Array.from(this.article.childNodes)
		const keyOf = node => {
			let key = this.keys.get(node)
			if (key === undefined) {
				key = nodeKey(node)
				this.keys.set(node, key)
			}
			return key
		}
		let head = 0
		while (head < current.length && head < next.length && keyOf(current[head]) === keyOf(next[head])) head++
		let tail = 0
		while (
			tail < current.length - head &&
			tail < next.length - head &&
			keyOf(current[current.length - 1 - tail]) === keyOf(next[next.length - 1 - tail])
		) {
			tail++
		}
		// Kept blocks take their new source lines
		const kept = current.slice(0, head).map((node, index) => [node, next[index]])
		for (let offset = 1; offset <= tail; offset++)
			kept.push([current[current.length - offset], next[next.length - offset]])
		for (const [node, replacement] of kept) {
			if (!(node instanceof Element && replacement instanceof Element)) continue
			const line = replacement.getAttribute(SOURCE_LINE_ATTRIBUTE)
			if (line !== null && node.getAttribute(SOURCE_LINE_ATTRIBUTE) !== line)
				node.setAttribute(SOURCE_LINE_ATTRIBUTE, line)
		}
		const reference = tail > 0 ? current[current.length - tail] : null
		const removed = current.slice(head, current.length - tail)
		this.page.release(removed)
		for (const node of removed) node.remove()
		const inserted = []
		for (const node of next.slice(head, next.length - tail)) {
			keyOf(node)
			this.article.insertBefore(node, reference)
			if (node instanceof Element) {
				this.loadImages(node, documentPath)
				inserted.push(node)
			}
		}
		this.page.enhance(inserted)
	}

	/** Shows every local image again; the cache has dropped the ones that changed on disk */
	reloadImages() {
		for (const image of this.article.querySelectorAll('img.gfm-image-error')) {
			image.classList.remove('gfm-image-error')
			image.removeAttribute('title')
		}
		this.loadImages(this.article, this.shownPath ?? null)
	}

	loadImages(root, documentPath) {
		const query = `img[${LOCAL_IMAGE_ATTRIBUTE}]`
		const images = root.matches(query) ? [root] : Array.from(root.querySelectorAll(query))
		for (const image of images) {
			const reference = image.getAttribute(LOCAL_IMAGE_ATTRIBUTE)
			if (!reference) continue
			const url = this.actions.imageUrl(reference, documentPath)
			if (typeof url === 'string') {
				image.setAttribute('src', url)
				continue
			}
			url.then(
				resolved => image.setAttribute('src', resolved),
				error => {
					// A deleted image stops showing its last version
					image.removeAttribute('src')
					image.classList.add('gfm-image-error')
					image.setAttribute('title', error instanceof Error ? error.message : String(error))
				},
			)
		}
	}

	handleClick = event => {
		const target = event.target instanceof Element ? event.target.closest('a') : null
		if (!target) return
		// Nothing in the preview may navigate markon's own window
		event.preventDefault()
		const local = target.getAttribute(LOCAL_LINK_ATTRIBUTE)
		if (local) {
			this.actions.openLocal(local, this.shownPath ?? null)
			return
		}
		const href = target.getAttribute('href') ?? ''
		const kind = classifyReference(href)
		if (kind === 'external') this.actions.openExternal(href)
		else if (kind === 'fragment') this.scrollToFragment(href.slice(1))
	}

	scrollToFragment(fragment) {
		let id = fragment
		try {
			id = decodeURIComponent(fragment)
		} catch {
			// Use the fragment as written
		}
		const escaped = CSS.escape(id)
		const target = this.article.querySelector(`[id="${escaped}"], [name="${escaped}"]`)
		if (!target) return
		const offset = target.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top
		this.scroller.scrollTop += offset - 8
	}
}

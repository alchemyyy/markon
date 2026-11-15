import { marked } from 'marked'
import morphdom from 'morphdom'
import { enhanceCallouts } from './callouts.js'
import { localImageUrl, onLocalImagesChanged, openLocalTarget } from './gfm/local-files.js'
import { getPalette, getRenderer, savePalette, saveRenderer } from './gfm/prefs.js'
import { classifyReference, isMarkdownPath } from './gfm/references.js'
import { isTauri, openExternal, openPathExternally } from './native.js'
import { highlightAll } from './syntax.js'

marked.setOptions({ gfm: true, breaks: true })

// The preview pane's two renderers:
// - markon: marked + highlight.js + callouts, morphed into #previewhtml
// - github: gh-gfm-preview in a shadow root on #preview-gfm (src/gfm/), loaded when first shown
// Only the chosen renderer follows the editor; the other keeps its last rendering, hidden.
export const setupPreview = ({ getMarkdown, onMarkdownUpdated, previewHtml, profiler, scrollToLine, showToast }) => {
	let renderScheduled = false
	let debounceTimer = null
	let lastRenderedContent = ''
	let lastRenderedPath = null

	const documentPath = () => window.docs?.getActive()?.path ?? null

	// Local images (relative to the document, absolute, `~/`, `file:`) load through Tauri as blob URLs.
	// The web build leaves them as written.
	const resolveLocalImages = (root, path) =>
		Promise.all(
			Array.from(root.querySelectorAll('img[src]')).map(async image => {
				const reference = image.getAttribute('src')
				if (classifyReference(reference) !== 'local') return
				image.removeAttribute('src')
				try {
					image.setAttribute('src', await localImageUrl(reference, path))
				} catch (error) {
					image.classList.add('local-image-error')
					image.title = error instanceof Error ? error.message : String(error)
				}
			}),
		)

	const render = async () => {
		const md = getMarkdown()
		const path = documentPath()

		// Skip render if content hasn't changed (a Save As changes only the path images resolve against)
		if (md === lastRenderedContent && path === lastRenderedPath) {
			profiler?.markRenderComplete()
			return
		}

		// Mark when actual rendering starts (after debouncing)
		profiler?.markRenderStart()

		// Parse into an inert template, so relative image URLs don't load against the app's own origin
		const template = document.createElement('template')
		template.innerHTML = marked.parse(md)
		if (isTauri()) await resolveLocalImages(template.content, path)
		const tempDiv = document.createElement('div')
		tempDiv.append(template.content)

		// Process callouts and highlighting on temp DOM
		enhanceCallouts(tempDiv)
		await highlightAll(tempDiv)

		// Use morphdom to efficiently update only changed elements
		morphdom(previewHtml, tempDiv, {
			childrenOnly: true, // Only morph children, not the container itself
			onBeforeElUpdated: (fromEl, toEl) => {
				// Preserve images that are already loaded to prevent re-fetching
				if (fromEl.tagName === 'IMG' && toEl.tagName === 'IMG') {
					if (fromEl.src === toEl.src && fromEl.complete) {
						// Keep the existing loaded image
						return false
					}
				}
				return true
			},
		})

		// Update last rendered content
		lastRenderedContent = md
		lastRenderedPath = path

		// Wait for actual paint to complete - this captures the real rendering time
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				profiler?.markRenderComplete()
			})
		})
	}

	const scheduleRender = () => {
		if (renderScheduled) return
		renderScheduled = true

		// Clear any existing debounce timer
		clearTimeout(debounceTimer)

		// Debounce rapid changes
		debounceTimer = setTimeout(() => {
			requestAnimationFrame(async () => {
				renderScheduled = false
				await render()
			})
		}, 50) // 50ms debounce for smooth typing
	}

	// GitHub renderer
	let renderer = getRenderer()
	let palette = getPalette()
	let gfm = null
	let gfmLoading = null
	let gfmShown = { text: null, path: null }
	const changeListeners = []
	const renderedListeners = []

	const gfmHost = document.createElement('div')
	gfmHost.id = 'preview-gfm'
	gfmHost.hidden = true
	previewHtml.after(gfmHost)

	// Links in markon's renderer: web links open in the default browser, local ones in markon;
	// nothing navigates markon's own window
	previewHtml.addEventListener('click', event => {
		const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
		if (!anchor) return
		const href = anchor.getAttribute('href')
		const kind = classifyReference(href)
		if (kind === 'fragment') return
		event.preventDefault()
		if (kind === 'external') openExternal(href)
		else if (kind === 'local') openLocal(href, documentPath())
	})

	const markonScheme = () => (document.documentElement.getAttribute('data-mode') === 'light' ? 'light' : 'dark')
	const applyPalette = () => gfm?.setPalette(palette, markonScheme())

	const showGfm = () => {
		if (!gfm) {
			loadGfm()
			return
		}
		const text = getMarkdown()
		const path = documentPath()
		if (text === gfmShown.text && path === gfmShown.path) return
		gfmShown = { text, path }
		profiler?.markRenderStart()
		gfm.setText(text, path)
	}

	const update = () => {
		if (renderer === 'github') showGfm()
		else scheduleRender()
	}

	const gfmRendered = () => {
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				profiler?.markRenderComplete()
			})
		})
		for (const fn of renderedListeners) fn()
	}

	const openLocal = async (target, fromPath) => {
		try {
			await openLocalTarget(target, fromPath, {
				// Markdown opens as a tab; anything else (PDFs, images, ...) in its default app
				openFile: async (path, line) => {
					if (!isMarkdownPath(path)) {
						await openPathExternally(path)
						return
					}
					const doc = await window.docs?.openPath(path)
					if (doc && line) scrollToLine?.(line)
				},
				openFolder: path => window.fileTree?.open(path),
			})
		} catch (error) {
			showToast?.(error instanceof Error ? error.message : String(error), 2000, 'tabler:alert-circle')
		}
	}

	const loadGfm = () => {
		gfmLoading ??= import('./gfm/preview.js').then(
			({ GfmPreview }) => {
				gfm = new GfmPreview(gfmHost, {
					imageUrl: localImageUrl,
					openLocal,
					openExternal,
					rendered: gfmRendered,
				})
				applyPalette()
				for (const fn of changeListeners) fn()
				update()
			},
			error => {
				gfmLoading = null
				console.error('GitHub renderer failed to load', error)
				showToast?.('GitHub renderer failed to load', 2000, 'tabler:alert-circle')
			},
		)
		return gfmLoading
	}

	const applyRenderer = () => {
		const github = renderer === 'github'
		previewHtml.hidden = github
		gfmHost.hidden = !github
		for (const fn of changeListeners) fn()
		update()
	}

	// The GitHub palette and Mermaid's theme follow markon's light or dark mode
	new MutationObserver(applyPalette).observe(document.documentElement, { attributeFilter: ['data-mode'] })

	applyRenderer()
	onMarkdownUpdated(update)
	// An image changed on disk: markon's renderer renders again (even if hidden, once shown),
	// the GitHub renderer reloads its images in place
	onLocalImagesChanged(() => {
		lastRenderedContent = null
		if (renderer === 'markon') scheduleRender()
		gfm?.reloadImages()
	})

	return {
		getRenderer: () => renderer,
		setRenderer: next => {
			if (next === renderer) return
			renderer = next
			saveRenderer(next)
			applyRenderer()
		},
		setPalette: next => {
			palette = next
			savePalette(next)
			applyPalette()
		},
		/** Shows the active document again; its path may have changed without its text */
		refresh: update,
		/** The GitHub renderer's preview while it is the one shown, else null */
		gfm: () => (renderer === 'github' ? gfm : null),
		/** The element holding the rendered document of the renderer shown, or null while it loads */
		contentRoot: () => (renderer === 'github' ? (gfm?.article ?? null) : previewHtml),
		/** The element scrolling the rendered document of the renderer shown, or null while it loads */
		scroller: () => (renderer === 'github' ? (gfm?.scroller ?? null) : previewHtml),
		/** `fn()` runs when the renderer shown, or its elements, change */
		onChange: fn => changeListeners.push(fn),
		/** `fn()` runs after the GitHub renderer shows a render */
		onRendered: fn => renderedListeners.push(fn),
	}
}

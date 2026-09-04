import { marked } from 'marked'
import morphdom from 'morphdom'
import { enhanceCallouts } from './callouts.js'
import {
	classifyReference,
	isMarkdownPath,
	normalizeExternalReference,
	REFERENCE_TYPE,
} from './link-targets.js'
import {
	convertPreviewAsset,
	isTauri,
	openExternalURL,
	openPathExternally,
	resolveLocalReference,
} from './native.js'
import { highlightAll } from './syntax.js'

marked.setOptions({ gfm: true, breaks: true })

const resolveLocalImages = async (container, documentPath) => {
	if (!isTauri()) return

	const images = Array.from(container.querySelectorAll('img[src]'))
	await Promise.all(
		images.map(async image => {
			const source = image.getAttribute('src')
			if (classifyReference(source) !== REFERENCE_TYPE.LOCAL) return

			try {
				const path = await resolveLocalReference(source, documentPath)
				if (!path) return
				const assetURL = await convertPreviewAsset(path)
				if (assetURL) image.setAttribute('src', assetURL)
			} catch (error) {
				console.warn('local preview image failed', error)
			}
		}),
	)
}

const setupLinkNavigation = ({ previewHtml, getDocumentPath, openDocumentPath, showToast }) => {
	previewHtml.addEventListener('click', async event => {
		if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return

		const anchor = event.target.closest('a[href]')
		if (!anchor || !previewHtml.contains(anchor)) return

		const reference = anchor.getAttribute('href')
		const referenceType = classifyReference(reference)
		if (referenceType === REFERENCE_TYPE.DOCUMENT) return
		if (!isTauri()) return

		event.preventDefault()
		try {
			switch (referenceType) {
				case REFERENCE_TYPE.EXTERNAL:
					await openExternalURL(normalizeExternalReference(reference))
					break
				case REFERENCE_TYPE.LOCAL: {
					const path = await resolveLocalReference(reference, getDocumentPath())
					if (!path) {
						showToast?.('save the document before opening relative links', 1800, 'tabler:alert-circle')
						return
					}
					if (isMarkdownPath(path)) await openDocumentPath(path)
					else await openPathExternally(path)
					break
				}
				default:
					showToast?.('unsupported link protocol', 1200, 'tabler:alert-circle')
			}
		} catch (error) {
			console.warn('preview link failed', error)
			showToast?.('could not open link', 1200, 'tabler:alert-circle')
		}
	})
}

export const setupPreview = ({
	getMarkdown,
	getDocumentPath,
	openDocumentPath,
	onDocumentChanged,
	onMarkdownUpdated,
	previewHtml,
	profiler,
	showToast,
}) => {
	let renderScheduled = false
	let debounceTimer = null
	let lastRenderedContent = ''
	let lastRenderedDocumentPath = null

	const render = async () => {
		const md = getMarkdown()
		const documentPath = getDocumentPath()

		// The same Markdown can resolve to different local resources in another folder
		if (md === lastRenderedContent && documentPath === lastRenderedDocumentPath) {
			profiler?.markRenderComplete()
			return
		}

		// Mark when actual rendering starts (after debouncing)
		profiler?.markRenderStart()

		// Create temporary container with new content
		const tempDiv = document.createElement('div')
		tempDiv.innerHTML = marked.parse(md)

		// Process callouts and highlighting on temp DOM
		enhanceCallouts(tempDiv)
		await highlightAll(tempDiv)
		await resolveLocalImages(tempDiv, documentPath)

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
			}
		})

		// Update last rendered content
		lastRenderedContent = md
		lastRenderedDocumentPath = documentPath

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

	// Initial render
	setupLinkNavigation({ previewHtml, getDocumentPath, openDocumentPath, showToast })
	scheduleRender()
	onDocumentChanged(scheduleRender)
	onMarkdownUpdated(scheduleRender)
}

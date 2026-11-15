// What gh-gfm-preview's page script (internal/server/static/script.js) does over the rendered HTML:
// - copy buttons on code blocks
// - Mermaid diagrams with pan, zoom, reset, and a full-pane view
// - GeoJSON and TopoJSON maps, drawn without gh-gfm-preview's online tile layer so the preview stays offline
// - MathJax
const MERMAID_QUERY = 'code.language-mermaid'
const GEOJSON_QUERY = 'code.language-geojson'
const TOPOJSON_QUERY = 'code.language-topojson'
const MAP_QUERY = `${GEOJSON_QUERY}, ${TOPOJSON_QUERY}`
const MERMAID_MIN_SCALE = 0.2
const MERMAID_MAX_SCALE = 5
const MERMAID_ZOOM_IN = 1.1
const MERMAID_ZOOM_OUT = 0.9
const MERMAID_OVERLAY_PADDING = 64
const COPIED_MS = 1000
const MAP_MAX_ZOOM = 19
const LOG_PREFIX = '[markon gfm]'

/** Mermaid needs a fresh element id for every render in the page */
let diagramSerial = 0
/** Delimiters gh-gfm-preview's MathJax configuration looks for */
const MATH_PATTERN = /\$|\\\(|\\\[/

const COPY_ICON = `<svg class="copy-icon" aria-hidden="true" fill="none" height="18" shape-rendering="geometricPrecision" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" width="18"><path d="M8 17.929H6c-1.105 0-2-.912-2-2.036V5.036C4 3.91 4.895 3 6 3h8c1.105 0 2 .911 2 2.036v1.866m-6 .17h8c1.105 0 2 .91 2 2.035v10.857C20 21.09 19.105 22 18 22h-8c-1.105 0-2-.911-2-2.036V9.107c0-1.124.895-2.036 2-2.036z"></path></svg>`
const TICK_ICON = `<svg class="tick-icon" aria-hidden="true" fill="none" height="18" shape-rendering="geometricPrecision" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" viewBox="0 0 24 24" width="18"><path d="M5 13l4 4L19 7"></path></svg>`
const EXPAND_ICON = `<svg class="expand-icon" aria-hidden="true" viewBox="0 0 1792 1792" width="14" height="14" fill="currentColor"><path d="M883 1056q0 13-10 23l-332 332 144 144q19 19 19 45t-19 45-45 19h-448q-26 0-45-19t-19-45v-448q0-26 19-45t45-19 45 19l144 144 332-332q10-10 23-10t23 10l114 114q10 10 10 23zm781-864v448q0 26-19 45t-45 19-45-19l-144-144-332 332q-10 10-23 10t-23-10l-114-114q-10-10-10-23t10-23l332-332-144-144q-19-19-19-45t19-45 45-19h448q26 0 45 19t19 45z"></path></svg>`

/** Wheel zoom and drag pan for an SVG inside `element` */
const attachPanZoom = (element, svg) => {
	const state = { dragging: false, lastX: 0, lastY: 0, scale: 1, tx: 0, ty: 0 }
	const apply = () => {
		svg.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`
	}
	const onWheel = event => {
		const rect = element.getBoundingClientRect()
		const factor = event.deltaY < 0 ? MERMAID_ZOOM_IN : MERMAID_ZOOM_OUT
		const x = event.clientX - rect.left
		const y = event.clientY - rect.top
		const scale = Math.max(MERMAID_MIN_SCALE, Math.min(MERMAID_MAX_SCALE, state.scale * factor))
		event.preventDefault()
		if (scale === state.scale) return
		state.tx = x - (x - state.tx) * (scale / state.scale)
		state.ty = y - (y - state.ty) * (scale / state.scale)
		state.scale = scale
		apply()
	}
	const onPointerDown = event => {
		if (event.button !== 0) return
		state.dragging = true
		state.lastX = event.clientX
		state.lastY = event.clientY
		element.style.cursor = 'grabbing'
		element.setPointerCapture(event.pointerId)
		event.preventDefault()
	}
	const onPointerMove = event => {
		if (!state.dragging) return
		state.tx += event.clientX - state.lastX
		state.ty += event.clientY - state.lastY
		state.lastX = event.clientX
		state.lastY = event.clientY
		apply()
	}
	const onPointerUp = () => {
		if (!state.dragging) return
		state.dragging = false
		element.style.cursor = 'grab'
	}
	element.addEventListener('wheel', onWheel, { passive: false })
	element.addEventListener('pointerdown', onPointerDown)
	element.addEventListener('pointermove', onPointerMove)
	element.addEventListener('pointerup', onPointerUp)
	element.addEventListener('pointercancel', onPointerUp)
	return {
		state,
		apply,
		detach() {
			element.removeEventListener('wheel', onWheel)
			element.removeEventListener('pointerdown', onPointerDown)
			element.removeEventListener('pointermove', onPointerMove)
			element.removeEventListener('pointerup', onPointerUp)
			element.removeEventListener('pointercancel', onPointerUp)
		},
	}
}

const button = (doc, className, label) => {
	const element = doc.createElement('button')
	element.type = 'button'
	element.className = className
	element.setAttribute('aria-label', label)
	return element
}

/** The elements under `nodes` (themselves included) that match `query` */
const matching = (nodes, query) =>
	nodes.flatMap(node => [...(node.matches(query) ? [node] : []), ...node.querySelectorAll(query)])

/** gh-gfm-preview's reading of a GeoJSON or TopoJSON block as one feature collection */
const mapFeatures = (code, isTopoJson, topojson) => {
	const parsed = JSON.parse(code)
	if (!parsed || typeof parsed !== 'object') throw new Error('Geo data is not an object')
	let features
	if (isTopoJson) {
		const objects = parsed.objects && typeof parsed.objects === 'object' ? Object.values(parsed.objects) : []
		if (objects.length === 0) throw new Error('TopoJSON does not contain any objects')
		features = objects.flatMap(object => {
			const converted = topojson.feature(parsed, object)
			return converted.type === 'FeatureCollection' ? (converted.features ?? []) : [converted]
		})
	} else if (parsed.type === 'FeatureCollection') {
		features = Array.isArray(parsed.features) ? parsed.features : []
	} else if (parsed.type === 'Feature') {
		features = [parsed]
	} else {
		features = [{ type: 'Feature', geometry: parsed, properties: {} }]
	}
	if (features.length === 0) throw new Error('Geo data does not contain any features')
	return { type: 'FeatureCollection', features }
}

export class GfmPage {
	maps = new Map()
	/** Pan and zoom of each diagram, replaced when the diagram renders again */
	panZooms = new WeakMap()
	mathStyle = null
	leafletStyle = null
	dark = false
	closeOverlay = null

	constructor(engine, root) {
		this.engine = engine
		this.root = root
		this.overlay = root.ownerDocument.createElement('div')
		this.overlay.className = 'mermaid-overlay'
		this.overlay.setAttribute('role', 'dialog')
		this.overlay.setAttribute('aria-modal', 'true')
		this.overlay.setAttribute('aria-label', 'Diagram full view')
		root.appendChild(this.overlay)
	}

	/** Runs the page script over blocks just inserted into the preview */
	enhance(nodes) {
		if (nodes.length === 0) return
		const diagrams = matching(nodes, MERMAID_QUERY)
		const maps = matching(nodes, MAP_QUERY)
		for (const code of [...diagrams, ...maps]) {
			const original = code.textContent ?? ''
			code.setAttribute('data-original-code', original)
			code.closest('pre')?.setAttribute('data-copy-content', original)
		}
		this.addCopyButtons(matching(nodes, 'pre'))
		if (diagrams.length > 0) this.renderDiagrams(diagrams)
		if (maps.length > 0) this.renderMaps(maps)
		if (nodes.some(node => MATH_PATTERN.test(node.textContent ?? ''))) this.typesetMath(nodes)
	}

	/** Frees what the page script attached to blocks leaving the preview */
	release(nodes) {
		const elements = nodes.filter(node => node instanceof Element)
		for (const code of matching(elements, MAP_QUERY)) {
			this.maps.get(code)?.remove()
			this.maps.delete(code)
		}
		if (this.mathStyle && elements.length > 0) {
			this.engine.mathjax().then(mathjax => mathjax.typesetClear(elements))
		}
	}

	/** Diagrams follow the palette's light or dark scheme, re-rendering when it changes */
	setDark(dark) {
		if (dark === this.dark) return
		this.dark = dark
		const diagrams = Array.from(this.root.querySelectorAll(`${MERMAID_QUERY}[data-original-code]`))
		if (diagrams.length > 0) this.renderDiagrams(diagrams)
	}

	addCopyButtons(blocks) {
		for (const pre of blocks) {
			const code = pre.querySelector('code')
			if (!code || pre.querySelector('.copy-button')) continue
			const copy = button(pre.ownerDocument, 'copy-button', 'Copy code to clipboard')
			copy.innerHTML = COPY_ICON
			pre.style.position = 'relative'
			pre.appendChild(copy)
			copy.addEventListener('click', () => {
				const text = pre.getAttribute('data-copy-content') ?? code.textContent ?? ''
				navigator.clipboard?.writeText(text).then(() => {
					copy.innerHTML = TICK_ICON
					setTimeout(() => {
						copy.innerHTML = COPY_ICON
					}, COPIED_MS)
				})
			})
		}
	}

	async renderDiagrams(diagrams) {
		let mermaid
		try {
			mermaid = await this.engine.mermaid()
		} catch (error) {
			console.error(LOG_PREFIX, 'Mermaid did not load', error)
			return
		}
		// Mermaid's theme is global; each batch sets the one the preview shows
		mermaid.initialize({ startOnLoad: false, theme: this.dark ? 'dark' : 'default' })
		for (const code of diagrams) {
			if (!code.isConnected) continue
			const text = code.getAttribute('data-original-code') ?? ''
			// mermaid.run would render inside the preview's shadow root,
			// where Mermaid's d3 selections (which search the document) cannot reach;
			// render() works in the document and returns SVG
			try {
				const { svg, bindFunctions } = await mermaid.render(`gfm-mermaid-${++diagramSerial}`, text)
				if (!code.isConnected) continue
				code.innerHTML = svg
				bindFunctions?.(code)
				code.setAttribute('data-processed', 'true')
				this.setupPanZoom(code)
			} catch (error) {
				// gh-gfm-preview logs and leaves the diagram's code in place
				console.error(LOG_PREFIX, 'Mermaid could not render a diagram', error)
				code.textContent = text
			}
		}
	}

	setupPanZoom(code) {
		const svg = code.querySelector('svg')
		if (!svg || svg.hasAttribute('data-panzoom')) return
		const pre = code.closest('pre')
		this.panZooms.get(code)?.detach()
		const panZoom = attachPanZoom(code, svg)
		this.panZooms.set(code, panZoom)
		svg.setAttribute('data-panzoom', 'true')
		svg.style.transformOrigin = '0 0'
		svg.style.display = 'block'
		code.classList.add('diagram-mermaid-code')
		if (!pre) return
		pre.classList.add('diagram-mermaid-pre')
		pre.style.position = 'relative'
		pre.querySelector('.mermaid-reset-btn')?.remove()
		pre.querySelector('.mermaid-expand-btn')?.remove()
		const reset = button(pre.ownerDocument, 'mermaid-reset-btn', 'Reset diagram view')
		reset.textContent = 'Reset'
		reset.addEventListener('click', () => {
			Object.assign(panZoom.state, { scale: 1, tx: 0, ty: 0 })
			panZoom.apply()
		})
		const expand = button(pre.ownerDocument, 'mermaid-expand-btn', 'Expand diagram to the full preview')
		expand.innerHTML = EXPAND_ICON
		expand.addEventListener('click', () => this.openOverlay(svg))
		pre.append(reset, expand)
	}

	/** The diagram over the whole preview, with its own pan and zoom; Escape or the close button closes it */
	openOverlay(original) {
		this.closeOverlay?.()
		const doc = this.overlay.ownerDocument
		const svg = original.cloneNode(true)
		svg.removeAttribute('data-panzoom')
		svg.style.transform = ''
		svg.style.transformOrigin = '0 0'
		svg.style.display = 'block'
		const inner = doc.createElement('div')
		inner.className = 'mermaid-overlay-inner'
		inner.appendChild(svg)
		const close = button(doc, 'mermaid-overlay-close', 'Close full view')
		close.textContent = '\u00d7'
		const reset = button(doc, 'mermaid-reset-btn', 'Reset diagram view')
		reset.textContent = 'Reset'
		this.overlay.replaceChildren(inner, close, reset)
		const panZoom = attachPanZoom(inner, svg)
		this.overlay.classList.add('is-open')
		const innerRect = inner.getBoundingClientRect()
		const svgRect = svg.getBoundingClientRect()
		if (svgRect.width > 0 && svgRect.height > 0) {
			const fit = Math.min(
				1,
				(innerRect.width - MERMAID_OVERLAY_PADDING) / svgRect.width,
				(innerRect.height - MERMAID_OVERLAY_PADDING) / svgRect.height,
			)
			Object.assign(panZoom.state, {
				scale: fit,
				tx: (innerRect.width - svgRect.width * fit) / 2,
				ty: (innerRect.height - svgRect.height * fit) / 2,
			})
			panZoom.apply()
		}
		const initial = { ...panZoom.state }
		const onKeyDown = event => {
			if (event.key === 'Escape') this.closeOverlay?.()
		}
		this.closeOverlay = () => {
			this.overlay.classList.remove('is-open')
			this.overlay.replaceChildren()
			doc.removeEventListener('keydown', onKeyDown)
			panZoom.detach()
			this.closeOverlay = null
		}
		reset.addEventListener('click', () => {
			Object.assign(panZoom.state, initial)
			panZoom.apply()
		})
		close.addEventListener('click', () => this.closeOverlay?.())
		doc.addEventListener('keydown', onKeyDown)
	}

	async renderMaps(codes) {
		let library
		try {
			library = await this.engine.leaflet()
		} catch (error) {
			console.error(LOG_PREFIX, 'Leaflet did not load', error)
			return
		}
		if (!this.leafletStyle) {
			this.leafletStyle = this.root.ownerDocument.createElement('style')
			this.leafletStyle.textContent = library.leafletCss
			this.root.prepend(this.leafletStyle)
		}
		for (const code of codes) {
			if (!code.isConnected || this.maps.has(code)) continue
			try {
				this.renderMap(code, library)
			} catch (error) {
				console.error(LOG_PREFIX, 'Could not draw a map', error)
			}
		}
	}

	renderMap(code, { leaflet, topojson }) {
		const source = code.getAttribute('data-original-code') ?? code.textContent ?? ''
		const features = mapFeatures(source, code.matches(TOPOJSON_QUERY), topojson)
		const container = code.ownerDocument.createElement('div')
		code.closest('pre')?.classList.add('diagram-map-pre')
		code.classList.add('diagram-map-code')
		container.className = 'leaflet-diagram-map'
		code.replaceChildren(container)
		code.setAttribute('data-processed', 'true')
		// gh-gfm-preview's tile layer caps zoom at 19; without tiles, a lone point would fit at an infinite zoom
		const map = leaflet.map(container, {
			attributionControl: false,
			maxZoom: MAP_MAX_ZOOM,
			scrollWheelZoom: false,
			zoomControl: true,
		})
		this.maps.set(code, map)
		// The palette's accent, which Leaflet needs as a value rather than a variable
		const accent = getComputedStyle(code).getPropertyValue('--fgColor-accent').trim() || '#1f6feb'
		const layer = leaflet
			.geoJSON(features, {
				pointToLayer: (_feature, latlng) =>
					leaflet.circleMarker(latlng, {
						color: accent,
						fillColor: accent,
						fillOpacity: 0.8,
						opacity: 1,
						radius: 6,
						weight: 2,
					}),
				style: feature => ({
					color: accent,
					fillColor: accent,
					fillOpacity: feature?.geometry?.type?.includes('Polygon') ? 0.22 : 0,
					opacity: 0.9,
					weight: 2,
				}),
			})
			.addTo(map)
		const bounds = layer.getBounds()
		if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] })
		else map.setView([20, 0], 1)
	}

	async typesetMath(nodes) {
		let mathjax
		try {
			mathjax = await this.engine.mathjax()
		} catch (error) {
			console.error(LOG_PREFIX, 'MathJax did not load', error)
			return
		}
		if (!this.mathStyle) {
			// MathJax puts its SVG stylesheet in the document head, which the shadow root does not see
			this.mathStyle = this.root.ownerDocument.createElement('style')
			this.mathStyle.textContent = mathjax.svgStylesheet().textContent
			this.root.prepend(this.mathStyle)
		}
		try {
			await mathjax.typesetPromise(nodes.filter(node => node.isConnected))
		} catch (error) {
			console.error(LOG_PREFIX, 'MathJax could not typeset', error)
		}
	}
}

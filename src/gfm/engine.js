// The GitHub renderer's engine:
// - gh-gfm-preview's renderer (Go, built for WebAssembly by scripts/gfm/vendor.mjs) in a worker,
//   so rendering never stalls typing
// - the Mermaid, MathJax, Leaflet, and TopoJSON code gh-gfm-preview's page runs over its HTML
// Every file ships gzipped in src/gfm/vendor/ and loads on first use, so the renderer works offline.

import { sanitizeHtml, splitFrontMatter } from './sanitize.js'
import gfmWasmUrl from './vendor/gfm.wasm.gz?url'
import leafletCssUrl from './vendor/leaflet.css.gz?url'
import leafletUrl from './vendor/leaflet.js.gz?url'
import mathjaxUrl from './vendor/mathjax.js.gz?url'
import mathjaxExtensionsUrl from './vendor/mathjax-extensions.json.gz?url'
import mermaidUrl from './vendor/mermaid.js.gz?url'
import topojsonUrl from './vendor/topojson.js.gz?url'
import wasmExecUrl from './vendor/wasm_exec.js.gz?url'

const ASSET_URLS = {
	'gfm.wasm': gfmWasmUrl,
	'wasm_exec.js': wasmExecUrl,
	'mathjax.js': mathjaxUrl,
	'mathjax-extensions.json': mathjaxExtensionsUrl,
	'mermaid.js': mermaidUrl,
	'leaflet.js': leafletUrl,
	'leaflet.css': leafletCssUrl,
	'topojson.js': topojsonUrl,
}

// Runs in the worker, after Go's wasm_exec.js has defined Go
const WORKER_MAIN = `
"use strict";
let ready = null;
self.onmessage = (event) => {
	const message = event.data;
	if (message.type === "start") {
		const go = new Go();
		ready = WebAssembly.instantiate(message.module, go.importObject).then((instance) => {
			go.run(instance);
		});
		return;
	}
	ready.then(
		() => {
			try {
				const result = self.markonGfmRender(message.markdown, message.lineOffset);
				self.postMessage({ id: message.id, html: result.html, error: result.error });
			} catch (error) {
				// A panic ends the Go program; the engine starts a new worker
				self.postMessage({ id: message.id, error: String((error && error.message) || error), fatal: true });
			}
		},
		(error) => self.postMessage({ id: message.id, error: String((error && error.message) || error), fatal: true }),
	);
};
`

/**
 * The bytes of one vendored file, decompressed.
 * Some servers (Vite's dev server among them) send `.gz` files with `Content-Encoding: gzip`,
 * so the browser has already decompressed them; only bytes still starting with gzip's magic number are inflated.
 */
const fetchAsset = async name => {
	const response = await fetch(ASSET_URLS[name])
	if (!response.ok) throw new Error(`The GitHub renderer could not load ${name} (HTTP ${response.status})`)
	const bytes = new Uint8Array(await response.arrayBuffer())
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer
	return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
}

/**
 * Runs library code as a classic page script, as gh-gfm-preview's page loads it.
 * Top-level declarations become globals even under "use strict", which eval would keep to itself.
 */
const evaluate = source => {
	const script = document.createElement('script')
	script.textContent = source
	document.head.appendChild(script)
	script.remove()
}

/** A global a library defines when it runs */
const libraryGlobal = name => {
	const value = Reflect.get(globalThis, name)
	if (value === undefined || value === null) throw new Error(`The GitHub renderer's ${name} library did not load`)
	return value
}

/** Window-wide libraries, each loaded once; a failed load is tried again on next use */
const libraries = {}

const library = (key, load) => {
	const cached = libraries[key]
	if (cached) return cached
	const loading = load()
	libraries[key] = loading
	loading.catch(() => {
		if (libraries[key] === loading) delete libraries[key]
	})
	return loading
}

export class GfmEngine {
	files = new Map()
	module = null
	worker = null
	pending = new Map()
	nextId = 0

	/** Sanitized HTML for a Markdown document, front matter included, blocks marked with their source lines */
	async render(markdown) {
		const frontMatter = splitFrontMatter(markdown)
		const html = await this.renderInWorker(frontMatter?.body ?? markdown, frontMatter?.lineOffset ?? 0)
		return sanitizeHtml((frontMatter?.html ?? '') + html)
	}

	/** Mermaid, as gh-gfm-preview's page loads it */
	mermaid() {
		return library('mermaid', () =>
			this.text('mermaid.js').then(source => {
				evaluate(source)
				return libraryGlobal('mermaid')
			}),
		)
	}

	/**
	 * MathJax with TeX input and SVG output, configured as gh-gfm-preview configures it.
	 * SVG keeps glyphs inside each formula, so math renders in a shadow root without web fonts.
	 * TeX extensions load from the vendored set as the autoloader asks for them.
	 */
	mathjax() {
		return library('mathjax', () =>
			Promise.all([this.text('mathjax.js'), this.text('mathjax-extensions.json')]).then(async ([source, json]) => {
				const extensions = JSON.parse(json)
				Reflect.set(globalThis, 'MathJax', {
					loader: {
						paths: { mathjax: 'mathjax' },
						require: path => {
							const name = /input\/tex\/extensions\/([\w-]+\.js)$/.exec(path)?.[1]
							const extension = name ? extensions[name] : undefined
							if (extension === undefined) return Promise.reject(new Error(`MathJax: ${path} is not available offline`))
							evaluate(extension)
							return Promise.resolve()
						},
					},
					tex: {
						inlineMath: [
							['$', '$'],
							['\\(', '\\)'],
						],
						displayMath: [
							['$$', '$$'],
							['\\[', '\\]'],
						],
					},
					svg: { fontCache: 'local' },
					startup: { typeset: false },
				})
				evaluate(source)
				const mathjax = libraryGlobal('MathJax')
				await mathjax.startup.promise
				return mathjax
			}),
		)
	}

	/** Leaflet with its stylesheet, and TopoJSON, for GeoJSON and TopoJSON maps */
	leaflet() {
		return library('leaflet', () =>
			Promise.all([this.text('leaflet.js'), this.text('leaflet.css'), this.text('topojson.js')]).then(
				([leafletSource, leafletCss, topojsonSource]) => {
					evaluate(leafletSource)
					evaluate(topojsonSource)
					return { leaflet: libraryGlobal('L'), leafletCss, topojson: libraryGlobal('topojson') }
				},
			),
		)
	}

	file(name) {
		let file = this.files.get(name)
		if (!file) {
			file = fetchAsset(name)
			// A failed fetch is retried on next use
			file.catch(() => this.files.delete(name))
			this.files.set(name, file)
		}
		return file
	}

	async text(name) {
		return new TextDecoder().decode(await this.file(name))
	}

	renderInWorker(markdown, lineOffset) {
		const id = ++this.nextId
		const reply = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
		this.worker ??= this.startWorker()
		this.worker.then(
			worker => worker.postMessage({ type: 'render', id, markdown, lineOffset }),
			error => this.settle({ id, error: error instanceof Error ? error.message : String(error), fatal: true }),
		)
		return reply
	}

	async startWorker() {
		if (!this.module) {
			const compiling = this.file('gfm.wasm').then(bytes => WebAssembly.compile(bytes))
			// A failed compile is retried with the next worker
			compiling.catch(() => {
				if (this.module === compiling) this.module = null
			})
			this.module = compiling
		}
		const [module, loader] = await Promise.all([this.module, this.text('wasm_exec.js')])
		const url = URL.createObjectURL(new Blob([loader, WORKER_MAIN], { type: 'text/javascript' }))
		const worker = new Worker(url)
		worker.onmessage = event => this.settle(event.data)
		worker.onerror = event => {
			event.preventDefault()
			this.restart(event.message || "The GitHub renderer's worker failed")
		}
		// The compiled module is shared with the worker, not copied
		worker.postMessage({ type: 'start', module })
		// The worker has read its script once it answers; the URL is not needed after that
		const revoke = () => URL.revokeObjectURL(url)
		worker.addEventListener('message', revoke, { once: true })
		worker.addEventListener('error', revoke, { once: true })
		return worker
	}

	settle(reply) {
		const request = this.pending.get(reply.id)
		this.pending.delete(reply.id)
		if (reply.fatal) this.restart(null)
		if (!request) return
		if (reply.error !== undefined || reply.html === undefined) request.reject(new Error(reply.error ?? 'No output'))
		else request.resolve(reply.html)
	}

	/** Drops a broken worker; the next render starts another. `failure` rejects the renders it held. */
	restart(failure) {
		const broken = this.worker
		this.worker = null
		broken?.then(worker => worker.terminate()).catch(() => {})
		if (failure === null) return
		for (const request of this.pending.values()) request.reject(new Error(failure))
		this.pending.clear()
	}
}

// Colors for the GitHub renderer; type and layout stay gh-gfm-preview's.
// Its page is github-markdown-css's rules and chroma's code colors, and the palette supplies every color they read.
// The markon palette reads markon's theme variables, which reach the preview's shadow root through inheritance,
// so it follows theme changes without re-rendering.
import { CHROMA_GITHUB_DARK, CHROMA_GITHUB_LIGHT, CHROMA_PALETTE } from './vendor/chroma.js'
import {
	GITHUB_BASE_VARIABLES,
	GITHUB_DARK_VARIABLES,
	GITHUB_LIGHT_VARIABLES,
	GITHUB_MARKDOWN_RULES,
} from './vendor/github-markdown.js'

/** Variables the GitHub renderer's rules read beyond those github-markdown-css defines */
const BASE_VARIABLES = {
	// github-markdown-css names this stack only as a var() fallback
	'--fontStack-sansSerif':
		'-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
	'--gfm-table-header-bg': 'transparent',
}

/**
 * Taiga Oak: dark oak heartwood and parchment, moss-green accents, weathered-oak rules.
 * Background #251b13, foreground #f3e9d8, raised #36281b, control #2c3a25,
 * border #664b33, accent #6f9f55, muted #cfb795, ring #9c7552.
 */
const TAIGA_OAK_VARIABLES = {
	'color-scheme': 'dark',
	'--bgColor-default': '#251b13',
	'--bgColor-muted': '#36281b',
	'--bgColor-neutral-muted': '#664b3366',
	'--bgColor-attention-muted': '#9c755240',
	'--bgColor-danger-muted': '#d9734e26',
	'--fgColor-default': '#f3e9d8',
	'--fgColor-muted': '#cfb795',
	'--fgColor-accent': '#8fbd74',
	'--fgColor-attention': '#d9a441',
	'--fgColor-danger': '#e08a6d',
	'--fgColor-done': '#b39ad1',
	'--fgColor-success': '#8fbd74',
	'--borderColor-default': '#664b33',
	'--borderColor-muted': '#664b33b3',
	'--borderColor-neutral-muted': '#664b33b3',
	'--borderColor-accent-emphasis': '#6f9f55',
	'--borderColor-attention-emphasis': '#c08a2e',
	'--borderColor-danger-emphasis': '#c8603d',
	'--borderColor-done-emphasis': '#9077b5',
	'--borderColor-success-emphasis': '#6f9f55',
	'--focus-outlineColor': '#9c7552',
	'--color-prettylights-syntax-comment': '#9c7552',
	'--color-prettylights-syntax-constant': '#e0b46c',
	'--color-prettylights-syntax-constant-other-reference-link': '#a9c97f',
	'--color-prettylights-syntax-entity': '#e8c992',
	'--color-prettylights-syntax-entity-tag': '#8fbd74',
	'--color-prettylights-syntax-keyword': '#d9885a',
	'--color-prettylights-syntax-string': '#a9c97f',
	'--color-prettylights-syntax-string-regexp': '#c9d98a',
	'--color-prettylights-syntax-variable': '#e0a46c',
	'--color-prettylights-syntax-markup-heading': '#8fbd74',
	'--color-prettylights-syntax-markup-list': '#e0b46c',
	'--color-prettylights-syntax-markup-bold': '#f3e9d8',
	'--color-prettylights-syntax-markup-italic': '#f3e9d8',
	'--color-prettylights-syntax-storage-modifier-import': '#f3e9d8',
	'--color-prettylights-syntax-markup-inserted-text': '#bfe0a4',
	'--color-prettylights-syntax-markup-inserted-bg': '#2c3a25',
	'--color-prettylights-syntax-markup-deleted-text': '#f2b8a2',
	'--color-prettylights-syntax-markup-deleted-bg': '#4a2418',
	'--color-prettylights-syntax-markup-changed-text': '#f0d39a',
	'--color-prettylights-syntax-markup-changed-bg': '#4a3514',
	'--color-prettylights-syntax-meta-diff-range': '#b39ad1',
	'--color-prettylights-syntax-brackethighlighter-angle': '#cfb795',
	'--color-prettylights-syntax-brackethighlighter-unmatched': '#e08a6d',
	'--color-prettylights-syntax-invalid-illegal-text': '#e08a6d',
	'--color-prettylights-syntax-invalid-illegal-bg': '#4a2418',
	'--gfm-table-header-bg': '#2c3a25',
}

const tint = (variable, percent) => `color-mix(in srgb, var(${variable}) ${percent}%, transparent)`

/**
 * markon's theme colors (themes.css) under GitHub's names.
 * Code colors follow markon's github theme, which maps GitHub's syntax colors onto markon's variables.
 */
const MARKON_VARIABLES = {
	'--bgColor-default': 'var(--bg)',
	'--bgColor-muted': 'var(--bg-light)',
	'--bgColor-neutral-muted': tint('--text', 12),
	'--bgColor-attention-muted': tint('--warning', 20),
	'--bgColor-danger-muted': tint('--error', 15),
	'--fgColor-default': 'var(--text)',
	'--fgColor-muted': 'var(--comment)',
	'--fgColor-accent': 'var(--accent)',
	'--fgColor-attention': 'var(--warning)',
	'--fgColor-danger': 'var(--error)',
	'--fgColor-done': 'var(--primary)',
	'--fgColor-success': 'var(--success)',
	'--borderColor-default': tint('--text', 22),
	'--borderColor-muted': tint('--text', 14),
	'--borderColor-neutral-muted': tint('--text', 14),
	'--borderColor-accent-emphasis': 'var(--accent)',
	'--borderColor-attention-emphasis': 'var(--warning)',
	'--borderColor-danger-emphasis': 'var(--error)',
	'--borderColor-done-emphasis': 'var(--primary)',
	'--borderColor-success-emphasis': 'var(--success)',
	'--focus-outlineColor': 'var(--accent)',
	'--color-prettylights-syntax-comment': 'var(--comment)',
	'--color-prettylights-syntax-constant': 'var(--property)',
	'--color-prettylights-syntax-constant-other-reference-link': 'var(--string)',
	'--color-prettylights-syntax-entity': 'var(--literal)',
	'--color-prettylights-syntax-entity-tag': 'var(--secondary)',
	'--color-prettylights-syntax-keyword': 'var(--keyword)',
	'--color-prettylights-syntax-string': 'var(--string)',
	'--color-prettylights-syntax-string-regexp': 'var(--regex)',
	'--color-prettylights-syntax-variable': 'var(--meta)',
	'--color-prettylights-syntax-markup-heading': 'var(--accent)',
	'--color-prettylights-syntax-markup-list': 'var(--warning)',
	'--color-prettylights-syntax-markup-bold': 'var(--text)',
	'--color-prettylights-syntax-markup-italic': 'var(--text)',
	'--color-prettylights-syntax-storage-modifier-import': 'var(--text)',
	'--color-prettylights-syntax-markup-inserted-text': 'var(--success)',
	'--color-prettylights-syntax-markup-inserted-bg': tint('--success', 15),
	'--color-prettylights-syntax-markup-deleted-text': 'var(--error)',
	'--color-prettylights-syntax-markup-deleted-bg': tint('--error', 15),
	'--color-prettylights-syntax-markup-changed-text': 'var(--warning)',
	'--color-prettylights-syntax-markup-changed-bg': tint('--warning', 15),
	'--color-prettylights-syntax-meta-diff-range': 'var(--primary)',
	'--color-prettylights-syntax-brackethighlighter-angle': 'var(--comment)',
	'--color-prettylights-syntax-brackethighlighter-unmatched': 'var(--error)',
	'--color-prettylights-syntax-invalid-illegal-text': 'var(--error)',
	'--color-prettylights-syntax-invalid-illegal-bg': tint('--error', 15),
	'--gfm-table-header-bg': 'var(--bg-light)',
}

// The scroll container and gh-gfm-preview's page layout (internal/server/template.html):
// a 920px reading column with 45px padding, 15px on narrow panes
const FRAME_RULES = `
:host { all: initial; display: block; }
.gfm-root {
  position: absolute; inset: 0; overflow: auto; box-sizing: border-box; container-type: inline-size;
  background-color: var(--bgColor-default); color: var(--fgColor-default);
}
.gfm-root > .markdown-body {
  box-sizing: border-box; min-width: 200px; max-width: 920px; margin: 0 auto; padding: 45px;
}
@container (max-width: 767px) { .gfm-root > .markdown-body { padding: 15px; } }
.gfm-status { padding: 45px; color: var(--fgColor-muted); font: 14px var(--fontStack-sansSerif); }
.gfm-status[data-error] { color: var(--fgColor-danger); white-space: pre-wrap; }
.markdown-body table th { background-color: var(--gfm-table-header-bg); }
.markdown-body img[data-gfm-src]:not([src]) { min-width: 16px; min-height: 16px; }
.markdown-body .gfm-image-error { outline: 1px dashed var(--fgColor-danger); }
::highlight(markon-find) { background-color: color-mix(in srgb, var(--warning) 35%, transparent); }
::highlight(markon-find-current) { background-color: color-mix(in srgb, var(--accent) 60%, transparent); }
`

// gh-gfm-preview's page controls (internal/server/template.html),
// with its fixed dark and light colors replaced by the palette's,
// and the full view's Reset at the bottom left, clear of markon's TOC button
const PAGE_RULES = `
.markdown-body code.language-mermaid br { display: inline; }
.markdown-body .copy-button {
  background-color: transparent; border: none; position: absolute; top: 8px; right: 8px; z-index: 1;
  border-radius: 5px; padding: 5px; line-height: 0; cursor: pointer;
}
.markdown-body .copy-button svg.copy-icon { stroke: var(--fgColor-muted); }
.markdown-body .copy-button svg.tick-icon { stroke: var(--fgColor-success); }
.markdown-body pre.diagram-mermaid-pre { padding: 0; overflow: hidden; }
.markdown-body pre.diagram-mermaid-pre > code.diagram-mermaid-code {
  display: block; padding: 0; background: transparent; overflow: hidden; cursor: grab;
  touch-action: none; user-select: none;
}
.mermaid-reset-btn {
  background-color: transparent; border: 1px solid var(--borderColor-default); bottom: 8px;
  border-radius: 5px; color: var(--fgColor-muted); cursor: pointer; font-size: 12px; line-height: 1.4;
  padding: 3px 8px; position: absolute; right: 8px; transition: border-color 0.2s ease, color 0.2s ease;
  z-index: 1;
}
.mermaid-reset-btn:hover { border-color: var(--fgColor-muted); color: var(--fgColor-default); }
.mermaid-expand-btn {
  background-color: transparent; border: none; cursor: pointer; left: 8px; padding: 5px;
  position: absolute; top: 8px; z-index: 1;
}
.mermaid-expand-btn svg { display: block; fill: var(--fgColor-muted); transition: fill 0.2s ease; }
.mermaid-expand-btn:hover svg { fill: var(--fgColor-default); }
.mermaid-overlay { background-color: rgba(0, 0, 0, 0.85); display: none; inset: 0; position: absolute; z-index: 2; }
.mermaid-overlay.is-open { display: block; }
.mermaid-overlay-inner {
  cursor: grab; height: 100%; overflow: hidden; touch-action: none; user-select: none; width: 100%;
}
.mermaid-overlay-inner svg { background-color: var(--bgColor-default); }
.mermaid-overlay-close {
  background-color: transparent; border: 1px solid var(--borderColor-default); border-radius: 5px;
  color: var(--fgColor-muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 4px 10px;
  position: absolute; right: 16px; top: 16px; transition: border-color 0.2s ease, color 0.2s ease;
  z-index: 1;
}
.mermaid-overlay-close:hover { border-color: var(--fgColor-muted); color: var(--fgColor-default); }
.mermaid-overlay .mermaid-reset-btn { bottom: 16px; left: 16px; right: auto; }
.markdown-body pre.diagram-map-pre { padding: 0; overflow: hidden; }
.markdown-body pre.diagram-map-pre > code.diagram-map-code {
  display: block; padding: 0; background: transparent; overflow: hidden;
}
.leaflet-diagram-map { height: 310px; min-height: 310px; width: 100%; background: var(--bgColor-muted); }
.leaflet-diagram-map .leaflet-control-attribution, .leaflet-diagram-map .leaflet-control-zoom a { font-size: 11px; }
@container (max-width: 767px) { .leaflet-diagram-map { height: 260px; min-height: 260px; } }
`

/** Whether a palette is light or dark while markon's mode is `markonScheme` */
export const paletteScheme = (palette, markonScheme) => (palette === 'taiga-oak' ? 'dark' : markonScheme)

/** The variable sets a palette layers, in order; later sets win */
export const paletteLayers = (palette, markonScheme) => {
	const scheme = paletteScheme(palette, markonScheme)
	const github = scheme === 'dark' ? GITHUB_DARK_VARIABLES : GITHUB_LIGHT_VARIABLES
	switch (palette) {
		case 'markon':
			return [GITHUB_BASE_VARIABLES, BASE_VARIABLES, github, MARKON_VARIABLES, { 'color-scheme': scheme }]
		case 'taiga-oak':
			// Taiga Oak's colors fill the variables GitHub's dark scheme defines but it leaves alone
			return [GITHUB_BASE_VARIABLES, BASE_VARIABLES, github, TAIGA_OAK_VARIABLES]
		default:
			return [GITHUB_BASE_VARIABLES, BASE_VARIABLES, github, { 'color-scheme': scheme }]
	}
}

/** The GitHub renderer preview's whole shadow-root stylesheet in a palette */
export const previewStylesheet = (palette, markonScheme) => {
	const merged = Object.assign({}, ...paletteLayers(palette, markonScheme))
	const declarations = Object.entries(merged)
		.map(([name, value]) => `  ${name}: ${value};`)
		.join('\n')
	// The GitHub palette shows gh-gfm-preview's own chroma colors; the rest map them to theirs
	const dark = paletteScheme(palette, markonScheme) === 'dark'
	const chroma = palette === 'github' ? (dark ? CHROMA_GITHUB_DARK : CHROMA_GITHUB_LIGHT) : CHROMA_PALETTE
	return `${FRAME_RULES}\n.gfm-root {\n${declarations}\n}\n${GITHUB_MARKDOWN_RULES}\n${chroma}\n${PAGE_RULES}`
}

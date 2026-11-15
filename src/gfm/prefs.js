// The preview's renderer and the GitHub renderer's palette, stored per device.
// Kept apart from the GitHub renderer itself, which loads only when it is first shown.

export const PALETTES = {
	github: { label: 'GitHub', title: "GitHub's colors, light or dark as markon's mode is" },
	markon: { label: 'markon theme', title: "markon's current theme colors" },
	'taiga-oak': { label: 'Taiga Oak', title: 'Dark oak, parchment, and moss green' },
}

const RENDERER_KEY = 'markon-renderer'
const PALETTE_KEY = 'markon-gfm-palette'

/** `markon` (marked + highlight.js) or `github` (gh-gfm-preview) */
export const getRenderer = () => (localStorage.getItem(RENDERER_KEY) === 'github' ? 'github' : 'markon')
export const saveRenderer = renderer => localStorage.setItem(RENDERER_KEY, renderer)

export const getPalette = () => {
	const saved = localStorage.getItem(PALETTE_KEY)
	return saved && Object.hasOwn(PALETTES, saved) ? saved : 'github'
}
export const savePalette = palette => localStorage.setItem(PALETTE_KEY, palette)

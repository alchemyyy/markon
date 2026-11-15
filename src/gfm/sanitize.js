// What the GitHub renderer does around gh-gfm-preview's HTML:
// GitHub's front matter table, and sanitizing the HTML as GitHub does.
import DOMPurify from 'dompurify'
import { parseDocument, stringify } from 'yaml'
import { classifyReference, LOCAL_IMAGE_ATTRIBUTE, LOCAL_LINK_ATTRIBUTE, SOURCE_LINE_ATTRIBUTE } from './references.js'

const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

const escapeHtml = text => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)

const isScalar = item => item === null || ['string', 'number', 'boolean'].includes(typeof item)

const frontMatterValue = value => {
	if (Array.isArray(value) && value.every(isScalar)) return escapeHtml(value.map(String).join(', '))
	if (isScalar(value)) return escapeHtml(String(value))
	return `<code>${escapeHtml(stringify(value).trim())}</code>`
}

/**
 * The YAML front matter of a document as GitHub shows it, or null when there is none or it is not a mapping:
 * - `html`: GitHub's table of it, keys across the header and values below
 * - `body`: the Markdown after it
 * - `lineOffset`: the lines it took, which the body's source lines are offset by
 */
export const splitFrontMatter = source => {
	const match = FRONT_MATTER.exec(source)
	if (!match) return null
	const document = parseDocument(match[1], { schema: 'core' })
	if (document.errors.length > 0) return null
	const data = document.toJS({ maxAliasCount: 100 })
	if (!data || typeof data !== 'object' || Array.isArray(data)) return null
	const entries = Object.entries(data)
	if (entries.length === 0) return null
	const head = entries.map(([key]) => `<th>${escapeHtml(key)}</th>`).join('')
	const body = entries.map(([, value]) => `<td>${frontMatterValue(value)}</td>`).join('')
	return {
		html: `<table ${SOURCE_LINE_ATTRIBUTE}="1"><thead><tr>${head}</tr></thead><tbody><tr>${body}</tr></tbody></table>`,
		body: source.slice(match[0].length),
		lineOffset: match[0].split('\n').length - 1,
	}
}

let hooksInstalled = false

/** Moves local image sources and link targets into data attributes the preview resolves itself */
const installSanitizerHooks = () => {
	if (hooksInstalled) return
	hooksInstalled = true
	DOMPurify.addHook('beforeSanitizeAttributes', node => {
		if (node.nodeName === 'IMG') {
			const source = node.getAttribute('src')
			if (source && classifyReference(source) === 'local') {
				node.setAttribute(LOCAL_IMAGE_ATTRIBUTE, source)
				node.removeAttribute('src')
			}
		} else if (node.nodeName === 'A') {
			const target = node.getAttribute('href')
			if (target && classifyReference(target) === 'local') node.setAttribute(LOCAL_LINK_ATTRIBUTE, target)
		}
	})
	DOMPurify.addHook('afterSanitizeAttributes', node => {
		// Task list checkboxes are the only form control Markdown produces
		if (node.nodeName === 'INPUT') {
			if (node.getAttribute('type') !== 'checkbox') node.remove()
			else node.setAttribute('disabled', '')
		}
	})
}

/**
 * Rendered Markdown made safe to insert into markon's window.
 * gh-gfm-preview passes raw HTML through unfiltered;
 * scripts, event handlers, styles, and forms are removed here, as GitHub removes them.
 */
export const sanitizeHtml = html => {
	installSanitizerHooks()
	return DOMPurify.sanitize(html, {
		USE_PROFILES: { html: true, svg: true },
		FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option'],
		// GitHub drops inline styles too; they could also escape the preview with position: fixed
		FORBID_ATTR: ['style'],
		// Heading ids live in a shadow root, where they cannot clobber document globals
		SANITIZE_DOM: false,
	})
}

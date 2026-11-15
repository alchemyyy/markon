// Link and image targets in the GitHub renderer's output.
// The sanitizer moves local targets into data attributes; the preview resolves them against the document's path.

/** A URL scheme of two or more characters; a single letter is a Windows drive (`C:/...`) */
const URL_SCHEME = /^([a-z][a-z0-9+.-]+):/i
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/

/** Attribute holding a local image source, which the preview loads itself */
export const LOCAL_IMAGE_ATTRIBUTE = 'data-gfm-src'
/** Attribute holding a local link target, which opens in markon */
export const LOCAL_LINK_ATTRIBUTE = 'data-gfm-href'
/** First source line (1-based) of a rendered top-level block, for scroll sync */
export const SOURCE_LINE_ATTRIBUTE = 'data-source-line'

/**
 * What a link or image target names:
 * - `fragment`: an in-document `#fragment`
 * - `external`: an `http(s):` or `mailto:` URL
 * - `local`: a file path (relative, absolute, `~/`, or `file:`)
 * - `other`: anything else (other schemes, protocol-relative URLs), which the preview leaves alone
 */
export const classifyReference = target => {
	const value = target.trim()
	if (!value) return 'other'
	if (value.startsWith('#')) return 'fragment'
	if (value.startsWith('//') || value.startsWith('\\\\')) return 'other'
	const scheme = URL_SCHEME.exec(value)?.[1]?.toLowerCase()
	if (!scheme) return 'local'
	if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return 'external'
	if (scheme === 'file') return 'local'
	return 'other'
}

/** Splits a local link target into its path and the lines its `#L12` / `#L12-L20` fragment names */
export const splitLocalTarget = target => {
	const hashIndex = target.indexOf('#')
	const path = hashIndex === -1 ? target : target.slice(0, hashIndex)
	const fragment = hashIndex === -1 ? '' : target.slice(hashIndex + 1)
	const lines = /^L(\d+)(?:-L?(\d+))?$/i.exec(fragment)
	if (!lines) return { path }
	const lineStart = Number(lines[1])
	const lineEnd = lines[2] ? Number(lines[2]) : undefined
	return lineEnd && lineEnd >= lineStart ? { path, lineStart, lineEnd } : { path, lineStart }
}

/** Whether a local path is a document markon opens in a tab (the extensions its open dialog offers) */
export const isMarkdownPath = path => /\.(?:md|markdown|mdown|mkd|txt)$/i.test(path)

const decode = text => {
	try {
		return decodeURIComponent(text)
	} catch {
		return text
	}
}

/** An absolute path with `.` and `..` resolved, in the platform's separators; null when it is not absolute */
const normalizePath = (path, windows) => {
	let root
	let rest
	if (windows) {
		const drive = /^([A-Za-z]):[\\/]*/.exec(path)
		const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)[\\/]*/.exec(path)
		if (drive) {
			root = `${drive[1].toUpperCase()}:\\`
			rest = path.slice(drive[0].length)
		} else if (unc) {
			root = `\\\\${unc[1]}\\${unc[2]}\\`
			rest = path.slice(unc[0].length)
		} else {
			return null
		}
	} else {
		if (!path.startsWith('/')) return null
		root = '/'
		rest = path
	}
	const segments = []
	for (const segment of rest.split(windows ? /[\\/]+/ : /\/+/)) {
		if (!segment || segment === '.') continue
		if (segment === '..') segments.pop()
		else segments.push(segment)
	}
	return root + segments.join(windows ? '\\' : '/')
}

const joinPath = (base, relative, windows) => normalizePath(`${base}${windows ? '\\' : '/'}${relative}`, windows)

const parentOf = (path, windows) => path.replace(windows ? /[\\/][^\\/]*$/ : /\/[^/]*$/, '')

/** The path a `file:` URL names, or null when it is not one */
const fileUrlPath = (url, windows) => {
	let parsed
	try {
		parsed = new URL(url)
	} catch {
		return null
	}
	const pathname = decode(parsed.pathname)
	if (!windows) return normalizePath(pathname, false)
	// `file:///C:/x` names C:\x; `file://server/share/x` names \\server\share\x
	if (parsed.host) return normalizePath(`\\\\${parsed.host}${pathname}`, true)
	return normalizePath(pathname.replace(/^\/(?=[A-Za-z]:)/, ''), true)
}

/**
 * The paths a local reference may name, most likely first. As GitHub reads a repository:
 * - relative references resolve against the document's folder
 * - `/x` resolves against the folder open in the file tree, else (outside Windows) stands as a host path
 * - `~/` is the home folder; `file:` URLs and absolute paths stand as written
 * A `?query` or `#fragment` is ignored.
 *
 * `context`: `{ documentPath, folder, home, windows }`; paths are absolute or null.
 */
export const candidatePaths = (reference, { documentPath, folder, home, windows }) => {
	const trimmed = reference.trim()
	if (/^file:/i.test(trimmed)) {
		const path = fileUrlPath(trimmed, windows)
		return path ? [path] : []
	}
	const text = decode(trimmed.replace(/[?#][\s\S]*$/, ''))
	if (!text) return []
	if (/^~[\\/]/.test(text)) return home ? [joinPath(home, text.slice(2), windows)].filter(Boolean) : []
	// One leading slash (not a UNC `\\server` or POSIX `//` path)
	if (/^[\\/](?![\\/])/.test(text)) {
		const candidates = folder ? [joinPath(folder, text, windows)] : []
		// On Windows `/x` is drive-relative, which is meaningless here
		if (!windows) candidates.push(normalizePath(text, false))
		return candidates.filter(Boolean)
	}
	const absolute = windows ? WINDOWS_ABSOLUTE.test(text) : text.startsWith('/')
	if (absolute) return [normalizePath(text, windows)].filter(Boolean)
	if (!documentPath) return []
	return [joinPath(parentOf(documentPath, windows), text, windows)].filter(Boolean)
}

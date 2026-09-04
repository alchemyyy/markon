const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-z]:[\\/]/i
const WINDOWS_ENCODED_DRIVE_PATH_PATTERN = /^[a-z]:%5c/i
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/
const WINDOWS_FILE_URL_PATH_PATTERN = /^\/[a-z]:\//i

export const REFERENCE_TYPE = Object.freeze({
	DOCUMENT: 'document',
	EXTERNAL: 'external',
	LOCAL: 'local',
	UNSUPPORTED: 'unsupported',
})

const decodePath = path => {
	try {
		return decodeURIComponent(path)
	} catch {
		return path
	}
}

const pathWithoutURLSuffix = reference => {
	const suffixIndex = reference.search(/[?#]/)
	return suffixIndex < 0 ? reference : reference.slice(0, suffixIndex)
}

/** Classifies a rendered Markdown URL without resolving it against the app origin. */
export const classifyReference = reference => {
	if (typeof reference !== 'string') return REFERENCE_TYPE.UNSUPPORTED

	const trimmedReference = reference.trim()
	if (!trimmedReference) return REFERENCE_TYPE.UNSUPPORTED
	if (trimmedReference.startsWith('#') || trimmedReference.startsWith('?')) return REFERENCE_TYPE.DOCUMENT
	if (trimmedReference.startsWith('//')) return REFERENCE_TYPE.EXTERNAL

	const decodedReference = decodePath(pathWithoutURLSuffix(trimmedReference))
	if (
		WINDOWS_DRIVE_PATH_PATTERN.test(decodedReference) ||
		WINDOWS_ENCODED_DRIVE_PATH_PATTERN.test(trimmedReference) ||
		WINDOWS_UNC_PATH_PATTERN.test(decodedReference)
	) {
		return REFERENCE_TYPE.LOCAL
	}

	const scheme = trimmedReference.match(URL_SCHEME_PATTERN)?.[0]?.toLowerCase()
	if (!scheme) return REFERENCE_TYPE.LOCAL
	if (scheme === 'file:') return REFERENCE_TYPE.LOCAL
	if (EXTERNAL_PROTOCOLS.has(scheme)) return REFERENCE_TYPE.EXTERNAL
	return REFERENCE_TYPE.UNSUPPORTED
}

/** Converts an absolute file URL into a native Windows, UNC, or POSIX path. */
export const fileURLToPath = reference => {
	let fileURL
	try {
		fileURL = new URL(reference)
	} catch {
		return null
	}
	if (fileURL.protocol !== 'file:') return null

	const decodedPath = decodePath(fileURL.pathname)
	if (fileURL.hostname && fileURL.hostname.toLowerCase() !== 'localhost') {
		return `\\\\${decodePath(fileURL.hostname)}${decodedPath.replaceAll('/', '\\')}`
	}
	if (WINDOWS_FILE_URL_PATH_PATTERN.test(decodedPath)) {
		return decodedPath.slice(1).replaceAll('/', '\\')
	}
	return decodedPath || null
}

/** Extracts the path portion from a local URL or path reference. */
export const localPathFromReference = reference => {
	if (classifyReference(reference) !== REFERENCE_TYPE.LOCAL) return null

	const trimmedReference = reference.trim()
	if (/^file:/i.test(trimmedReference)) return fileURLToPath(trimmedReference)
	return decodePath(pathWithoutURLSuffix(trimmedReference)) || null
}

/** Resolves a local reference relative to the Markdown document that contains it. */
export const resolveLocalReferencePath = async (reference, documentPath, pathAPI) => {
	const referencedPath = localPathFromReference(reference)
	if (!referencedPath) return null

	if (await pathAPI.isAbsolute(referencedPath)) return await pathAPI.normalize(referencedPath)
	if (!documentPath) return null

	const documentDirectory = await pathAPI.dirname(documentPath)
	return await pathAPI.resolve(documentDirectory, referencedPath)
}

/** Returns whether a local path is a document Markon can open in an editor tab. */
export const isMarkdownPath = path => /\.(?:md|markdown|mdown|mkd|txt)$/i.test(path)

/** Makes protocol-relative web references safe for the native URL opener. */
export const normalizeExternalReference = reference => (reference.startsWith('//') ? `https:${reference}` : reference)

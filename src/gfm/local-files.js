// Local files the previews reference: the images they show and the link targets they open.
// They are read through Tauri; the web build has no file paths to resolve them against.
// Images are cached as blob URLs, and the folders holding them are watched:
// an image changed, replaced, or deleted on disk is read again and the previews told to show it.
import { getHomeDir, isTauri, readBinaryFileAt, statPath, watchPath } from '../native.js'
import { candidatePaths, splitLocalTarget } from './references.js'

const IMAGE_MIME_TYPES = {
	'.apng': 'image/apng',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webp': 'image/webp',
}
/** Larger images are not shown */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Images kept per session; the oldest is released past this */
const MAX_CACHED_IMAGES = 200
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/

let homeDir = null

/** Whether `path` lies inside `folder`; Windows paths compare case-insensitively */
const isInside = (path, folder, windows) => {
	const separator = windows ? '\\' : '/'
	const prefix = folder.endsWith(separator) ? folder : folder + separator
	return windows ? path.toLowerCase().startsWith(prefix.toLowerCase()) : path.startsWith(prefix)
}

/**
 * The first existing file or folder a local reference names, relative to the document at `documentPath`:
 * `{ path, isFile, isDirectory, size }`, or null when none exists.
 * Throws when there is nothing to resolve against.
 */
export const resolveLocal = async (reference, documentPath) => {
	for (const path of await candidatesFor(reference, documentPath)) {
		const info = await statPath(path)
		if (info && (info.isFile || info.isDirectory)) return { path, ...info }
	}
	return null
}

/** The paths a local reference may name, most likely first; throws when there is nothing to resolve against */
const candidatesFor = async (reference, documentPath) => {
	if (!isTauri()) throw new Error('Local files open in the markon desktop app')
	homeDir ??= getHomeDir()
	const home = await homeDir
	const windows = WINDOWS_PATH.test(documentPath ?? home ?? '')
	// `/x` names the folder open in the file tree, as GitHub reads it from the repository root
	const root = window.fileTree?.getRoot?.() ?? null
	const folder = root && documentPath && isInside(documentPath, root, windows) ? root : null
	const candidates = candidatePaths(reference, { documentPath, folder, home, windows })
	if (candidates.length === 0) {
		throw new Error(documentPath ? `Cannot resolve ${reference}` : `Save the document to resolve ${reference}`)
	}
	return candidates
}

/** The folder holding `path` */
const directoryOf = path => {
	const directory = path.replace(/[\\/][^\\/]*$/, '')
	// A drive root keeps its separator: `C:\`, not `C:`
	return /^[A-Za-z]:$/.test(directory) ? `${directory}\\` : directory || '/'
}

/** Cached images by document and reference: `{ url, promise, path, size, mtimeMs }` */
const images = new Map()
/** Watched folders: the stop function of each folder's watcher */
const watchers = new Map()
/** Folders where an image was looked for but not found; one appearing there re-renders the previews */
const awaited = new Set()
const changeListeners = []

const watchDirectory = directory => {
	if (!watchers.has(directory)) watchers.set(directory, watchPath(directory, () => directoryChanged(directory)))
}

/** Stops watching a folder no cached or awaited image is in */
const releaseDirectory = directory => {
	if (awaited.has(directory)) return
	for (const entry of images.values()) if (entry.path && directoryOf(entry.path) === directory) return
	watchers.get(directory)?.then(stop => stop())
	watchers.delete(directory)
}

/** Drops the cached images in `directory` that changed on disk, and tells the previews to show them again */
const directoryChanged = async directory => {
	const inDirectory = [...images].filter(([, entry]) => entry.path && directoryOf(entry.path) === directory)
	let changed = awaited.delete(directory)
	for (const [key, entry] of inDirectory) {
		const info = await statPath(entry.path)
		if (info?.isFile && info.size === entry.size && info.mtimeMs === entry.mtimeMs) continue
		if (images.get(key) !== entry) continue
		images.delete(key)
		URL.revokeObjectURL(entry.url)
		changed = true
	}
	if (changed) for (const listener of changeListeners) listener()
}

/** `fn()` runs when a local image a preview shows (or looked for) changes on disk */
export const onLocalImagesChanged = fn => changeListeners.push(fn)

const loadImage = async (reference, documentPath) => {
	const candidates = await candidatesFor(reference, documentPath)
	let found = null
	for (const path of candidates) {
		const info = await statPath(path)
		if (info?.isFile || info?.isDirectory) {
			found = { path, ...info }
			break
		}
	}
	if (!found?.isFile) {
		// Watch where it should be, so it shows once it is saved there
		const directory = directoryOf(candidates[0])
		awaited.add(directory)
		watchDirectory(directory)
		throw new Error(`Image not found: ${reference}`)
	}
	const extension = /\.[^.\\/]+$/.exec(found.path)?.[0]?.toLowerCase() ?? ''
	const mimeType = IMAGE_MIME_TYPES[extension]
	if (!mimeType) throw new Error(`Not an image: ${reference}`)
	if (found.size > MAX_IMAGE_BYTES) throw new Error(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MiB`)
	const bytes = await readBinaryFileAt(found.path)
	if (!bytes) throw new Error(`Could not read ${found.path}`)
	watchDirectory(directoryOf(found.path))
	return {
		url: URL.createObjectURL(new Blob([bytes], { type: mimeType })),
		path: found.path,
		size: found.size,
		mtimeMs: found.mtimeMs,
	}
}

/**
 * The blob URL of a local image, at once when cached, else a promise of it.
 * Re-rendering an edited document reuses decoded images instead of reading them again.
 */
export const localImageUrl = (reference, documentPath) => {
	const key = `${documentPath ?? ''}|${reference}`
	const cached = images.get(key)
	if (cached) {
		// Refresh recency
		images.delete(key)
		images.set(key, cached)
		return cached.url ?? cached.promise
	}
	const entry = { url: null, promise: null, path: null, size: 0, mtimeMs: 0 }
	entry.promise = loadImage(reference, documentPath).then(
		loaded => {
			Object.assign(entry, loaded)
			return loaded.url
		},
		error => {
			// A failed read is retried on the next render
			images.delete(key)
			throw error
		},
	)
	images.set(key, entry)
	while (images.size > MAX_CACHED_IMAGES) {
		const [oldestKey, oldest] = images.entries().next().value
		images.delete(oldestKey)
		if (oldest.url) URL.revokeObjectURL(oldest.url)
		if (oldest.path) releaseDirectory(directoryOf(oldest.path))
	}
	return entry.promise
}

/**
 * Opens a local link target of the document at `documentPath`:
 * a file through `openFile(path, line)`, at the line its `#L12` fragment names, a folder through `openFolder(path)`.
 * Throws when the target cannot be found.
 */
export const openLocalTarget = async (target, documentPath, { openFile, openFolder }) => {
	const { path, lineStart } = splitLocalTarget(target)
	const found = await resolveLocal(path, documentPath)
	if (!found) throw new Error(`Not found: ${path}`)
	if (found.isDirectory) await openFolder(found.path)
	else await openFile(found.path, lineStart)
}

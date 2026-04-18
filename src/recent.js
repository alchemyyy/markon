const KEY = 'markon-recent'
const MAX = 10

const read = () => {
	try {
		const raw = localStorage.getItem(KEY)
		if (!raw) return []
		const list = JSON.parse(raw)
		return Array.isArray(list) ? list : []
	} catch {
		return []
	}
}

const write = list => {
	try {
		localStorage.setItem(KEY, JSON.stringify(list))
	} catch {}
}

export const getRecent = () => read()

export const addRecent = path => {
	if (!path) return
	const list = read().filter(p => p !== path)
	list.unshift(path)
	write(list.slice(0, MAX))
}

export const removeRecent = path => {
	write(read().filter(p => p !== path))
}

export const clearRecent = () => write([])

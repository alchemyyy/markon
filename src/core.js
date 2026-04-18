import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import sampleMd from '../sample.md?raw'
import { createProfiler } from './profiler.js'
import { editorThemeExtensions } from './style.js'

const readDefaultMarkdown = async () => sampleMd || '# markon\n\nStart typing...'

export const LINE_NUMBERS_KEY = 'markon-line-numbers'
const lineNumbersOnByDefault = () => {
	const raw = localStorage.getItem(LINE_NUMBERS_KEY)
	return raw == null ? true : raw === 'true'
}
const lineNumbersExt = enabled => (enabled ? lineNumbers() : [])

export const createEditor = async () => {
	let view = null
	const subscribers = []
	const profiler = createProfiler()
	const lineNumbersCompartment = new Compartment()

	const mountIfNeeded = () => {
		const html = document.documentElement
		if (!html.classList.contains('ready')) html.classList.add('ready')
	}

	const notify = () => {
		if (!subscribers.length) return
		const value = view.state.doc.toString()
		for (const fn of subscribers) fn(value)
	}

	const make = defaultValue => {
		view?.destroy?.()
		const state = EditorState.create({
			doc: defaultValue,
			extensions: [
				markdown({ base: markdownLanguage, codeLanguages: languages }),
				keymap.of([indentWithTab, ...defaultKeymap]),
				EditorView.lineWrapping,
				lineNumbersCompartment.of(lineNumbersExt(lineNumbersOnByDefault())),
				EditorView.updateListener.of(v => {
					if (v.docChanged) {
						profiler.markInputStart()
						notify()
					}
				}),
				...editorThemeExtensions(),
			],
		})
		view = new EditorView({ state, parent: document.querySelector('#editor') })
		mountIfNeeded()
	}

	const setLineNumbers = enabled => {
		if (!view) return
		view.dispatch({ effects: lineNumbersCompartment.reconfigure(lineNumbersExt(enabled)) })
		localStorage.setItem(LINE_NUMBERS_KEY, String(enabled))
	}

	// Boot with sample content; docs.js owns all persistence/state.
	const initialContent = await readDefaultMarkdown()
	make(initialContent)

	const getMarkdown = () => view.state.doc.toString()
	const setMarkdown = markdown => {
		const doc = markdown ?? ''
		const tr = view.state.update({
			changes: { from: 0, to: view.state.doc.length, insert: doc },
		})
		view.update([tr])
		notify()
	}
	const onMarkdownUpdated = fn => subscribers.push(fn)

	const scrollToLine = lineNumber => {
		if (!view || lineNumber < 1) return
		const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines))
		view.dispatch({
			effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 20 }),
		})
	}

	// Expose global functions for worker
	window.getMarkdown = getMarkdown
	window.setMarkdown = setMarkdown
	window.setLineNumbers = setLineNumbers

	const cleanup = () => {}

	return { getMarkdown, setMarkdown, onMarkdownUpdated, cleanup, profiler, scrollToLine, view, setLineNumbers }
}

import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const cmTheme = EditorView.theme({
	'&': { height: '100%' },
	'.cm-scroller': {
		fontFamily: 'Monaspace Argon, ui-monospace, monospace',
		background: 'var(--bg)',
		// Flip the scroller to RTL so the vertical scrollbar appears on the left.
		// Combine with row-reverse so flex children land in the natural left→right
		// order again (gutter then content), which puts the line-number gutter
		// immediately to the right of the scrollbar.
		direction: 'rtl',
		flexDirection: 'row-reverse',
	},
	// Keep all actual text content laid out LTR.
	'.cm-content': { caretColor: 'var(--accent)', direction: 'ltr' },
	'.cm-gutters': {
		background: 'transparent',
		border: 'none',
		direction: 'ltr',
		color: 'var(--comment)',
	},
	'.cm-gutterElement': { padding: '0 8px 0 4px' },
	'.cm-activeLineGutter': { color: 'var(--accent)', background: 'transparent' },
	'.cm-line': { color: 'color-mix(in srgb, var(--text) 85%, var(--bg))', direction: 'ltr' },
	'.cm-selectionBackground': {
		background: 'var(--accent-alpha)',
	},
})

const pandaGroups = [
	['var(--comment)', t.comment, t.blockComment, t.lineComment, t.docComment, t.quote],
	['var(--primary)', t.paren, t.brace, t.color, t.bracket, t.angleBracket],
	['var(--fg)', t.name, t.punctuation, t.standard, t.annotation, t.content, t.compareOperator, t.arithmeticOperator],
	['var(--meta)', t.contentSeparator, t.documentMeta, t.macroName, t.separator, t.deleted, t.atom, t.meta, t.null],
	[
		'var(--operator)',
		t.definitionOperator,
		t.controlOperator,
		t.bitwiseOperator,
		t.updateOperator,
		t.logicOperator,
		t.derefOperator,
		t.typeOperator,
		t.namespace,
		t.operator,
		t.changed,
		t.invalid,
	],
	[
		'var(--keyword)',
		t.definitionKeyword,
		t.operatorKeyword,
		t.controlKeyword,
		t.moduleKeyword,
		t.tagName,
		t.keyword,
		t.constant,
		t.function,
		t.list,
		t.self,
		t.monospace,
	],
	['var(--regex)', t.escape, t.special, t.regexp],
	[
		'var(--property)',
		t.name,
		t.squareBracket,
		t.typeName,
		t.variableName,
		t.function,
		t.definition,
		t.propertyName,
		t.unit,
		t.attributeName,
	],
	['var(--string)', t.string, t.docString, t.className, t.processingInstruction, t.character],
	[
		'var(--literal)',
		t.integer,
		t.literal,
		t.local,
		t.labelName,
		t.number,
		t.bool,
		t.inserted,
		t.float,
		t.attributeValue,
	],
]

const createHighlightStyle = groups => groups.flatMap(([color, ...tags]) => tags.map(tag => ({ tag, color })))

// Markdown-specific styles
const sharedHeadings = {
	fontWeight: 'bold',
}

const markdownStyles = [
	{ tag: [t.heading], color: 'var(--primary)', fontWeight: '800' },
	{ tag: [t.heading1], ...sharedHeadings, color: 'var(--string)' },
	{ tag: [t.heading2], ...sharedHeadings, color: 'var(--property)' },
	{ tag: [t.heading3], ...sharedHeadings, color: 'var(--operator)' },
	{ tag: [t.heading4], ...sharedHeadings, color: 'var(--literal)' },
	{ tag: [t.heading5], ...sharedHeadings, color: 'var(--keyword)' },
	{ tag: [t.heading6], ...sharedHeadings, color: 'var(--regex)' },
	{
		tag: [t.strikethrough],
		color: 'var(--literal)',
		textDecoration: 'line-through',
	},
	{ tag: [t.strong], color: 'var(--meta)', fontWeight: '700' },
	{ tag: [t.emphasis], color: 'var(--operator)', fontStyle: 'italic' },
	{ tag: [t.link], color: 'var(--property)' },
	{ tag: [t.url], color: 'var(--string)', textDecoration: 'wavy' },
]

const pandaHighlight = HighlightStyle.define([...createHighlightStyle(pandaGroups), ...markdownStyles])

export const editorThemeExtensions = () => [
	cmTheme,
	syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
	syntaxHighlighting(pandaHighlight),
]

import assert from 'node:assert/strict'
import test from 'node:test'
import { candidatePaths, classifyReference, isMarkdownPath, splitLocalTarget } from '../src/gfm/references.js'

const windowsDoc = { documentPath: 'C:\\work\\docs\\guide.md', folder: null, home: 'C:\\Users\\me', windows: true }
const posixDoc = { documentPath: '/home/me/notes/doc.md', folder: '/home/me/notes', home: '/home/me', windows: false }

test('classifies fragment, external, local, and other references', () => {
	assert.equal(classifyReference('#installation'), 'fragment')
	assert.equal(classifyReference('https://example.com/image.png'), 'external')
	assert.equal(classifyReference('mailto:me@example.com'), 'external')
	assert.equal(classifyReference('file:///C:/Notes/readme.md'), 'local')
	assert.equal(classifyReference('../images/diagram.png'), 'local')
	assert.equal(classifyReference('C:/Notes/readme.md'), 'local')
	assert.equal(classifyReference('javascript:alert(1)'), 'other')
	assert.equal(classifyReference('//cdn.example.com/x.png'), 'other')
})

test('resolves references against the Markdown file that contains them', () => {
	assert.deepEqual(candidatePaths('../README.md', windowsDoc), ['C:\\work\\README.md'])
	assert.deepEqual(candidatePaths('./images/a%20b.png?raw=1', windowsDoc), ['C:\\work\\docs\\images\\a b.png'])
	assert.deepEqual(candidatePaths('./img/pic.png', posixDoc), ['/home/me/notes/img/pic.png'])
})

test('converts Windows, UNC, and POSIX file URLs to native paths', () => {
	const unsaved = { ...windowsDoc, documentPath: null }
	assert.deepEqual(candidatePaths('file:///C:/Users/Alchemy/My%20Notes/readme.md#install', unsaved), [
		'C:\\Users\\Alchemy\\My Notes\\readme.md',
	])
	assert.deepEqual(candidatePaths('file://server/share/My%20Notes/readme.md', unsaved), [
		'\\\\server\\share\\My Notes\\readme.md',
	])
	assert.deepEqual(candidatePaths('file:///home/me/a%20b.png', posixDoc), ['/home/me/a b.png'])
})

test('a root-relative path names the open folder first, then the host path outside Windows', () => {
	assert.deepEqual(candidatePaths('/assets/x.png', posixDoc), ['/home/me/notes/assets/x.png', '/assets/x.png'])
	assert.deepEqual(candidatePaths('/assets/x.png', windowsDoc), [])
	assert.deepEqual(candidatePaths('~/pics/a.png', windowsDoc), ['C:\\Users\\me\\pics\\a.png'])
})

test('only relative references need a saved document', () => {
	const unsaved = { ...windowsDoc, documentPath: null }
	assert.deepEqual(candidatePaths('sibling.md', unsaved), [])
	assert.deepEqual(candidatePaths('C:/abs/a.png', unsaved), ['C:\\abs\\a.png'])
})

test('line fragments of local links', () => {
	assert.deepEqual(splitLocalTarget('./a.md#L12-L20'), { path: './a.md', lineStart: 12, lineEnd: 20 })
	assert.deepEqual(splitLocalTarget('./a.md#heading'), { path: './a.md' })
})

test('recognizes every extension markon opens as a document', () => {
	assert.equal(isMarkdownPath('README.MD'), true)
	assert.equal(isMarkdownPath('notes.markdown'), true)
	assert.equal(isMarkdownPath('notes.txt'), true)
	assert.equal(isMarkdownPath('diagram.png'), false)
})

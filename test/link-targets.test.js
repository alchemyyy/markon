import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
	classifyReference,
	fileURLToPath,
	isMarkdownPath,
	REFERENCE_TYPE,
	resolveLocalReferencePath,
} from '../src/link-targets.js'

test('classifies document, external, local, and unsupported references', () => {
	assert.equal(classifyReference('#installation'), REFERENCE_TYPE.DOCUMENT)
	assert.equal(classifyReference('https://example.com/image.png'), REFERENCE_TYPE.EXTERNAL)
	assert.equal(classifyReference('file:///C:/Notes/readme.md'), REFERENCE_TYPE.LOCAL)
	assert.equal(classifyReference('../images/diagram.png'), REFERENCE_TYPE.LOCAL)
	assert.equal(classifyReference('C:%5CNotes%5Creadme.md'), REFERENCE_TYPE.LOCAL)
	assert.equal(classifyReference('javascript:alert(1)'), REFERENCE_TYPE.UNSUPPORTED)
})

test('converts Windows and UNC file URLs to native paths', () => {
	assert.equal(
		fileURLToPath('file:///C:/Users/Alchemy/My%20Notes/readme.md#install'),
		'C:\\Users\\Alchemy\\My Notes\\readme.md',
	)
	assert.equal(fileURLToPath('file://server/share/My%20Notes/readme.md'), '\\\\server\\share\\My Notes\\readme.md')
})

test('resolves Windows references against the current Markdown file', async () => {
	assert.equal(
		await resolveLocalReferencePath('../README.md', 'C:\\work\\docs\\guide.md', path.win32),
		'C:\\work\\README.md',
	)
	assert.equal(
		await resolveLocalReferencePath('./images/a%20b.png?raw=1', 'C:\\work\\docs\\guide.md', path.win32),
		'C:\\work\\docs\\images\\a b.png',
	)
	assert.equal(
		await resolveLocalReferencePath(
			'file:///C:/Users/Alchemy/Desktop/TrayAppDotNETShowcase/TrayAppDotNETREADME.md',
			null,
			path.win32,
		),
		'C:\\Users\\Alchemy\\Desktop\\TrayAppDotNETShowcase\\TrayAppDotNETREADME.md',
	)
})

test('requires a saved document only for relative references', async () => {
	assert.equal(await resolveLocalReferencePath('sibling.md', null, path.win32), null)
	assert.equal(await resolveLocalReferencePath('https://example.com/readme.md', 'C:\\work\\guide.md', path.win32), null)
	assert.equal(await resolveLocalReferencePath('/home/user/readme.md', null, path.posix), '/home/user/readme.md')
})

test('recognizes all editor-supported Markdown extensions', () => {
	assert.equal(isMarkdownPath('README.MD'), true)
	assert.equal(isMarkdownPath('notes.markdown'), true)
	assert.equal(isMarkdownPath('notes.txt'), true)
	assert.equal(isMarkdownPath('diagram.png'), false)
})

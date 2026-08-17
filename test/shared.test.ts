import assert from 'assert'
import fs from 'fs'
import Shared from '../src/share/shared'
import memoryShareProvider from '../src/share/providers/memory'
import type { ShareEntry } from '../src/share/provider'

describe('class Shared', () => {
  const baseFolder = '/tmp/slsk-share'

  before(async () => {
    await fs.promises.mkdir(baseFolder + '/first level', { recursive: true })
    await fs.promises.writeFile(baseFolder + '/good file.mp3', 'data')
    await fs.promises.writeFile(baseFolder + '/bad file.mp3', 'data')
    await fs.promises.writeFile(baseFolder + '/first level/good file.mp3', 'data')
    await fs.promises.writeFile(baseFolder + '/first level/bad file.mp3', 'data')
  })

  it('find all the files', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    const results = await shared.search('mp3')

    assert.strictEqual(results.length, 4)
  })

  it('find by file name on base folder', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    const results = await shared.search('good -first')

    assert.strictEqual(results.length, 1)
    assert.deepStrictEqual(results[0], {
      path: 'slsk-share\\good file.mp3',
      size: 4,
      id: baseFolder + '/good file.mp3'
    } satisfies ShareEntry)
  })

  it('find by file name in first level folder', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    const results = await shared.search('good first')

    assert.strictEqual(results.length, 1)
    assert.deepStrictEqual(results[0], {
      path: 'slsk-share\\first level\\good file.mp3',
      size: 4,
      id: baseFolder + '/first level/good file.mp3'
    } satisfies ShareEntry)
  })

  it('advertises paths rooted at the shared folder, not local paths', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    shared.files.forEach(entry => {
      assert.ok(entry.path.startsWith('slsk-share\\'), `${entry.path} must be a virtual path`)
      assert.ok(!entry.path.includes('/'), `${entry.path} must not leak the local path`)
    })
  })

  it('groups the shared files by folder', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    assert.deepStrictEqual(shared.folders().sort(), ['slsk-share', 'slsk-share\\first level'])
    assert.deepStrictEqual(
      shared.filesInFolder('slsk-share\\first level').map(entry => entry.path),
      ['slsk-share\\first level\\bad file.mp3', 'slsk-share\\first level\\good file.mp3']
    )
    assert.deepStrictEqual(shared.stats(), { folders: 2, files: 4 })
  })

  it('shares the files of a provider next to the folders', async () => {
    const shared = new Shared()
    shared.addProvider(memoryShareProvider({ 'bucket/remote song.mp3': 'data' }))
    await shared.scanFolder(baseFolder)
    await shared.refresh()

    assert.strictEqual(shared.stats().files, 5)
    assert.strictEqual((await shared.search('remote')).length, 1)
    assert.strictEqual(shared.resolve('bucket\\remote song.mp3')?.entry.size, 4)
  })

  it('still emits a complete event for backward compatibility', async () => {
    const shared = new Shared()
    const completed = new Promise<string>(resolve => shared.on('complete', resolve))
    await shared.scanFolder(baseFolder)

    assert.strictEqual(await completed, baseFolder)
  })

  it('emits a file event for every file found', async () => {
    const shared = new Shared()
    const found: string[] = []
    shared.on('file', entry => found.push(entry.path))
    await shared.scanFolder(baseFolder)

    assert.strictEqual(found.length, 4)
    assert.ok(found.includes('slsk-share\\good file.mp3'))
  })

  it('does not fail on a folder that does not exist', async () => {
    const shared = new Shared()
    await shared.scanFolder('/tmp/slsk-share-does-not-exist')

    assert.strictEqual((await shared.search('mp3')).length, 0)
  })
})

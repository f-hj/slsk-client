import assert from 'assert'
import fs from 'fs'
import Shared from '../src/share/shared'

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

    const results = shared.search('mp3')

    assert.strictEqual(results.length, 4)
  })

  it('find by file name on base folder', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    const results = shared.search('good -first')

    assert.strictEqual(results.length, 1)
    assert.deepStrictEqual(results[0], {
      key: 'good file.mp3',
      value: {
        file: baseFolder + '/good file.mp3',
        size: 4
      }
    })
  })

  it('find by file name in first level folder', async () => {
    const shared = new Shared()
    await shared.scanFolder(baseFolder)

    const results = shared.search('good first')

    assert.strictEqual(results.length, 1)
    assert.deepStrictEqual(results[0], {
      key: 'first level/good file.mp3',
      value: {
        file: baseFolder + '/first level/good file.mp3',
        size: 4
      }
    })
  })

  it('still emits a complete event for backward compatibility', async () => {
    const shared = new Shared()
    const completed = new Promise<string>(resolve => shared.on('complete', resolve))
    await shared.scanFolder(baseFolder)

    assert.strictEqual(await completed, baseFolder)
  })

  it('does not fail on a folder that does not exist', async () => {
    const shared = new Shared()
    await shared.scanFolder('/tmp/slsk-share-does-not-exist')

    assert.strictEqual(shared.search('mp3').length, 0)
  })
})

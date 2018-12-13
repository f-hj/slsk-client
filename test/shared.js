/* eslint-env mocha */

const assert = require('assert')
const fs = require('fs')
const Shared = require('../lib/share/shared.js')

describe('class Shared', () => {
  let baseFolder = '/tmp/slsk-share'
  createFolder(baseFolder + '/first level')
  fs.writeFileSync(baseFolder + '/good file.mp3', 'data')
  fs.writeFileSync(baseFolder + '/bad file.mp3', 'data')
  fs.writeFileSync(baseFolder + '/first level/good file.mp3', 'data')
  fs.writeFileSync(baseFolder + '/first level/bad file.mp3', 'data')

  it('find all the files', done => {
    let shared = new Shared()
    shared.scanFolder(baseFolder)

    shared.on('complete', folder => {
      let results = shared.search('mp3')

      assert.strictEqual(results.length, 4)
      done()
    })
  })

  it('find by file name on base folder', done => {
    let shared = new Shared()
    shared.scanFolder(baseFolder)

    shared.on('complete', folder => {
      let results = shared.search('good -first')

      assert.strictEqual(results.length, 1)
      assert.deepEqual(results[0], {
        key: 'good file.mp3',
        value: {
          file: baseFolder + '/good file.mp3',
          size: 4
        }
      })
      done()
    })
  })

  it('find by file name in first level folder', done => {
    let shared = new Shared()
    shared.scanFolder(baseFolder)

    shared.on('complete', folder => {
      let results = shared.search('good first')

      assert.strictEqual(results.length, 1)
      assert.deepEqual(results[0], {
        key: 'first level/good file.mp3',
        value: {
          file: baseFolder + '/first level/good file.mp3',
          size: 4
        }
      })
      done()
    })
  })
})

function createFolder (path) {
  try {
    let opts = { recursive: true }
    fs.mkdirSync(path, opts)
  } catch (err) { }
}

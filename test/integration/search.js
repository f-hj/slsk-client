/* eslint-env mocha */

const path = require('path')
const fs = require('fs')
const process = require('process')
const assert = require('assert')

const slsk = require('../../lib/index.js')

describe('search', () => {
  let client
  let file
  let file2
  after(() => {
    if (client) client.destroy()
  })

  it('must have env vars', (done) => {
    assert.strictEqual(typeof process.env.SLSK_USER, 'string')
    assert.strictEqual(typeof process.env.SLSK_PASS, 'string')
    done()
  })

  it('must login', (done) => {
    slsk.connect({
      user: process.env.SLSK_USER,
      pass: process.env.SLSK_PASS
    }, (err, res) => {
      client = res
      done(err)
    })
  }).timeout(10000)

  it('must search correctly', (done) => {
    client.search({
      req: 'moby play',
      timeout: 4000
    }, (err, res) => {
      if (err) return done(err)
      file = res.filter(it => path.extname(it.file) === '.mp3')
        .sort((a, b) => (a.size / a.speed) - (b.size / b.speed))
        .find(it => it.slots)

      if (file) {
        console.log(file)
        return done()
      }
      done(new Error('Test: no file with free slot'))
    })
  }).timeout(5000) // 5000

  it('must search correctly a second time', (done) => {
    client.search({
      req: 'sbtrkt wildfire',
      timeout: 4000
    }, (err, res) => {
      if (err) return done(err)
      file2 = res.filter(it => path.extname(it.file) === '.mp3')
        .sort((a, b) => (a.size / a.speed) - (b.size / b.speed))
        .find(it => it.slots)

      if (file2) {
        console.log(file2)
        return done()
      }
      done(new Error('Test: no file with free slot'))
    })
  }).timeout(5000) // 5000

  it('must download correctly', (done) => {
    client.download({
      file
    }, (err, down) => {
      if (err) return done(err)
      console.log('test done')
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        done()
      }
    })
  }).timeout(120000)

  it('must download correctly a second time', (done) => {
    client.download({
      file: file2
    }, (err, down) => {
      if (err) return done(err)
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        done()
      }
    })
  }).timeout(120000)

  it('must download correctly with path', (done) => {
    client.download({
      file,
      path: '/tmp/slsk-client_test.mp3'
    }, (err, down) => {
      if (err) return done(err)
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        fs.stat('/tmp/slsk-client_test.mp3', (err, stats) => {
          if (err) {
            return done(err)
          }
          if (stats.size !== file.size) {
            return done(new Error('File size is not same as specified'))
          }
          done()
        })
      }
    })
  }).timeout(120000)

  it('must download correctly with stream', (done) => {
    client.downloadStream({
      file
    }, (err, stream) => {
      let nbPacket = 0
      if (err) return done(err)

      stream.on('data', data => {
        nbPacket++
      })

      stream.on('end', () => {
        assert.notStrictEqual(nbPacket, 0)
        done()
      })
    })
  }).timeout(120000)
})

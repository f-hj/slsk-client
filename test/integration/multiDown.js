/* eslint-env mocha */

const path = require('path')

const slsk = require('../../lib/index.js')

describe('multi download', () => {
  let client
  let file1
  let file2
  let file3

  after(() => {
    if (client) client.destroy()
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
      req: 'polo pan',
      timeout: 4000
    }, (err, res) => {
      if (err) return done(err)
      let files = res.filter(it => path.extname(it.file) === '.mp3')
        .sort((a, b) => (a.size / a.speed) - (b.size / b.speed))
        .filter(it => it.slots)

      if (files.length >= 3) {
        file1 = files[0]
        file2 = files[1]
        file3 = files[2]
        console.log('file1', file1)
        console.log('file2', file2)
        console.log('file3', file3)
        return done()
      }
      done(new Error('Test: no file with free slot'))
    })
  }).timeout(5000) // 5000

  it('must download 3 files simultaneously', done => {
    let nbDownloaded = 0

    client.download({
      file: file1
    }, (err, down) => {
      if (err) return done(err)
      console.log('file1 done')
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        nbDownloaded++
        if (nbDownloaded === 3) done()
      }
    })

    client.download({
      file: file2
    }, (err, down) => {
      if (err) return done(err)
      console.log('file2 done')
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        nbDownloaded++
        if (nbDownloaded === 3) done()
      }
    })

    client.download({
      file: file3
    }, (err, down) => {
      if (err) return done(err)
      console.log('file3 done')
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        nbDownloaded++
        if (nbDownloaded === 3) done()
      }
    })
  }).timeout(420000)
})

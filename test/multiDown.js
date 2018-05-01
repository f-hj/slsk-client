/* eslint-env mocha */

const slsk = require('../lib/index.js')

const path = require('path')

describe('multi download', () => {
  let client
  let file1
  let file2
  let file3

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
      res.sort((a, b) => {
        return b.speed - a.speed
      })
      let indexFile = 0
      for (let i = 0; i < res.length; i++) {
        let ext = path.extname(res[i].file)
        if (res[i].slots >= 1 && ext === '.mp3') {
          file1 = res[i]
          indexFile = i
          console.log('file1', file1)
          break
        }
      }
      indexFile++

      for (let i = indexFile; i < res.length; i++) {
        let ext = path.extname(res[i].file)
        if (res[i].slots >= 1 && ext === '.mp3') {
          file2 = res[i]
          indexFile = i
          console.log('file2', file2)
          break
        }
      }
      indexFile++

      for (let i = indexFile; i < res.length; i++) {
        let ext = path.extname(res[i].file)
        if (res[i].slots >= 1 && ext === '.mp3') {
          file3 = res[i]
          console.log('file3', file3)
          return done()
        }
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

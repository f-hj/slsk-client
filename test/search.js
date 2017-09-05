const path = require('path')

const slsk = require('../lib/index.js')

describe('search', () => {

  let client
  let file

  it('must login', (done) => {
    slsk.connect({
      user: 'IAmWebServer',
      pass: 'IAmPassword'
    }, (err, res) => {
      client = res
      done(err)
    })
  })

  it('must search correctly', (done) => {
    client.search({
      req: 'moby play',
      timeout: 4000
    }, (err, res) => {
      if (err) return done(err)
      for (let i = 0; i < res.length; i++) {
        let ext = path.extname(res[i].file)
        if (res[i].slots >= 1 && ext === '.mp3') {
          file = res[i]
          console.log(file)
          return done()
        }
      }
      done(new Error('Test: no file with free slot'))
    })
  }).timeout(20000) //5000

  it('must download correctly', (done) => {
    client.download(file, (err, down) => {
      if (err) return done(err)
      console.log(down)
      if (down.buffer && down.buffer.length > 0) {
        done()
      }
    })
  }).timeout(240000)

})

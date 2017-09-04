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
      req: 'moby play'
    }, (err, res) => {
      if (err) return done(err)
      for (let i = 0; i < res.length; i++) {
        if (res[i].slots >= 1) {
          file = res[i]
          return done()
        }
      }
      done(new Error('Test: no file with free slot'))
    })
  }).timeout(20000) //5000

  it('must download correctly', (done) => {
    client.download(file)
  }).timeout(240000)

})

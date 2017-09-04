const assert = require('assert')

const slsk = require('../lib/index.js')

describe('login', () => {

  it('must login', (done) => {
    slsk.connect({
      user: 'IAmWebServer',
      pass: 'IAmPassword'
    }, (err, res) => {
      done(err)
    })
  })

  it('must close socket', () => {
    slsk.disconnect()
  })

  it('must not login', (done) => {
    slsk.connect({
      user: 'IAmWebServer',
      pass: 'IAmInvalidPassword'
    }, (err, res) => {
      assert.equal(err.message, 'INVALIDPASS')
      done()
    })
  })

})

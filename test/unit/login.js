/* eslint-env mocha */

const assert = require('assert')
const slsk = require('../../lib/index.js')
const MockServer = require('./mock-server.js')

describe('login', () => {
  const serverAddress = {
    host: 'localhost',
    port: 2242
  }
  let mockServer = new MockServer(serverAddress)
  mockServer.on('login', login => {
    if (login.username === 'ImTheUsername' && login.password === 'EasyButRight') {
      mockServer.loginSuccess(login.client)
    } else {
      mockServer.loginFail(login.client)
    }
  })

  it('must login with valid credentials', (done) => {
    slsk.connect({
      user: 'ImTheUsername',
      pass: 'EasyButRight',
      server: serverAddress
    }, (err, res) => {
      done(err)
    })
  })

  it('must not login with invalid credentials', (done) => {
    slsk.connect({
      user: 'IAmWebServer',
      pass: 'IAmWrong',
      server: serverAddress
    }, (err, res) => {
      assert.strictEqual(err.message, 'INVALIDPASS')
      done()
    })
  })
})

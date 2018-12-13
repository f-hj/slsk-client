/* eslint-env mocha */

const assert = require('assert')
const slsk = require('../lib/index.js')
const MockServer = require('./mock-server.js')

describe('login', () => {
  const serverHost = 'localhost'
  const serverPort = 2242
  let client

  let mockServer = new MockServer({
    host: serverHost,
    port: serverPort
  })
  mockServer.on('login', login => {
    if (login.username === 'ImTheUsername' && login.password === 'EasyButRight') {
      mockServer.loginSuccess(login.client)
    } else {
      mockServer.loginFail(login.client)
    }
  })

  after(() => {
    if (client) client.destroy()
    mockServer.destroy()
  })

  it('must login with valid credentials', (done) => {
    slsk.connect({
      user: 'ImTheUsername',
      pass: 'EasyButRight',
      host: serverHost,
      port: serverPort
    }, (err, res) => {
      client = res
      done(err)
    })
  })

  it('must not login with invalid credentials', (done) => {
    slsk.connect({
      user: 'IAmWebServer',
      pass: 'IAmWrong',
      host: serverHost,
      port: serverPort
    }, (err, res) => {
      assert.strictEqual(err.message, 'INVALIDPASS')
      done()
    })
  })
})

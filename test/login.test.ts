import assert from 'assert'
import { SlskClient } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'

describe('login', () => {
  const serverHost = 'localhost'
  const serverPort = 2242
  let client: SlskClient | undefined

  const mockServer = new MockServer({
    host: serverHost,
    port: serverPort
  })
  mockServer.on('login', (login: LoginEvent) => {
    if (login.username === 'ImTheUsername' && login.password === 'EasyButRight') {
      mockServer.loginSuccess(login.client)
    } else if (login.username === 'IAmSlow') {
      // never answer, the client must time out
    } else {
      mockServer.loginFail(login.client)
    }
  })

  after(() => {
    if (client) client.destroy()
    mockServer.destroy()
  })

  it('must login with valid credentials, sending Login as the first message', async () => {
    const loginEvent = new Promise<LoginEvent>(resolve => mockServer.once('login', resolve))

    client = await connectClient({
      user: 'ImTheUsername',
      pass: 'EasyButRight',
      host: serverHost,
      port: serverPort
    })
    assert.ok(client instanceof SlskClient)

    // the real server never answers when anything is sent before Login
    assert.deepStrictEqual((await loginEvent).precedingCodes, [])
  })

  it('logs in a client built directly, without any other call', async () => {
    const direct = new SlskClient({
      host: serverHost,
      port: serverPort,
      incomingPort: 2301
    })

    try {
      await direct.login('ImTheUsername', 'EasyButRight')
      assert.strictEqual(direct.username, 'ImTheUsername')
      assert.strictEqual(direct.shares.stats().files, 0)
    } finally {
      direct.destroy()
    }
  })

  it('connects to the public server when no address is given', () => {
    const defaults = new SlskClient()

    assert.deepStrictEqual(defaults.serverAddress, { host: 'server.slsknet.org', port: 2242 })
    assert.strictEqual(defaults.incomingPort, 2234)
  })

  it('must not login with invalid credentials', async () => {
    await assert.rejects(
      connectClient({
        user: 'IAmWebServer',
        pass: 'IAmWrong',
        host: serverHost,
        port: serverPort
      }),
      { message: 'INVALIDPASS' }
    )
  })

  it('must reject when the server never answers the login', async () => {
    await assert.rejects(
      connectClient({
        user: 'IAmSlow',
        pass: 'DoesNotMatter',
        host: serverHost,
        port: serverPort,
        timeout: 500
      }),
      { message: 'timeout login' }
    )
  })

  it('must reject when the server is unreachable', async () => {
    await assert.rejects(
      connectClient({
        user: 'Anyone',
        pass: 'Anything',
        host: serverHost,
        port: 59999 // nothing listens there
      })
    )
  })
})

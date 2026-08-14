import assert from 'assert'
import slsk, { SlskClient } from '../src/index'
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

    client = await slsk.connect({
      user: 'ImTheUsername',
      pass: 'EasyButRight',
      host: serverHost,
      port: serverPort
    })
    assert.ok(client instanceof SlskClient)

    // the real server never answers when anything is sent before Login
    assert.deepStrictEqual((await loginEvent).precedingCodes, [])
  })

  it('must not login with invalid credentials', async () => {
    await assert.rejects(
      slsk.connect({
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
      slsk.connect({
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
      slsk.connect({
        user: 'Anyone',
        pass: 'Anything',
        host: serverHost,
        port: 59999 // nothing listens there
      })
    )
  })
})

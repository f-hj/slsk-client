import assert from 'assert'
import net from 'net'
import { LoginRefusedError, SlskClient } from '../src/index'
import MockServer, { type LoginEvent } from './mock-server'

describe('server connection', () => {
  const address = { host: '127.0.0.1', port: 2246 }
  const clients: SlskClient[] = []
  /** Server side of every connection a client logged in on, in order */
  const sockets: net.Socket[] = []
  let mockServer: MockServer
  /** Set by the test that checks what happens when the credentials stop working */
  let refuseLogin = false

  before(() => {
    mockServer = new MockServer(address)
    mockServer.on('login', (login: LoginEvent) => {
      sockets.push(login.client)
      if (refuseLogin) {
        mockServer.loginFail(login.client)
        return
      }
      mockServer.loginSuccess(login.client)
    })
  })

  after(() => {
    clients.forEach(client => client.destroy())
    mockServer.destroy()
  })

  /** Logs a client in and keeps it around, so a failing test leaves no socket behind */
  const login = async (options: { incomingPort: number, reconnect?: boolean | { delay: number } }): Promise<SlskClient> => {
    const client = new SlskClient({ ...address, ...options })
    clients.push(client)
    await client.login('ImTheUsername', 'EasyButRight')
    return client
  }

  it('reports the drop and logs in again', async () => {
    const client = await login({ incomingPort: 2310, reconnect: { delay: 50 } })

    const dropped = new Promise<{ reconnecting: boolean }>(resolve =>
      client.once('server-disconnect', resolve))
    const reconnected = new Promise<void>(resolve =>
      client.once('server-reconnect', () => resolve()))
    const secondLogin = new Promise<LoginEvent>(resolve => mockServer.once('login', resolve))

    mockServer.disconnect(sockets[sockets.length - 1])

    assert.deepStrictEqual(await dropped, { reconnecting: true })
    assert.strictEqual((await secondLogin).username, 'ImTheUsername')
    await reconnected
  })

  it('leaves the drop to the caller when reconnecting is turned off', async () => {
    const client = await login({ incomingPort: 2311, reconnect: false })
    const logins = sockets.length

    const dropped = new Promise<{ reconnecting: boolean }>(resolve =>
      client.once('server-disconnect', resolve))

    mockServer.disconnect(sockets[sockets.length - 1])

    assert.deepStrictEqual(await dropped, { reconnecting: false })
    await new Promise<void>(resolve => setTimeout(resolve, 200))
    assert.strictEqual(sockets.length, logins, 'nothing must have logged in again')

    // the caller decides when to come back, on the same client
    await client.login('ImTheUsername', 'EasyButRight')
    assert.strictEqual(sockets.length, logins + 1)
  })

  it('gives up when the server refuses the credentials it comes back with', async () => {
    const client = await login({ incomingPort: 2313, reconnect: { delay: 20 } })

    // the dropped socket also reports an ECONNRESET, the refusal is the one to wait for
    const refused = new Promise<LoginRefusedError>(resolve => {
      const onError = (err: Error): void => {
        if (!(err instanceof LoginRefusedError)) return
        client.off('server-error', onError)
        resolve(err)
      }
      client.on('server-error', onError)
    })
    const givenUp = new Promise<{ reconnecting: boolean }>(resolve => {
      // the first one announces the reconnection, the second one that it will not happen
      client.once('server-disconnect', () => client.once('server-disconnect', resolve))
    })

    refuseLogin = true
    try {
      mockServer.disconnect(sockets[sockets.length - 1])

      assert.ok(await refused instanceof LoginRefusedError)
      assert.deepStrictEqual(await givenUp, { reconnecting: false })

      const logins = sockets.length
      await new Promise<void>(resolve => setTimeout(resolve, 200))
      assert.strictEqual(sockets.length, logins, 'refused credentials must not be retried')
    } finally {
      refuseLogin = false
    }
  })

  it('stops trying to reconnect once the client is destroyed', async () => {
    const client = await login({ incomingPort: 2312, reconnect: { delay: 5000 } })

    const dropped = new Promise<void>(resolve => client.once('server-disconnect', () => resolve()))
    mockServer.disconnect(sockets[sockets.length - 1])
    await dropped

    const logins = sockets.length
    client.destroy()

    await new Promise<void>(resolve => setTimeout(resolve, 200))
    assert.strictEqual(sockets.length, logins, 'a destroyed client must not come back')
  })
})

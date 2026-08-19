import assert from 'assert'
import { SlskClient, memoryShareProvider, type ShareProvider } from '../src/index'
import MockServer, { type LoginEvent } from './mock-server'

/** A provider that takes its time before yielding anything, like a big share on a slow volume */
function slowProvider (delay: number, path: string): ShareProvider {
  return {
    name: 'slow',
    list: async function * () {
      await new Promise<void>(resolve => setTimeout(resolve, delay))
      yield { path, size: 3 }
    },
    read: () => { throw new Error('not needed here') }
  }
}

describe('share listing', () => {
  const serverAddress = { host: '127.0.0.1', port: 2248 }
  let mockServer: MockServer

  before(() => {
    mockServer = new MockServer(serverAddress)
    mockServer.on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
  })

  after(() => {
    mockServer.destroy()
  })

  it('logs in without waiting for the listing, and says when it is over', async () => {
    const loginEvent = new Promise<LoginEvent>(resolve => mockServer.once('login', resolve))
    const client = new SlskClient({
      ...serverAddress,
      incomingPort: 2296,
      shares: slowProvider(400, 'music\\slow.mp3'),
      // the login must go out and be answered long before the listing is over
      timeout: 200
    })

    try {
      const ready: Array<{ files: number }> = []
      client.on('shares-ready', stats => ready.push(stats))

      await client.login('me', 'secret')

      // the connection must not sit unauthenticated while the share is walked
      assert.deepStrictEqual((await loginEvent).precedingCodes, [])
      assert.strictEqual(client.shares.stats().files, 0, 'the listing is still running')
      assert.deepStrictEqual(ready, [])

      await client.sharesReady
      assert.strictEqual(client.shares.stats().files, 1)
      assert.deepStrictEqual(ready, [{ folders: 1, files: 1 }])
    } finally {
      client.destroy()
    }
  })

  it('lists a provider added before the login', async () => {
    const client = new SlskClient({ ...serverAddress, incomingPort: 2295 })

    try {
      // `shares` is usable before login, whatever is added is listed once logged in
      client.shares.addProvider(memoryShareProvider({ 'late\\song.mp3': 'data' }))

      await client.login('me', 'secret')
      await client.sharesReady

      assert.deepStrictEqual(client.shares.stats(), { folders: 1, files: 1 })
    } finally {
      client.destroy()
    }
  })

  it('reports a listing that failed instead of rejecting the login', async () => {
    const failing: ShareProvider = {
      name: 'failing',
      list: () => { throw new Error('volume is gone') },
      read: () => { throw new Error('not needed here') }
    }
    const client = new SlskClient({ ...serverAddress, incomingPort: 2294, shares: failing })

    try {
      await client.login('me', 'secret')
      // a provider that cannot be listed is dropped by the index, the client stays usable
      await client.sharesReady
      assert.strictEqual(client.shares.stats().files, 0)
    } finally {
      client.destroy()
    }
  })
})

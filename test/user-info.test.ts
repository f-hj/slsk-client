import assert from 'assert'
import { SlskClient, UploadPermission, type UserInfo } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockDefaultPeer, { type MockUserInfo } from './mock-default-peer'

describe('getUserInfo', () => {
  const serverAddress = { host: '127.0.0.1', port: 2246 }
  const peerAddress = { host: '127.0.0.1', port: 4253 }
  const incomingPort = 2298

  const peerName = 'alice'
  const picture = Buffer.from('a jpeg, allegedly')
  const info: MockUserInfo = {
    description: 'i share what i like',
    picture,
    uploadSlots: 2,
    queueSize: 42,
    slotsFree: false,
    uploadPermitted: UploadPermission.Everyone
  }

  let client: SlskClient
  let mockServer: MockServer
  let mockPeer: MockDefaultPeer

  before(async () => {
    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(
          evt.client,
          evt.user,
          peerAddress.host,
          // the slsk server answers port 0 for a user that is not connected
          evt.user === peerName ? peerAddress.port : 0
        ))

    mockPeer = new MockDefaultPeer(peerAddress, { userInfo: info })

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort
    })
  })

  after(() => {
    if (client) client.destroy()
    mockPeer.destroy()
    mockServer.destroy()
  })

  it('asks a peer what it tells about itself', async () => {
    const asked = new Promise<void>(resolve => mockPeer.once('user-info-request', resolve))

    const received = await client.getUserInfo(peerName)

    await asked
    assert.deepStrictEqual(received, {
      user: peerName,
      description: info.description,
      picture,
      uploadSlots: 2,
      queueSize: 42,
      slotsFree: false,
      uploadPermitted: UploadPermission.Everyone
    } satisfies UserInfo)
  })

  it('rejects when the peer never answers', async () => {
    const silent = new MockDefaultPeer({ host: '127.0.0.1', port: 4254 })
    const silentServer = new MockServer({ host: '127.0.0.1', port: 2247 })
    silentServer
      .on('login', (login: LoginEvent) => silentServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        silentServer.returnPeerAddress(evt.client, evt.user, '127.0.0.1', 4254))

    const other = await connectClient({
      user: 'me',
      pass: 'secret',
      host: '127.0.0.1',
      port: 2247,
      incomingPort: 2297
    })

    try {
      await assert.rejects(other.getUserInfo('bob', 200), {
        message: 'UserInfo timed out for bob'
      })
    } finally {
      other.destroy()
      silent.destroy()
      silentServer.destroy()
    }
  })
})

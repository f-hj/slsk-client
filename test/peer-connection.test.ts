import assert from 'assert'
import net from 'net'
import { type SlskClient } from '../src/index'
import Message from '../src/utils/message'
import Messages from '../src/utils/messages'
import peerMessages from '../src/peer/messages'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'

/** Resolves with the code of every message the client sends on the connection */
function codesOn (socket: net.Socket): number[] {
  const codes: number[] = []
  const msgs = new Messages()
  socket.on('data', data => msgs.write(data))
  socket.on('error', () => {})
  msgs.on('message', (msg: Message) => {
    msg.int32() // size
    codes.push(msg.int32())
  })
  return codes
}

function wait (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('peer connection reuse', () => {
  const serverAddress = { host: '127.0.0.1', port: 2253 }
  const incomingPort = 2296
  /** Where the client would dial the peer back, listening only to count the attempts */
  const relayedPort = 2297
  const peerName = 'archivist'

  let client: SlskClient
  let mockServer: MockServer
  let serverLink: net.Socket
  let trap: net.Server
  let dialled: number

  before(async () => {
    dialled = 0
    trap = net.createServer(socket => {
      dialled++
      socket.destroy()
    })
    await new Promise<void>(resolve => trap.listen(relayedPort, '127.0.0.1', resolve))

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => {
        serverLink = login.client
        mockServer.loginSuccess(login.client)
      })
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(evt.client, evt.user, '127.0.0.1', relayedPort))

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
    mockServer.destroy()
    trap.close()
  })

  it('answers a relayed ConnectToPeer on the connection the peer already opened', async () => {
    const socket = net.createConnection({ host: '127.0.0.1', port: incomingPort })
    const codes = codesOn(socket)
    await new Promise<void>(resolve => socket.once('connect', resolve))
    socket.write(peerMessages.peerInit(peerName, 'P', '00000000').getBuff())

    try {
      // the peer raced a direct connection, which just won, against a request relayed by the
      // server: dialling it back would replace a connection that works with one that may not
      await wait(100)
      mockServer.askToConnect(serverLink, peerName, 'P', '127.0.0.1', relayedPort, 'deadbeef')
      await wait(300)

      assert.strictEqual(dialled, 0, 'the client must not dial a peer it is already connected to')

      // and the connection it kept is the one it uses
      client.getUserInfo(peerName, 200).catch(() => {})
      await wait(100)
      assert.deepStrictEqual(codes, [15], 'the UserInfoRequest must go out on the open connection')
    } finally {
      socket.destroy()
    }
  })

  it('drops the second connection a peer opens, keeping the one that works', async () => {
    const other = 'duplicator'
    const first = net.createConnection({ host: '127.0.0.1', port: incomingPort })
    first.on('error', () => {})
    await new Promise<void>(resolve => first.once('connect', resolve))
    first.write(peerMessages.peerInit(other, 'P', '00000000').getBuff())
    await wait(100)

    const second = net.createConnection({ host: '127.0.0.1', port: incomingPort })
    second.on('error', () => {})
    const closed = new Promise<void>(resolve => second.once('close', () => resolve()))
    await new Promise<void>(resolve => second.once('connect', resolve))
    second.write(peerMessages.peerInit(other, 'P', '00000000').getBuff())

    try {
      await Promise.race([
        closed,
        wait(500).then(() => { throw new Error('the duplicate connection stayed open') })
      ])
      assert.strictEqual(first.destroyed, false, 'the connection that works must be kept')
    } finally {
      first.destroy()
      second.destroy()
    }
  })
})

describe('download on a connection that dies', () => {
  const serverAddress = { host: '127.0.0.1', port: 2254 }
  const peerAddress = { host: '127.0.0.1', port: 2298 }
  const incomingPort = 2295
  const peerName = 'ghost'
  const remoteFile = 'music\\great song.mp3'

  let client: SlskClient
  let mockServer: MockServer
  /** Accepts the connection, reads what the client asks and hangs up without answering */
  let deafPeer: net.Server
  let received: number[]

  before(async () => {
    received = []
    deafPeer = net.createServer(socket => {
      socket.on('error', () => {})
      socket.once('data', () => {
        // whatever the client wrote after its PeerInit is lost with the connection
        received.push(1)
        socket.destroy()
      })
    })
    await new Promise<void>(resolve => deafPeer.listen(peerAddress.port, peerAddress.host, resolve))

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(evt.client, evt.user, peerAddress.host, peerAddress.port))

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort,
      queueFallbackDelay: 200
    })
  })

  after(() => {
    if (client) client.destroy()
    mockServer.destroy()
    deafPeer.close()
  })

  it('fails the download instead of taking the peer for one that ignores the queue', async () => {
    const download = client.download({ user: peerName, file: remoteFile, size: 10 })

    await assert.rejects(download.promise, /Lost the connection to ghost/)
    assert.strictEqual(received.length, 1, 'the peer received the request before hanging up')
  }).timeout(5000)
})

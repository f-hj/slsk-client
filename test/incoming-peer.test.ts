import assert from 'assert'
import net from 'net'
import { type SlskClient } from '../src/index'
import Message from '../src/utils/message'
import Messages from '../src/utils/messages'
import peerMessages from '../src/peer/messages'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'

/**
 * Opens a connection to the listening port of the client and introduces itself as `user`.
 * `andThen` is written on the same connection, right after the PeerInit: anything written
 * outside of the connect callback would be flushed before it.
 */
function peerInit (port: number, user: string, andThen?: Buffer): net.Socket {
  const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
    socket.write(peerMessages.peerInit(user, 'P', '00000000').getBuff())
    if (andThen) socket.write(andThen)
  })
  return socket
}

/** Resolves with the code of the first message the client sends back, or null when it hangs up */
function firstAnswer (socket: net.Socket): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const msgs = new Messages()
    socket.on('data', data => msgs.write(data))
    socket.on('error', reject)
    socket.on('close', () => resolve(null))

    msgs.on('message', (msg: Message) => {
      msg.int32() // size
      resolve(msg.int32())
    })
  })
}

describe('incoming peer connection', () => {
  const serverAddress = { host: '127.0.0.1', port: 2251 }
  const incomingPort = 2294
  const username = 'gcrusty'

  let client: SlskClient
  let mockServer: MockServer

  before(async () => {
    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      // asked for whoever connects to us, answered so nothing waits on it
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(evt.client, evt.user, '127.0.0.1', 9))

    client = await connectClient({
      user: username,
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort
    })
  })

  after(() => {
    if (client) client.destroy()
    mockServer.destroy()
  })

  it('closes a connection that introduces itself with our own name', async () => {
    const socket = peerInit(incomingPort, username)

    try {
      // a PeerInit names whoever opened the connection, so our own name is either us reaching
      // our own address or a peer lying: either way it must not end up in the peer map
      assert.strictEqual(await firstAnswer(socket), null, 'the connection must be closed')
    } finally {
      socket.destroy()
    }
  })

  it('keeps a connection that introduces itself with another name', async () => {
    const userInfoRequest = new Message().int32(15).getBuff()
    const socket = peerInit(incomingPort, 'someone else', userInfoRequest)

    try {
      assert.strictEqual(await firstAnswer(socket), 16, 'the peer must be answered a UserInfoResponse')
    } finally {
      socket.destroy()
    }
  })
})

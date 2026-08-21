import assert from 'assert'
import net from 'net'
import { memoryShareProvider, type SlskClient } from '../src/index'
import Message from '../src/utils/message'
import Messages from '../src/utils/messages'
import peerMessages from '../src/peer/messages'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'

/** A port nothing should ever be dialled on, watching whether the client tries anyway */
class Watcher {
  private readonly server: net.Server
  private readonly connections: net.Socket[] = []

  constructor (readonly port: number) {
    this.server = net.createServer(c => {
      this.connections.push(c)
      c.on('error', () => {})
    })
    this.server.listen(port, '127.0.0.1')
  }

  /** Connections accepted after waiting long enough for one to show up */
  async accepted (): Promise<number> {
    await new Promise<void>(resolve => setTimeout(resolve, 300))
    return this.connections.length
  }

  destroy (): void {
    this.connections.forEach(c => c.destroy())
    this.server.close()
  }
}

describe('peer connection types', () => {
  const serverAddress = { host: '127.0.0.1', port: 2253 }
  const incomingPort = 2296
  const watchedPort = 4257
  const user = 'szczupsarr'
  const file = 'music\\great song.mp3'

  let client: SlskClient
  let mockServer: MockServer
  let serverSide: net.Socket
  let watcher: Watcher

  beforeEach(async () => {
    watcher = new Watcher(watchedPort)
    mockServer = new MockServer(serverAddress)
    mockServer.on('login', (login: LoginEvent) => {
      serverSide = login.client
      mockServer.loginSuccess(login.client)
    })

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort,
      uploads: true,
      shares: memoryShareProvider([{ path: file, data: 'data' }])
    })
    await client.sharesReady
  })

  afterEach(() => {
    client.destroy()
    mockServer.destroy()
    watcher.destroy()
  })

  /** Opens a peer connection to the client, as a peer reaching us directly does */
  const peerConnection = async (): Promise<net.Socket> => {
    const socket = await new Promise<net.Socket>(resolve => {
      const conn = net.createConnection({ host: '127.0.0.1', port: incomingPort }, () => {
        conn.write(peerMessages.peerInit(user, 'P', '455f2600').getBuff())
        resolve(conn)
      })
      conn.on('error', () => {})
    })
    // let the client register the peer before anything else happens
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    return socket
  }

  it('opens a peer connection to a user it is already connected to as a parent', async () => {
    // the server hands out a distributed parent, then that same user asks for a peer connection:
    // the two carry different traffic, one must not evict the other
    const parent = new Watcher(4258)

    try {
      mockServer.netInfo(serverSide, user, '127.0.0.1', parent.port)
      assert.strictEqual(await parent.accepted(), 1, 'the parent must be connected to')

      mockServer.askToConnect(serverSide, user, 'P', '127.0.0.1', watchedPort, '435f2600')

      assert.strictEqual(await watcher.accepted(), 1,
        'the relayed peer connection must be opened, the parent is another connection')
    } finally {
      parent.destroy()
    }
  }).timeout(10000)

  it('closes an incoming connection of a type it does not serve', async () => {
    const socket = await new Promise<net.Socket>(resolve => {
      const conn = net.createConnection({ host: '127.0.0.1', port: incomingPort }, () => {
        // a peer asking us to be its distributed parent: we serve no children
        conn.write(peerMessages.peerInit(user, 'D', '00000000').getBuff())
        resolve(conn)
      })
      conn.on('error', () => {})
    })

    try {
      await new Promise<void>(resolve => socket.on('close', resolve))
      assert.ok(socket.destroyed, 'the connection must be closed')
    } finally {
      socket.destroy()
    }
  }).timeout(10000)

  it('does not connect to a peer just because the server sent its address', async () => {
    // the address of a peer is asked for every peer that connects to us, to know the port it
    // listens on: nothing is waiting for a connection to it
    mockServer.returnPeerAddress(serverSide, 'stranger', '127.0.0.1', watchedPort)

    assert.strictEqual(await watcher.accepted(), 0,
      'an address nobody asked to connect to must not open a connection')
  }).timeout(10000)

  it('records the address of a connected peer, for the file connections it needs', async () => {
    const socket = await peerConnection()

    try {
      // the client asked for it when the peer connected, this is the answer of the server
      mockServer.returnPeerAddress(serverSide, user, '127.0.0.1', watchedPort)
      await new Promise<void>(resolve => setTimeout(resolve, 100))

      // it is used to send a file: the peer asks for one, accepts the transfer the client
      // announces, and the client dials the recorded port to send the bytes
      const msgs = new Messages()
      socket.on('data', data => msgs.write(data))
      msgs.on('message', (msg: Message) => {
        msg.int32() // size
        if (msg.int32() !== 40) return // TransferRequest
        msg.int32() // direction
        const token = msg.rawHexStr(4)
        socket.write(new Message().int32(41).rawHexStr(token).int8(1).getBuff())
      })

      socket.write(new Message().int32(43).str(file).getBuff()) // QueueUpload

      assert.strictEqual(await watcher.accepted(), 1,
        'the file connection must be opened to the address the server gave')
    } finally {
      socket.destroy()
    }
  }).timeout(10000)
})

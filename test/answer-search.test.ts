import assert from 'assert'
import net from 'net'
import zlib from 'zlib'
import crypto from 'crypto'
import { SlskClient, memoryShareProvider } from '../src/index'
import Messages from '../src/utils/messages'
import Message from '../src/utils/message'
import { parseFileSearchResult, type FileSearchResult } from '../src/peer/default-peer/messages'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockDistributedPeer, { type PeerInitEvent } from './mock-distributed-peer'

/**
 * Plays a searcher that cannot be reached directly, which is the common case: it never accepts
 * a connection, it answers the ConnectToPeer the server relays by connecting to us and piercing
 * our firewall, then reads what we send on that connection.
 */
function pierceAndRead (port: number, token: string): Promise<FileSearchResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(new Message().int8(0).rawHexStr(token).getBuff())
    })

    const msgs = new Messages()
    socket.on('data', data => msgs.write(data))
    socket.on('error', reject)

    msgs.on('message', (msg: Message) => {
      const size = msg.int32()
      const code = msg.int32()
      if (code !== 9) return
      const content = msg.data.subarray(msg.pointer, size + 4)
      resolve(parseFileSearchResult(zlib.unzipSync(content)))
      socket.destroy()
    })
  })
}

describe('answering a search', () => {
  const serverAddress = { host: '127.0.0.1', port: 2250 }
  const distributedPeerAddress = { host: '127.0.0.1', port: 3251 }
  const incomingPort = 2292
  const searcher = 'firewalled searcher'

  let client: SlskClient
  let mockServer: MockServer
  let mockDistributedPeer: MockDistributedPeer

  after(() => {
    if (client) client.destroy()
    mockServer.destroy()
    mockDistributedPeer.destroy()
  })

  it('reaches a searcher that cannot accept a direct connection', async () => {
    mockServer = new MockServer(serverAddress)
    mockDistributedPeer = new MockDistributedPeer(distributedPeerAddress)

    const answer = new Promise<FileSearchResult>((resolve, reject) => {
      mockServer
        .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
        .on('have-no-parent', evt => mockServer.netInfo(
          evt.client, 'parent', distributedPeerAddress.host, distributedPeerAddress.port
        ))
        // port 0 is what the server answers for a user it cannot place, so the direct
        // connection cannot be the one that delivers the results
        .on('get-peer-address', evt =>
          mockServer.returnPeerAddress(evt.client, evt.user, '127.0.0.1', 0))
        .on('connect-to-peer', evt => {
          assert.strictEqual(evt.user, searcher)
          assert.strictEqual(evt.type, 'P')
          pierceAndRead(incomingPort, evt.token).then(resolve, reject)
        })
    })

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort,
      shares: memoryShareProvider({ 'music\\great song.mp3': 'data' })
    })
    await client.sharesReady

    const parent = await new Promise<PeerInitEvent>(resolve => {
      mockDistributedPeer.once('peer-init', resolve)
    })
    const ticket = crypto.randomBytes(4).toString('hex')
    mockDistributedPeer.searchRequest(parent.client, searcher, ticket, 'song')

    const result = await answer
    assert.strictEqual(result.currentToken, ticket, 'the ticket of the search is echoed back')
    assert.strictEqual(result.files.length, 1)
    assert.strictEqual(result.files[0].file, 'music\\great song.mp3')
    assert.strictEqual(result.files[0].user, 'me')
  }).timeout(15000)
})

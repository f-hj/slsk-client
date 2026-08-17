import assert from 'assert'
import fs from 'fs'
import crypto from 'crypto'
import { FileAttribute, fsShareProvider, memoryShareProvider, SlskClient } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockDistributedPeer, { type PeerInitEvent } from './mock-distributed-peer'
import MockDefaultPeer from './mock-default-peer'
import type { FileSearchResult } from '../src/peer/default-peer/messages'

describe('file-sharing', () => {
  const baseFolder = '/tmp/slsk-client/file-sharing'

  const serverAddress = { host: '127.0.0.1', port: 2243 }
  const distributedPeerAddress = { host: '127.0.0.1', port: 3250 }
  const defaultPeerAddress = { host: '127.0.0.1', port: 4250 }

  let client: SlskClient | undefined
  let mockServer: MockServer
  let mockDistributedPeer: MockDistributedPeer
  let mockDefaultPeer: MockDefaultPeer

  before(async () => {
    await fs.promises.mkdir(baseFolder, { recursive: true })
    await fs.promises.writeFile(baseFolder + '/great song.mp3', 'data')

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('have-no-parent', netInfo => mockServer.netInfo(netInfo.client, 'parent', distributedPeerAddress.host, distributedPeerAddress.port))
      .on('get-peer-address', getPeerAddress => mockServer.returnPeerAddress(getPeerAddress.client, 'user', defaultPeerAddress.host, defaultPeerAddress.port))

    mockDistributedPeer = new MockDistributedPeer(distributedPeerAddress)
    mockDistributedPeer.on('peer-init', (peerInfo: PeerInitEvent) => {
      const ticket = crypto.randomBytes(4).toString('hex')
      mockDistributedPeer.searchRequest(peerInfo.client, 'user', ticket, 'song')
      // the second search request is to verify handling of the same request received eventually from another 'parent' (real case)
      mockDistributedPeer.searchRequest(peerInfo.client, 'user', ticket, 'song')
    })

    mockDefaultPeer = new MockDefaultPeer(defaultPeerAddress)
  })

  after(() => {
    if (client) client.destroy()
    mockServer.destroy()
    mockDistributedPeer.destroy()
    mockDefaultPeer.destroy()
  })

  it('must send file search result to client who searched', async () => {
    const fileSearchResult = new Promise<FileSearchResult>(resolve => {
      mockDefaultPeer.once('file-search-result', resolve)
    })

    client = await connectClient({
      user: 'any',
      pass: 'any',
      host: serverAddress.host,
      port: serverAddress.port,
      shares: [
        fsShareProvider({ folders: [baseFolder] }),
        // a share that is not on the local file system, answered from the same index
        memoryShareProvider([
          { path: 'bucket\\remote song.flac', data: 'remote data', attribs: { [FileAttribute.Bitrate]: 1411 } }
        ])
      ]
    })

    const result = await fileSearchResult
    const file = result.files[0]
    // peers see a virtual path rooted at the shared folder, not the local one
    assert.strictEqual(file.file, 'file-sharing\\great song.mp3')
    assert.strictEqual(file.size, 4)
    assert.strictEqual(file.user, 'any')

    const remote = result.files[1]
    assert.strictEqual(remote.file, 'bucket\\remote song.flac')
    assert.strictEqual(remote.size, 11)
    assert.deepStrictEqual(remote.attribs, { [FileAttribute.Bitrate]: 1411 })

    assert.deepStrictEqual(client.shares.stats(), { folders: 2, files: 2 })
  })
})

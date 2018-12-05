/* eslint-env mocha */

const assert = require('assert')
const slsk = require('../lib/index.js')
const fs = require('fs')
const crypto = require('crypto')
const MockServer = require('./mock-server.js')
const MockDistributedPeer = require('./mock-distributed-peer.js')
const MockDefaultPeer = require('./mock-default-peer.js')

describe('file-sharing', () => {
  let baseFolder = '/tmp/slsk-client/file-sharing'
  createFolder(baseFolder)
  fs.writeFileSync(baseFolder + '/great song.mp3', 'data')

  const serverAddress = { host: '127.0.0.1', port: 2243 }
  const distributedPeerAddress = { host: '127.0.0.1', port: 3250 }
  const defaultPeerAddress = { host: '127.0.0.1', port: 4250 }

  let mockServer = new MockServer(serverAddress)
    .on('login', login => mockServer.loginSuccess(login.client))
    .on('have-no-parent', netInfo => mockServer.netInfo(netInfo.client, 'parent', distributedPeerAddress.host, distributedPeerAddress.port))
    .on('get-peer-address', getPeerAddress => mockServer.returnPeerAddress(getPeerAddress.client, 'user', defaultPeerAddress.host, defaultPeerAddress.port))

  let mockDistributedPeer = new MockDistributedPeer(distributedPeerAddress)
    .on('peer-init', peerInfo => {
      let ticket = crypto.randomBytes(4).toString('hex')
      mockDistributedPeer.searchRequest(peerInfo.client, 'user', ticket, 'song')
      // the second search request is to verify handling of the same request received eventually from another 'parent' (real case)
      mockDistributedPeer.searchRequest(peerInfo.client, 'user', ticket, 'song')
    })

  let mockDefaultPeer = new MockDefaultPeer(defaultPeerAddress)

  it('must sends file search result to client who searched', (done) => {
    slsk.connect({
      user: 'any',
      pass: 'any',
      host: serverAddress.host,
      port: serverAddress.port,
      sharedFolders: ['/tmp/slsk-client/file-sharing']
    }, () => {})

    mockDefaultPeer.on('file-search-result', fileSearchResult => {
      let file = fileSearchResult.files[0]
      assert.strictEqual(file.file, baseFolder + '/great song.mp3')
      assert.strictEqual(file.size, 4)
      assert.strictEqual(file.user, 'any')
      done()
    })
  }).timeout(5000)

  after(() => {
    mockServer.destroy()
    mockDistributedPeer.destroy()
    mockDefaultPeer.destroy()
  })
})

function createFolder (path) {
  try {
    let opts = { recursive: true }
    fs.mkdirSync(path, opts)
  } catch (err) { }
}

import assert from 'assert'
import fs from 'fs'
import { SlskClient, type SearchResult } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockUploadPeer from './mock-upload-peer'

describe('interrupted download', () => {
  const baseFolder = '/tmp/slsk-client/download-resume'
  const serverAddress = { host: '127.0.0.1', port: 2249 }
  const peerAddress = { host: '127.0.0.1', port: 4255 }
  const incomingPort = 2293

  const uploader = 'quitter'
  const remoteFile = 'music\\long song.mp3'
  const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')

  let mockServer: MockServer

  const searchResult = (): SearchResult => ({
    user: uploader,
    file: remoteFile,
    size: data.length,
    slots: true,
    speed: 0,
    attribs: {}
  })

  const clientFor = async (retries?: number): Promise<SlskClient> => await connectClient({
    user: 'me',
    pass: 'secret',
    host: serverAddress.host,
    port: serverAddress.port,
    incomingPort,
    downloadRetries: retries
  })

  before(async () => {
    await fs.promises.mkdir(baseFolder, { recursive: true })

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(evt.client, evt.user, peerAddress.host, peerAddress.port))
  })

  after(() => {
    mockServer.destroy()
  })

  it('asks for the rest of a transfer the peer dropped mid file', async () => {
    const cutAfter = 10
    const mockPeer = new MockUploadPeer({
      address: peerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: uploader,
      cutAfter
    })
    const client = await clientFor()

    try {
      const offsets: number[] = []
      mockPeer.on('offset', offset => offsets.push(offset))
      const interrupted: number[] = []
      client.on('download-interrupted', evt => interrupted.push(evt.receivedBytes))

      const path = baseFolder + '/resumed.mp3'
      const result = await client.download({ ...searchResult(), path })

      assert.deepStrictEqual(interrupted, [cutAfter], 'the drop must be reported, not ignored')
      assert.deepStrictEqual(offsets, [0, cutAfter], 'the second attempt starts where it stopped')
      assert.deepStrictEqual(result.buffer, data, 'the whole file must be there')
      assert.strictEqual(result.receivedBytes, data.length)
      assert.deepStrictEqual(await fs.promises.readFile(path), data)
    } finally {
      client.destroy()
      mockPeer.destroy()
    }
  }).timeout(10000)

  it('fails the download when the peer keeps dropping and the attempts run out', async () => {
    const alwaysCuts = new MockUploadPeer({
      address: peerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: uploader,
      cutAfter: 4
    })
    // every attempt is cut short, not only the first one
    Object.defineProperty(alwaysCuts, 'cut', { get: () => false, set: () => {} })

    const client = await clientFor(1)

    try {
      await assert.rejects(
        client.download({ ...searchResult(), path: baseFolder + '/hopeless.mp3' }).promise,
        /Transfer interrupted at \d+\/36 bytes, gave up after 1 retry/
      )
      assert.deepStrictEqual(client.downloads, [], 'a failed download is forgotten')
    } finally {
      client.destroy()
      alwaysCuts.destroy()
    }
  }).timeout(10000)
})

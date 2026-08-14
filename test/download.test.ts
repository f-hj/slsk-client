import assert from 'assert'
import fs from 'fs'
import slsk, { SlskClient, type DownloadProgress, type QueuePlace, type SearchResult } from '../src/index'
import MockServer, { type LoginEvent } from './mock-server'
import MockUploadPeer from './mock-upload-peer'

describe('download', () => {
  const baseFolder = '/tmp/slsk-client/download'
  const serverAddress = { host: '127.0.0.1', port: 2244 }
  const peerAddress = { host: '127.0.0.1', port: 4251 }
  const incomingPort = 2299

  const uploader = 'uploader'
  const remoteFile = 'music\\great song.mp3'
  const data = Buffer.from('this is definitely a mp3 file')

  let client: SlskClient
  let mockServer: MockServer
  let mockPeer: MockUploadPeer

  const searchResult = (): SearchResult => ({
    user: uploader,
    file: remoteFile,
    size: data.length,
    slots: true,
    speed: 0
  })

  before(async () => {
    await fs.promises.mkdir(baseFolder, { recursive: true })

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(
          evt.client,
          evt.user,
          peerAddress.host,
          // the slsk server answers port 0 for a user that is not connected
          evt.user === uploader ? peerAddress.port : 0
        ))

    mockPeer = new MockUploadPeer({
      address: peerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: uploader
    })

    client = await slsk.connect({
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

  it('downloads through the upload queue of the peer', async () => {
    const queued: QueuePlace[] = []
    const progress: DownloadProgress[] = []
    client.on('download-queue', place => queued.push(place))
    client.on('download-progress', it => progress.push(it))

    const queueUpload = new Promise<string>(resolve => mockPeer.once('queue-upload', resolve))
    const path = baseFolder + '/queued.mp3'

    const down = await client.download({ file: searchResult(), path })

    assert.strictEqual(await queueUpload, remoteFile, 'the peer must receive a QueueUpload')
    assert.deepStrictEqual(down.buffer, data)
    assert.strictEqual(down.receivedBytes, data.length)
    assert.strictEqual(down.size, data.length)
    assert.strictEqual(down.path, path)
    assert.deepStrictEqual(await fs.promises.readFile(path), data)

    assert.deepStrictEqual(queued, [{ user: uploader, file: remoteFile, place: 2 }])
    assert.ok(progress.length > 0, 'progress must be reported')
    const last = progress[progress.length - 1]
    assert.strictEqual(last.receivedBytes, data.length)
    assert.strictEqual(last.totalBytes, data.length)
    assert.strictEqual(last.progress, 1)
  })

  it('resumes a partial download from the given offset', async () => {
    const path = baseFolder + '/resumed.mp3'
    const offset = 10
    await fs.promises.writeFile(path, data.subarray(0, offset))

    const sentOffset = new Promise<number>(resolve => mockPeer.once('offset', resolve))

    const down = await client.download({ file: searchResult(), path, offset })

    assert.strictEqual(await sentOffset, offset, 'the peer must receive the file offset')
    assert.deepStrictEqual(down.buffer, data.subarray(offset), 'only the missing part is received')
    assert.strictEqual(down.receivedBytes, data.length)
    assert.deepStrictEqual(await fs.promises.readFile(path), data, 'the file must be completed')
  })

  it('downloads with the legacy transfer request', async () => {
    const path = baseFolder + '/legacy.mp3'
    const request = new Promise<{ file: string, token: string }>(resolve =>
      mockPeer.once('transfer-request', resolve))

    const down = await client.download({ file: searchResult(), path, request: 'transfer' })

    assert.strictEqual((await request).file, remoteFile)
    assert.deepStrictEqual(down.buffer, data)
    assert.deepStrictEqual(await fs.promises.readFile(path), data)
  }).timeout(10000)

  it('rejects when the user cannot be reached', async () => {
    await assert.rejects(client.connectToUser('ghost', 200), { message: 'User not exist' })
  })
})

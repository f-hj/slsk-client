import assert from 'assert'
import fs from 'fs'
import {
  DownloadCancelledError,
  SlskClient,
  type DownloadProgress,
  type QueuePlace,
  type SearchResult
} from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockUploadPeer from './mock-upload-peer'

describe('download', () => {
  const baseFolder = '/tmp/slsk-client/download'
  const serverAddress = { host: '127.0.0.1', port: 2244 }
  const peerAddress = { host: '127.0.0.1', port: 4251 }
  const incomingPort = 2299

  const uploader = 'uploader'
  /** A peer of the days before the upload queue: it starts the transfer as soon as it is asked */
  const oldUploader = 'old-uploader'
  const oldPeerAddress = { host: '127.0.0.1', port: 4253 }
  /** Another one of those, which refuses the transfer instead of starting it */
  const refusingUploader = 'refusing-uploader'
  const remoteFile = 'music\\great song.mp3'
  const data = Buffer.from('this is definitely a mp3 file')

  let client: SlskClient
  let mockServer: MockServer
  let mockPeer: MockUploadPeer
  let oldMockPeer: MockUploadPeer

  const searchResult = (): SearchResult => ({
    user: uploader,
    file: remoteFile,
    size: data.length,
    slots: true,
    speed: 0,
    attribs: {}
  })

  before(async () => {
    await fs.promises.mkdir(baseFolder, { recursive: true })

    const ports: Record<string, number> = {
      [uploader]: peerAddress.port,
      [oldUploader]: oldPeerAddress.port,
      [refusingUploader]: 4254
    }

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(
          evt.client,
          evt.user,
          peerAddress.host,
          // the slsk server answers port 0 for a user that is not connected
          ports[evt.user] ?? 0
        ))

    mockPeer = new MockUploadPeer({
      address: peerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: uploader
    })

    oldMockPeer = new MockUploadPeer({
      address: oldPeerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: oldUploader,
      answer: 'allow'
    })

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
    oldMockPeer.destroy()
    mockServer.destroy()
  })

  it('downloads through the upload queue of the peer, which is what current clients speak', async () => {
    const queued: QueuePlace[] = []
    const progress: DownloadProgress[] = []
    client.on('download-queue', place => queued.push(place))
    client.on('download-progress', it => progress.push(it))

    const queueUpload = new Promise<string>(resolve => mockPeer.once('queue-upload', resolve))
    const path = baseFolder + '/queued.mp3'

    const down = await client.download({ ...searchResult(), path })

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
    assert.strictEqual(last.sizeAnnounced, true, 'the peer announced the size')
    assert.strictEqual(last.progress, 1)
  })

  it('resumes a partial download from the given offset', async () => {
    const path = baseFolder + '/resumed.mp3'
    const offset = 10
    await fs.promises.writeFile(path, data.subarray(0, offset))

    const sentOffset = new Promise<number>(resolve => mockPeer.once('offset', resolve))

    const down = await client.download({ ...searchResult(), path, offset })

    assert.strictEqual(await sentOffset, offset, 'the peer must receive the file offset')
    assert.deepStrictEqual(down.buffer, data.subarray(offset), 'only the missing part is received')
    assert.strictEqual(down.receivedBytes, data.length)
    assert.deepStrictEqual(await fs.promises.readFile(path), data, 'the file must be completed')
  })

  it('falls back to the old request for a peer that ignores the queue', async () => {
    const path = baseFolder + '/legacy.mp3'
    // a peer that answers nothing about a queue must not be waited on for long
    const legacyClient = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort: 2302,
      queueFallbackDelay: 200
    })

    try {
      const asked = new Promise<string>(resolve => oldMockPeer.once('queue-upload', resolve))
      const request = new Promise<{ file: string, token: string }>(resolve =>
        oldMockPeer.once('transfer-request', resolve))

      const download = legacyClient.download({ ...searchResult(), user: oldUploader, path })

      assert.strictEqual(await asked, remoteFile, 'the queue is what a peer is asked first')
      assert.strictEqual((await request).file, remoteFile, 'then the old request')

      const down = await download
      assert.deepStrictEqual(down.buffer, data)
      assert.deepStrictEqual(await fs.promises.readFile(path), data)

      // a second download from that peer goes straight to the request it understands
      const second = new Promise<{ file: string, token: string }>(resolve =>
        oldMockPeer.once('transfer-request', resolve))
      const again = legacyClient.download({
        ...searchResult(),
        user: oldUploader,
        path: baseFolder + '/legacy-again.mp3'
      })
      assert.strictEqual((await second).file, remoteFile)
      await again
    } finally {
      legacyClient.destroy()
    }
  }).timeout(10000)

  it('follows a download through its states', async () => {
    const path = baseFolder + '/started.mp3'

    const download = client.download({ ...searchResult(), path })
    assert.strictEqual(download.status, 'requested')
    assert.deepStrictEqual(client.downloads, [download], 'the client lists it while it runs')

    const states: string[] = []
    download.on('status', status => states.push(status))

    const result = await download.promise
    assert.strictEqual(result.receivedBytes, data.length)
    assert.strictEqual(download.status, 'complete')
    assert.deepStrictEqual(states, ['queued', 'connected', 'downloading', 'complete'])
    assert.deepStrictEqual(client.downloads, [], 'and forgets it once it is over')
  })

  it('cancels a download the caller gives up on, without asking the peer for it', async () => {
    const queueUpload = new Promise<string>(resolve => mockPeer.once('queue-upload', resolve))
    const download = client.download({
      ...searchResult(),
      path: baseFolder + '/cancelled.mp3'
    })

    assert.strictEqual(download.cancel('trying another peer'), true)
    await assert.rejects(download.promise, DownloadCancelledError)
    assert.strictEqual(download.status, 'cancelled')
    assert.deepStrictEqual(client.downloads, [], 'a cancelled download is forgotten')

    const asked = await Promise.race<string | undefined>([
      queueUpload,
      new Promise(resolve => setTimeout(() => resolve(undefined), 100))
    ])
    assert.strictEqual(asked, undefined, 'the peer must not be asked for a cancelled file')
  })

  it('rejects the download when the peer denies the upload', async () => {
    const denyingPeer = new MockUploadPeer({
      address: { host: '127.0.0.1', port: 4252 },
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: 'denier',
      deny: 'Queue full'
    })
    const denyingServer = new MockServer({ host: '127.0.0.1', port: 2245 })
    denyingServer
      .on('login', (login: LoginEvent) => denyingServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        denyingServer.returnPeerAddress(evt.client, evt.user, '127.0.0.1', 4252))

    const denied = await connectClient({
      user: 'me',
      pass: 'secret',
      host: '127.0.0.1',
      port: 2245,
      incomingPort: 2300
    })

    try {
      await assert.rejects(
        denied.download({ ...searchResult(), user: 'denier', path: baseFolder + '/denied.mp3' }),
        { message: 'Queue full' }
      )
      assert.deepStrictEqual(denied.downloads, [], 'a failed download is forgotten')
    } finally {
      denied.destroy()
      denyingPeer.destroy()
      denyingServer.destroy()
    }
  })

  it('rejects the download when an old peer refuses the transfer', async () => {
    const refusingPeer = new MockUploadPeer({
      address: { host: '127.0.0.1', port: 4254 },
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: refusingUploader,
      answer: 'allow',
      deny: 'Banned'
    })
    const refusedClient = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort: 2303,
      queueFallbackDelay: 200
    })

    try {
      // the refusal used to be logged and forgotten, leaving the download pending forever
      await assert.rejects(
        refusedClient.download({
          ...searchResult(),
          user: refusingUploader,
          path: baseFolder + '/refused.mp3'
        }),
        { message: 'Banned' }
      )
      assert.deepStrictEqual(refusedClient.downloads, [])
    } finally {
      refusedClient.destroy()
      refusingPeer.destroy()
    }
  }).timeout(10000)

  it('rejects when the user cannot be reached', async () => {
    await assert.rejects(client.connectToUser('ghost', 200), { message: 'User not exist' })
  })
})

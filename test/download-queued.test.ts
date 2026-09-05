import assert from 'assert'
import fs from 'fs'
import { SlskClient } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockUploadPeer from './mock-upload-peer'

describe('download waiting in the queue of a peer', () => {
  const baseFolder = '/tmp/slsk-client/download-queued'
  const serverAddress = { host: '127.0.0.1', port: 2256 }
  const peerAddress = { host: '127.0.0.1', port: 4259 }
  const incomingPort = 2303

  const uploader = 'qiman88'
  /** A peer with a long queue: it holds the file and answers where it stands */
  const patient = 'patient'
  const patientAddress = { host: '127.0.0.1', port: 4260 }
  const patientPort = 2304
  const remoteFile = 'music\\great song.mp3'
  const data = Buffer.from('a file worth waiting for')

  let client: SlskClient
  let mockServer: MockServer
  let mockPeer: MockUploadPeer

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
          evt.user === patient ? patientAddress.port : peerAddress.port
        ))

    // a peer that takes the request, hangs up, and comes back when our turn arrives
    mockPeer = new MockUploadPeer({
      address: peerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: uploader,
      dropAfterQueue: true
    })

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort,
      // short enough for a test, and the point is that it does not settle the download
      queueFallbackDelay: 200
    })
  })

  after(() => {
    if (client) client.destroy()
    mockPeer.destroy()
    mockServer.destroy()
  })

  it('asks again where the file stands, as long as the peer answers', async () => {
    const answering = new MockUploadPeer({
      address: patientAddress,
      clientListenPort: patientPort,
      file: remoteFile,
      data,
      username: patient,
      // it keeps the file queued and never announces the transfer
      holdInQueue: true,
      answerPlaces: 3,
      place: 4
    })
    const polling = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort: patientPort,
      queuePollInterval: 100,
      queuePollRetries: 2
    })

    try {
      const places: number[] = []
      polling.on('download-queue', place => places.push(place.place))
      const asked: string[] = []
      answering.on('place-in-queue-request', file => asked.push(file))

      const download = polling.download({ user: patient, file: remoteFile, size: data.length })

      // the first request, then one per interval as long as the peer answers
      await new Promise<void>(resolve => setTimeout(resolve, 350))
      assert.ok(asked.length >= 3, `the place must be asked again, asked ${asked.length} times`)
      assert.ok(places.length >= 3, `every answer is reported, got ${places.length}`)
      assert.deepStrictEqual([...new Set(places)], [4], 'with the place the peer gave')

      // it stops answering: after the retries the download gives up on that peer
      await assert.rejects(download.promise, /left 2 requests about the place .* unanswered/)
    } finally {
      polling.destroy()
      answering.destroy()
    }
  }).timeout(10000)

  it('survives the peer connection dying while the file waits', async () => {
    const path = baseFolder + '/waited.mp3'
    const queued = new Promise<string>(resolve => mockPeer.once('queue-upload', resolve))

    const download = client.download({ user: uploader, file: remoteFile, size: data.length, path })

    assert.strictEqual(await queued, remoteFile, 'the peer received the request')

    // the connection is gone and the fallback delay has passed: a peer that says nothing on a
    // connection that died has not refused anything, our file is still in its queue
    await new Promise<void>(resolve => setTimeout(resolve, 400))
    assert.strictEqual(download.isSettled, false, 'the download must still be waiting')
    assert.strictEqual(download.status, 'requested')

    // our turn comes, the peer announces the transfer on a new connection
    mockPeer.comeBack()

    const result = await download
    assert.deepStrictEqual(result.buffer, data, 'the file arrives on the connection it opened')
    assert.deepStrictEqual(await fs.promises.readFile(path), data)
  }).timeout(10000)
})

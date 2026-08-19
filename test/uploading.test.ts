import assert from 'assert'
import { memoryShareProvider, UploadPermission, type SlskClient, type UserInfo } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockDownloadPeer from './mock-download-peer'

describe('uploading', () => {
  const serverAddress = { host: '127.0.0.1', port: 2252 }
  const peerAddress = { host: '127.0.0.1', port: 4256 }
  const incomingPort = 2295

  const downloader = 'jambon'
  const file = 'music\\great song.mp3'
  const other = 'music\\other song.mp3'
  const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')

  let mockServer: MockServer
  /** Address answered to GetPeerAddress, port 0 for a peer the client cannot reach */
  let peerPort = peerAddress.port

  before(() => {
    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => mockServer.loginSuccess(login.client))
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(evt.client, evt.user, peerAddress.host, peerPort))
  })

  after(() => {
    mockServer.destroy()
  })

  beforeEach(() => {
    peerPort = peerAddress.port
  })

  const clientFor = async (uploads: boolean | { slots?: number } = true): Promise<SlskClient> =>
    await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort,
      uploads,
      shares: memoryShareProvider([
        { path: file, data },
        { path: other, data }
      ])
    })

  const peerFor = async (
    options: Partial<ConstructorParameters<typeof MockDownloadPeer>[0]> = {}
  ): Promise<MockDownloadPeer> => {
    const peer = new MockDownloadPeer({
      address: peerAddress,
      clientListenPort: incomingPort,
      username: downloader,
      ...options
    })
    await peer.connect()
    return peer
  }

  it('sends a file a peer asked for', async () => {
    const client = await clientFor()
    const peer = await peerFor()

    try {
      await client.sharesReady

      const announced = new Promise<{ file: string, token: string, size: number }>(resolve =>
        peer.once('upload-request', resolve))
      const received = new Promise<{ data: Buffer }>(resolve => peer.once('file', resolve))
      const complete = new Promise<{ user: string, file: string, sentBytes: number }>(resolve =>
        client.once('upload-complete', resolve))

      peer.queueUpload(file)

      const request = await announced
      assert.strictEqual(request.file, file)
      assert.strictEqual(request.size, data.length, 'the size the peer is told must be the real one')

      assert.deepStrictEqual((await received).data, data, 'the whole file must be sent')
      assert.deepStrictEqual(await complete, {
        user: downloader,
        file,
        sentBytes: data.length
      })
      assert.deepStrictEqual(client.uploads, [], 'a finished upload is forgotten')
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('starts at the offset the peer asks for', async () => {
    const offset = 10
    const client = await clientFor()
    const peer = await peerFor({ offset })

    try {
      await client.sharesReady
      const received = new Promise<{ data: Buffer }>(resolve => peer.once('file', resolve))

      peer.queueUpload(file)

      assert.deepStrictEqual((await received).data, data.subarray(offset),
        'only the part the peer is missing must be sent')
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('denies a file that is not shared', async () => {
    const client = await clientFor()
    const peer = await peerFor()

    try {
      await client.sharesReady
      const denied = new Promise<{ file: string, reason: string }>(resolve =>
        peer.once('upload-denied', resolve))

      peer.queueUpload('music\\not mine.mp3')

      assert.deepStrictEqual(await denied, {
        file: 'music\\not mine.mp3',
        reason: 'File not shared.'
      })
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('denies every request when uploads are off, which is the default', async () => {
    const client = await clientFor(false)
    const peer = await peerFor()

    try {
      await client.sharesReady
      assert.strictEqual(client.servesUploads, false)

      const denied = new Promise<{ file: string, reason: string }>(resolve =>
        peer.once('upload-denied', resolve))

      peer.queueUpload(file)

      assert.deepStrictEqual(await denied, { file, reason: 'Uploads are disabled' })
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('tells a peer how many slots it really has', async () => {
    const client = await clientFor({ slots: 2 })
    const peer = await peerFor()

    try {
      const info = new Promise<UserInfo>(resolve => peer.once('user-info', resolve))
      peer.userInfoRequest()

      const answer = await info
      assert.strictEqual(answer.uploadSlots, 2)
      assert.strictEqual(answer.slotsFree, true, 'nothing is running yet')
      assert.strictEqual(answer.uploadPermitted, UploadPermission.Everyone)
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('tells a peer it has no slot at all when it does not serve its files', async () => {
    const client = await clientFor(false)
    const peer = await peerFor()

    try {
      const info = new Promise<UserInfo>(resolve => peer.once('user-info', resolve))
      peer.userInfoRequest()

      const answer = await info
      assert.strictEqual(answer.uploadSlots, 0)
      assert.strictEqual(answer.slotsFree, false, 'a peer must not pick us for a download')
      assert.strictEqual(answer.uploadPermitted, UploadPermission.NoOne)
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('tells a peer where its file stands in the queue', async () => {
    // one slot, and a peer that never answers the first transfer: it stays busy
    const client = await clientFor({ slots: 1 })
    const peer = await peerFor({ answer: 'ignore' })

    try {
      await client.sharesReady

      const announced = new Promise<void>(resolve => peer.once('upload-request', () => resolve()))
      peer.queueUpload(file)
      await announced

      const queued = new Promise<void>(resolve => client.once('upload-queued', () => resolve()))
      const place = new Promise<{ file: string, place: number }>(resolve =>
        peer.once('place-in-queue', resolve))

      peer.queueUpload(other)
      await queued
      peer.placeInQueueRequest(other)

      assert.deepStrictEqual(await place, { file: other, place: 1 },
        'the file waiting for the busy slot is first in the queue')
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('queues a request made the old way instead of allowing it right away', async () => {
    const client = await clientFor()
    const peer = await peerFor()

    try {
      await client.sharesReady

      const announced = new Promise<{ file: string, token: string }>(resolve =>
        peer.once('upload-request', resolve))
      const received = new Promise<{ data: Buffer }>(resolve => peer.once('file', resolve))

      // a peer from before QueueUpload existed picks the token itself
      peer.legacyRequest(file, 'deadbeef')

      const request = await announced
      assert.strictEqual(request.file, file)
      assert.notStrictEqual(request.token, 'deadbeef',
        'the transfer must be announced with our own token, not the one the peer picked')
      assert.deepStrictEqual((await received).data, data)
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('asks the server to relay only after failing to reach the peer itself', async () => {
    // an address that answers nothing: the direct attempt must fail before the relay is used
    peerPort = 4999
    const client = await clientFor()
    const peer = await peerFor()

    try {
      await client.sharesReady

      const relayed = new Promise<{ token: string, type: string }>(resolve =>
        mockServer.once('connect-to-peer', resolve))
      const received = new Promise<{ data: Buffer }>(resolve => peer.once('file', resolve))

      peer.queueUpload(file)

      const request = await relayed
      assert.strictEqual(request.type, 'F')
      peer.pierce(request.token)

      assert.deepStrictEqual((await received).data, data,
        'the file must go out on the relayed connection')
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)

  it('sends the file on the connection a firewalled peer opens to us', async () => {
    // the server answers port 0, so the client cannot reach the peer and asks it to connect
    peerPort = 0
    const client = await clientFor()
    const peer = await peerFor()

    try {
      await client.sharesReady

      const relayed = new Promise<{ token: string, type: string }>(resolve =>
        mockServer.once('connect-to-peer', resolve))
      const received = new Promise<{ data: Buffer }>(resolve => peer.once('file', resolve))

      peer.queueUpload(file)

      const request = await relayed
      assert.strictEqual(request.type, 'F', 'the relayed connection must be a file connection')
      peer.pierce(request.token)

      assert.deepStrictEqual((await received).data, data)
    } finally {
      client.destroy()
      peer.destroy()
    }
  }).timeout(10000)
})

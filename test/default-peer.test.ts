import assert from 'assert'
import net from 'net'
import zlib from 'zlib'
import DefaultPeer, { type TransferRequestEvent, type TransferResponseEvent } from '../src/peer/default-peer/default-peer'
import Message from '../src/utils/message'
import Messages from '../src/utils/messages'
import Shared from '../src/share/shared'
import Session from '../src/session'
import { UploadPermission, type UserInfo } from '../src/types'
import type { FileSearchResult } from '../src/peer/default-peer/messages'
import type { ShareEntry } from '../src/share/provider'

interface Pair {
  /** Socket given to the DefaultPeer under test */
  local: net.Socket
  /** Socket playing the remote peer */
  remote: net.Socket
  next: () => Promise<Message>
  close: () => void
}

/** Two connected sockets over the loopback interface, with a message reader on the remote side */
async function connectedPair (): Promise<Pair> {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port

  const accepted = new Promise<net.Socket>(resolve => server.once('connection', resolve))
  const local = net.createConnection({ host: '127.0.0.1', port })
  await new Promise<void>(resolve => local.once('connect', resolve))
  const remote = await accepted

  const msgs = new Messages()
  const received: Message[] = []
  const waiting: Array<(msg: Message) => void> = []
  msgs.on('message', msg => {
    const waiter = waiting.shift()
    if (waiter) waiter(msg)
    else received.push(msg)
  })
  remote.on('data', data => msgs.write(data))

  return {
    local,
    remote,
    next: async () => await new Promise<Message>(resolve => {
      const msg = received.shift()
      if (msg) resolve(msg)
      else waiting.push(resolve)
    }),
    close: () => {
      local.destroy()
      remote.destroy()
      server.close()
    }
  }
}

describe('class DefaultPeer', () => {
  const user = 'alice'
  const file = 'music\\great song.mp3'
  let pair: Pair
  let peer: DefaultPeer

  const shared = new Shared()
  const session = new Session()
  const sharedFile: ShareEntry = {
    path: 'music\\great song.mp3',
    size: 4,
    id: '/tmp/music/great song.mp3'
  }

  beforeEach(async () => {
    session.username = 'me'
    shared.files = [sharedFile]
    pair = await connectedPair()
    peer = new DefaultPeer(pair.local, { user }, { session, shared })
  })

  afterEach(() => {
    peer.destroy()
    pair.close()
  })

  it('reports an upload the peer refuses', async () => {
    const denied = new Promise<{ file: string, reason: string }>(resolve => {
      peer.once('upload-denied', resolve)
    })

    pair.remote.write(new Message()
      .int32(50) // UploadDenied
      .str(file)
      .str('Queue full')
      .getBuff())

    assert.deepStrictEqual(await denied, { file, reason: 'Queue full' })
  })

  it('reports an upload the peer gave up on', async () => {
    const failed = new Promise<string>(resolve => peer.once('upload-failed', resolve))

    pair.remote.write(new Message()
      .int32(46) // UploadFailed
      .str(file)
      .getBuff())

    assert.strictEqual(await failed, file)
  })

  it('reports the place in the upload queue', async () => {
    const place = new Promise<{ file: string, place: number }>(resolve => {
      peer.once('place-in-queue', resolve)
    })

    pair.remote.write(new Message()
      .int32(44) // PlaceInQueueResponse
      .str(file)
      .int32(7)
      .getBuff())

    assert.deepStrictEqual(await place, { file, place: 7 })
  })

  it('reports an announced upload and keeps its 64 bit size', async () => {
    const size = 6 * 1024 * 1024 * 1024 // 6 GiB, does not fit in a uint32
    const request = new Promise<TransferRequestEvent>(resolve => {
      peer.once('transfer-request', resolve)
    })

    pair.remote.write(new Message()
      .int32(40) // TransferRequest
      .int32(1) // direction: the peer uploads
      .rawHexStr('cafed00d')
      .str(file)
      .int64(size)
      .getBuff())

    assert.deepStrictEqual(await request, {
      direction: 1,
      token: 'cafed00d',
      file,
      size
    } satisfies TransferRequestEvent)
  })

  it('reports a download request without size, the client answers it', async () => {
    const request = new Promise<TransferRequestEvent>(resolve => {
      peer.once('transfer-request', resolve)
    })

    pair.remote.write(new Message()
      .int32(40) // TransferRequest
      .int32(0) // direction: the peer wants to download from us
      .rawHexStr('cafed00d')
      .str(file)
      .getBuff())

    assert.deepStrictEqual(await request, {
      direction: 0,
      token: 'cafed00d',
      file,
      size: undefined
    } satisfies TransferRequestEvent)
  })

  it('reports the answer of the peer to a transfer, with its reason when refused', async () => {
    const allowed = new Promise<TransferResponseEvent>(resolve => {
      peer.once('transfer-response', resolve)
    })
    pair.remote.write(new Message()
      .int32(41)
      .rawHexStr('cafed00d')
      .int8(1)
      .getBuff())
    assert.deepStrictEqual(await allowed, { token: 'cafed00d', allowed: true, reason: undefined })

    const refused = new Promise<TransferResponseEvent>(resolve => {
      peer.once('transfer-response', resolve)
    })
    pair.remote.write(new Message()
      .int32(41)
      .rawHexStr('0a0b0c0d')
      .int8(0)
      .str('Queued')
      .getBuff())
    assert.deepStrictEqual(await refused, { token: '0a0b0c0d', allowed: false, reason: 'Queued' })
  })

  it('sends the transfer response the client asks for', async () => {
    peer.transferResponse('cafed00d', false, 'Cancelled')

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 41) // TransferResponse
    assert.strictEqual(answer.rawHexStr(4), 'cafed00d')
    assert.strictEqual(answer.int8(), 0) // denied
    assert.strictEqual(answer.str(), 'Cancelled')
  })

  it('denies a queue upload request', async () => {
    pair.remote.write(new Message()
      .int32(43) // QueueUpload
      .str(file)
      .getBuff())

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 50) // UploadDenied
    assert.strictEqual(answer.str(), file)
    assert.strictEqual(answer.str(), 'Cancelled')
  })

  it('answers a shared file list request with the real shares', async () => {
    pair.remote.write(new Message()
      .int32(4) // GetSharedFileList
      .int32(0) // some peers send a trailing field
      .getBuff())

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 5) // SharedFileListResponse

    const payload = new Message(zlib.inflateSync(answer.data.subarray(8)))
    assert.strictEqual(payload.int32(), 1) // one folder
    assert.strictEqual(payload.str(), 'music')
    assert.strictEqual(payload.int32(), 1) // one file
    assert.strictEqual(payload.int8(), 1) // file code
    assert.strictEqual(payload.str(), 'music\\great song.mp3')
    assert.strictEqual(payload.int64(), 4)
  })

  it('answers a folder contents request with the files of the folder', async () => {
    pair.remote.write(new Message()
      .int32(36) // FolderContentsRequest
      .rawHexStr('0a0b0c0d')
      .str('music')
      .getBuff())

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 37) // FolderContentsResponse

    const payload = new Message(zlib.inflateSync(answer.data.subarray(8)))
    assert.strictEqual(payload.rawHexStr(4), '0a0b0c0d')
    assert.strictEqual(payload.int32(), 1) // one requested folder
    assert.strictEqual(payload.str(), 'music')
    assert.strictEqual(payload.int32(), 1) // one folder in it
    assert.strictEqual(payload.str(), 'music')
    assert.strictEqual(payload.int32(), 1) // one file
    payload.int8()
    assert.strictEqual(payload.str(), 'music\\great song.mp3')
  })

  it('reports a search result with its attributes', async () => {
    const received = new Promise<FileSearchResult>(resolve => peer.once('search-result', resolve))

    const payload = new Message()
      .str(user)
      .rawHexStr('0a0b0c0d')
      .int32(1) // one file
      .int8(1) // file code
      .str(file)
      .int64(4)
      .str('mp3')
      .int32(1) // one attribute
      .int32(0).int32(320) // bitrate
      .int8(1) // free slot
      .int32(4242) // speed
      .int32(3) // queue length

    pair.remote.write(new Message()
      .int32(9) // FileSearchResponse
      .writeBuffer(zlib.deflateSync(payload.data))
      .getBuff())

    const result = await received
    assert.strictEqual(result.currentToken, '0a0b0c0d')
    assert.strictEqual(result.slots, 1)
    assert.strictEqual(result.speed, 4242)
    assert.strictEqual(result.queueLength, 3)
    assert.deepStrictEqual(result.files, [{ user, file, size: 4, attribs: { 0: 320 } }])
  })

  it('answers a user info request, which carries nothing but its code', async () => {
    pair.remote.write(new Message()
      .int32(15) // UserInfoRequest
      .getBuff())

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 16) // UserInfoResponse
    assert.strictEqual(answer.str(), '', 'no description by default')
    assert.strictEqual(answer.int8(), 0) // no picture
    assert.strictEqual(answer.int32(), 1) // upload slots
    assert.strictEqual(answer.int32(), 0) // queue size
    assert.strictEqual(answer.int8(), 1) // a slot is free
    assert.strictEqual(answer.int32(), UploadPermission.Everyone)
    assert.strictEqual(answer.remaining(), 0)
  })

  it('answers a user info request with what it was configured with', async () => {
    const picture = Buffer.from('a picture')
    // its own pair: the peer of the fixture would answer on the shared socket too
    const own = await connectedPair()
    const configured = new DefaultPeer(own.local, { user }, {
      session,
      shared,
      userInfo: {
        description: 'me and my music',
        picture,
        uploadSlots: 2,
        queueSize: 7,
        slotsFree: true,
        uploadPermitted: UploadPermission.Everyone
      }
    })

    try {
      own.remote.write(new Message().int32(15).getBuff())

      const answer = await own.next()
      answer.int32() // size
      assert.strictEqual(answer.int32(), 16)
      assert.strictEqual(answer.str(), 'me and my music')
      assert.strictEqual(answer.int8(), 1) // has a picture
      assert.strictEqual(answer.int32(), picture.length)
      assert.deepStrictEqual(answer.readBuffer(picture.length), picture)
      assert.strictEqual(answer.int32(), 2) // upload slots
      assert.strictEqual(answer.int32(), 7) // queue size
      assert.strictEqual(answer.int8(), 1) // a slot is free
      assert.strictEqual(answer.int32(), UploadPermission.Everyone)
    } finally {
      configured.destroy()
      own.close()
    }
  })

  it('reports what a peer tells about itself', async () => {
    const received = new Promise<UserInfo>(resolve => peer.once('user-info', resolve))
    const picture = Buffer.from('cover.jpg contents')

    const msg = new Message()
      .int32(16) // UserInfoResponse
      .str('hello from alice')
      .int8(1) // has a picture
      .int32(picture.length)
    msg.writeBuffer(picture)
    pair.remote.write(msg
      .int32(3) // upload slots
      .int32(12) // queue size
      .int8(1) // a slot is free
      .int32(UploadPermission.UserList)
      .getBuff())

    assert.deepStrictEqual(await received, {
      user,
      description: 'hello from alice',
      picture,
      uploadSlots: 3,
      queueSize: 12,
      slotsFree: true,
      uploadPermitted: UploadPermission.UserList
    } satisfies UserInfo)
  })

  it('reports the info of a peer that stops after the description', async () => {
    const received = new Promise<UserInfo>(resolve => peer.once('user-info', resolve))

    pair.remote.write(new Message()
      .int32(16)
      .str('short and sweet')
      .int8(0) // no picture
      .getBuff())

    assert.deepStrictEqual(await received, {
      user,
      description: 'short and sweet',
      picture: undefined,
      uploadSlots: 0,
      queueSize: 0,
      slotsFree: false,
      uploadPermitted: undefined
    } satisfies UserInfo)
  })

  it('sends a user info request', async () => {
    peer.userInfoRequest()

    const sent = await pair.next()
    assert.strictEqual(sent.int32(), 4, 'the code is the whole payload')
    assert.strictEqual(sent.int32(), 15)
  })
})

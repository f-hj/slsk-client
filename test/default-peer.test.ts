import assert from 'assert'
import net from 'net'
import zlib from 'zlib'
import DefaultPeer from '../src/peer/default-peer'
import Message from '../src/message'
import Messages from '../src/messages'
import Shared from '../src/share/shared'
import stack, { downloadKey } from '../src/stack'
import { FileAttribute, type SearchResult } from '../src/types'
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
  const sharedFile: ShareEntry = {
    path: 'music\\great song.mp3',
    size: 4,
    id: '/tmp/music/great song.mp3'
  }

  beforeEach(async () => {
    shared.files = [sharedFile]
    pair = await connectedPair()
    peer = new DefaultPeer(pair.local, { user }, { shared })
  })

  afterEach(() => {
    peer.destroy()
    pair.close()
    delete stack.download[downloadKey(user, file)]
    stack.downloadTokens = {}
  })

  it('rejects the pending download when the peer denies the upload', async () => {
    const pending = new Promise<void>((resolve, reject) => {
      stack.download[downloadKey(user, file)] = { resolve: () => resolve(), reject }
    })

    pair.remote.write(new Message()
      .int32(50) // UploadDenied
      .str(file)
      .str('Queue full')
      .getBuff())

    await assert.rejects(pending, { message: 'Queue full' })
    assert.strictEqual(stack.download[downloadKey(user, file)], undefined, 'the download must be forgotten')
  })

  it('rejects the pending download when the upload fails', async () => {
    const pending = new Promise<void>((resolve, reject) => {
      stack.download[downloadKey(user, file)] = { resolve: () => resolve(), reject }
    })

    pair.remote.write(new Message()
      .int32(46) // UploadFailed
      .str(file)
      .getBuff())

    await assert.rejects(pending, { message: 'Peer error' })
  })

  it('reports the place in the upload queue', async () => {
    const place = new Promise<number>(resolve => {
      stack.download[downloadKey(user, file)] = { onQueue: resolve }
    })

    pair.remote.write(new Message()
      .int32(44) // PlaceInQueueResponse
      .str(file)
      .int32(7)
      .getBuff())

    assert.strictEqual(await place, 7)
  })

  it('accepts an announced upload and keeps its 64 bit size', async () => {
    const size = 6 * 1024 * 1024 * 1024 // 6 GiB, does not fit in a uint32

    pair.remote.write(new Message()
      .int32(40) // TransferRequest
      .int32(1) // direction: the peer uploads
      .rawHexStr('cafed00d')
      .str(file)
      .int64(size)
      .getBuff())

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 41) // TransferResponse
    assert.strictEqual(answer.rawHexStr(4), 'cafed00d')
    assert.strictEqual(answer.int8(), 1) // allowed

    assert.deepStrictEqual(stack.downloadTokens.cafed00d, { user, file, size })
  })

  it('denies a download request, uploading is not supported', async () => {
    pair.remote.write(new Message()
      .int32(40) // TransferRequest
      .int32(0) // direction: the peer wants to download from us
      .rawHexStr('cafed00d')
      .str(file)
      .getBuff())

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

  it('surfaces the file attributes of a search result', async () => {
    const token = '0a0b0c0d'
    const result = new Promise<SearchResult>(resolve => {
      stack.search[token] = { cb: resolve, query: 'great song' }
    })

    const payload = new Message()
      .str(user)
      .rawHexStr(token)
      .int32(1) // one file
      .int8(1) // file code
      .str(file)
      .int64(4)
      .str('mp3')
      .int32(3) // three attributes
      .int32(FileAttribute.Bitrate).int32(320)
      .int32(FileAttribute.Duration).int32(214)
      .int32(FileAttribute.VBR).int32(1)
      .int8(1) // free slot
      .int32(4242) // speed
      .int32(3) // queue length

    pair.remote.write(new Message()
      .int32(9) // FileSearchResponse
      .writeBuffer(zlib.deflateSync(payload.data))
      .getBuff())

    assert.deepStrictEqual(await result, {
      user,
      file,
      size: 4,
      slots: true,
      bitrate: 320,
      duration: 214,
      vbr: true,
      sampleRate: undefined,
      bitDepth: undefined,
      attribs: {
        [FileAttribute.Bitrate]: 320,
        [FileAttribute.Duration]: 214,
        [FileAttribute.VBR]: 1
      },
      speed: 4242,
      queueLength: 3
    } satisfies SearchResult)

    delete stack.search[token]
  })

  it('answers a user info request', async () => {
    pair.remote.write(new Message()
      .int32(15) // UserInfoRequest
      .int32(0)
      .getBuff())

    const answer = await pair.next()
    answer.int32() // size
    assert.strictEqual(answer.int32(), 16) // UserInfoResponse
    assert.strictEqual(answer.str(), 'slsk-client')
    assert.strictEqual(answer.int8(), 0) // no picture
    assert.strictEqual(answer.int32(), 0) // upload slots
    assert.strictEqual(answer.int32(), 0) // queue size
    assert.strictEqual(answer.int8(), 0) // no free slot
  })
})

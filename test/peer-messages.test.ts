import assert from 'assert'
import zlib from 'zlib'
import Message from '../src/utils/message'
import peerMessages from '../src/peer/messages'
import messages, { parseFileSearchResult } from '../src/peer/default-peer/messages'
import type { ShareEntry } from '../src/share/provider'

describe('peer messages', () => {
  it('builds a transferRequest message readable back', () => {
    const buff = messages.transferRequest('@@abc\\song.mp3', 'deadbeef').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 40) // code
    assert.strictEqual(msg.int32(), 0) // direction
    assert.strictEqual(msg.rawHexStr(4), 'deadbeef')
    assert.strictEqual(msg.str(), '@@abc\\song.mp3')
  })

  it('builds a pierceFw message', () => {
    const buff = peerMessages.pierceFw('deadbeef').getBuff()
    assert.strictEqual(buff.toString('hex'), '0500000000deadbeef')
  })

  it('builds a queueUpload message', () => {
    const buff = messages.queueUpload('@@abc\\song.mp3').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 43) // code
    assert.strictEqual(msg.str(), '@@abc\\song.mp3')
  })

  it('builds a placeInQueueRequest message', () => {
    const buff = messages.placeInQueueRequest('@@abc\\song.mp3').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 51) // code
    assert.strictEqual(msg.str(), '@@abc\\song.mp3')
  })

  it('builds an allowed transferResponse', () => {
    const buff = messages.transferResponse('deadbeef').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 41) // code
    assert.strictEqual(msg.rawHexStr(4), 'deadbeef')
    assert.strictEqual(msg.int8(), 1)
    assert.strictEqual(msg.remaining(), 0)
  })

  it('builds a denied transferResponse with its reason', () => {
    const buff = messages.transferResponse('deadbeef', false, 'Cancelled').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 41) // code
    assert.strictEqual(msg.rawHexStr(4), 'deadbeef')
    assert.strictEqual(msg.int8(), 0)
    assert.strictEqual(msg.str(), 'Cancelled')
  })

  it('builds an uploadDenied message', () => {
    const buff = messages.uploadDenied('@@abc\\song.mp3', 'Cancelled').getBuff()
    const msg = new Message(buff)

    msg.int32() // size
    assert.strictEqual(msg.int32(), 50) // code
    assert.strictEqual(msg.str(), '@@abc\\song.mp3')
    assert.strictEqual(msg.str(), 'Cancelled')
  })

  it('builds a compressed sharedFileList grouped by folder', () => {
    const files: ShareEntry[] = [
      { path: 'music\\great song.mp3', size: 1234 },
      { path: 'music\\other song.mp3', size: 5678 },
      { path: 'music\\live\\encore.flac', size: 9 }
    ]

    const buff = messages.sharedFileList(files).getBuff()
    const msg = new Message(buff)
    msg.int32() // size
    assert.strictEqual(msg.int32(), 5) // code

    const payload = new Message(zlib.inflateSync(buff.subarray(8)))
    assert.strictEqual(payload.int32(), 2) // two folders

    assert.strictEqual(payload.str(), 'music')
    assert.strictEqual(payload.int32(), 2) // two files
    assert.strictEqual(payload.int8(), 1) // file code, 1 as documented
    assert.strictEqual(payload.str(), 'music\\great song.mp3')
    assert.strictEqual(payload.int64(), 1234)
    assert.strictEqual(payload.str(), 'mp3')
    assert.strictEqual(payload.int32(), 0) // no attribute
    payload.int8()
    assert.strictEqual(payload.str(), 'music\\other song.mp3')
    assert.strictEqual(payload.int64(), 5678)
    assert.strictEqual(payload.str(), 'mp3')
    assert.strictEqual(payload.int32(), 0)

    assert.strictEqual(payload.str(), 'music\\live')
    assert.strictEqual(payload.int32(), 1)
    payload.int8()
    assert.strictEqual(payload.str(), 'music\\live\\encore.flac')
    assert.strictEqual(payload.int64(), 9)
    assert.strictEqual(payload.str(), 'flac')
    assert.strictEqual(payload.int32(), 0)

    assert.strictEqual(payload.int32(), 0) // unknown
    assert.strictEqual(payload.int32(), 0) // private folders
  })

  it('builds a compressed folderContentsResponse for the requested folder', () => {
    const files: ShareEntry[] = [
      { path: 'music\\great song.mp3', size: 1234 }
    ]

    const buff = messages.folderContentsResponse('0a0b0c0d', 'music', files).getBuff()
    const msg = new Message(buff)
    msg.int32() // size
    assert.strictEqual(msg.int32(), 37) // code

    const payload = new Message(zlib.inflateSync(buff.subarray(8)))
    assert.strictEqual(payload.rawHexStr(4), '0a0b0c0d')
    assert.strictEqual(payload.int32(), 1) // one requested folder
    assert.strictEqual(payload.str(), 'music')
    assert.strictEqual(payload.int32(), 1) // one folder in it
    assert.strictEqual(payload.str(), 'music')
    assert.strictEqual(payload.int32(), 1) // one file
    assert.strictEqual(payload.int8(), 1)
    assert.strictEqual(payload.str(), 'music\\great song.mp3')
    assert.strictEqual(payload.int64(), 1234)
  })

  it('parses back what it builds', () => {
    const files: ShareEntry[] = [
      { path: 'music\\great song.mp3', size: 1234 },
      { path: 'music\\other song.mp3', size: 5678 }
    ]
    const token = '0a0b0c0d'

    const buff = messages.fileSearchResult(files, token, 'alice').getBuff()

    // strip the size (4 bytes) and code (4 bytes) prefix, then inflate the payload
    const decompressed = zlib.inflateSync(buff.subarray(8))
    const parsed = parseFileSearchResult(decompressed)

    assert.strictEqual(parsed.currentToken, token)
    assert.strictEqual(parsed.slots, 1)
    assert.strictEqual(parsed.speed, 0)
    assert.strictEqual(parsed.queueLength, 0)
    assert.strictEqual(parsed.files.length, 2)
    assert.deepStrictEqual(parsed.files[0], {
      user: 'alice',
      file: 'music\\great song.mp3',
      size: 1234,
      attribs: {}
    })
    assert.deepStrictEqual(parsed.files[1], {
      user: 'alice',
      file: 'music\\other song.mp3',
      size: 5678,
      attribs: {}
    })
  })

  it('keeps the advertised slots, speed and queue length', () => {
    const files: ShareEntry[] = [
      { path: 'music\\great song.mp3', size: 1234 }
    ]

    const buff = messages.fileSearchResult(files, '0a0b0c0d', 'alice', {
      slotsFree: false,
      avgSpeed: 4242,
      queueLength: 7
    }).getBuff()
    const parsed = parseFileSearchResult(zlib.inflateSync(buff.subarray(8)))

    assert.strictEqual(parsed.slots, 0)
    assert.strictEqual(parsed.speed, 4242)
    assert.strictEqual(parsed.queueLength, 7)
  })

  it('roundtrips a file bigger than 4 GiB', () => {
    const size = 6 * 1024 * 1024 * 1024 // 6 GiB, does not fit in a uint32
    const files: ShareEntry[] = [
      { path: 'music\\dj set.flac', size }
    ]

    const buff = messages.fileSearchResult(files, '0a0b0c0d', 'alice').getBuff()
    const parsed = parseFileSearchResult(zlib.inflateSync(buff.subarray(8)))

    assert.strictEqual(parsed.files[0].size, size)
  })

  it('parses a result of a peer that stops after the file list', () => {
    const files: ShareEntry[] = [
      { path: 'music\\great song.mp3', size: 1234 }
    ]

    const buff = messages.fileSearchResult(files, '0a0b0c0d', 'alice').getBuff()
    const payload = zlib.inflateSync(buff.subarray(8))
    // drop the slots, speed, queue length, unknown and private results fields
    const parsed = parseFileSearchResult(payload.subarray(0, payload.length - 17))

    assert.strictEqual(parsed.files.length, 1)
    assert.strictEqual(parsed.slots, 0)
    assert.strictEqual(parsed.speed, 0)
    assert.strictEqual(parsed.queueLength, 0)
  })
})

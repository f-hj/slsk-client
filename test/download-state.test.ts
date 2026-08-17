import assert from 'assert'
import fs from 'fs'
import Download, { type DownloadStatus } from '../src/download/download'
import Downloads from '../src/download/downloads'
import { DownloadCancelledError, DownloadTimeoutError } from '../src/download/errors'
import { toSearchResult } from '../src/index'
import { FileAttribute, type DownloadProgress, type SearchResult } from '../src/types'

const sleep = async (ms: number): Promise<void> =>
  await new Promise<void>(resolve => setTimeout(resolve, ms))

describe('class Download', () => {
  const baseFolder = '/tmp/slsk-client/download-state'

  before(async () => {
    await fs.promises.mkdir(baseFolder, { recursive: true })
  })

  it('goes through the states of a transfer', async () => {
    const path = baseFolder + '/states.mp3'
    const download = new Download({ user: 'alice', file: 'music\\song.mp3', path })
    const states: DownloadStatus[] = []
    download.on('status', status => states.push(status))

    assert.strictEqual(download.status, 'requested')
    download.queued(3)
    download.announced(8)
    assert.strictEqual(download.size, 8)
    assert.strictEqual(download.push(Buffer.from('1234')), false, 'not complete yet')
    assert.strictEqual(download.push(Buffer.from('5678')), true, 'everything received')
    await download.end()

    assert.deepStrictEqual(states, ['queued', 'connected', 'downloading', 'complete'])
    const result = await download.promise
    assert.strictEqual(result.receivedBytes, 8)
    assert.strictEqual(result.size, 8)
    assert.deepStrictEqual(result.buffer.toString(), '12345678')
    assert.deepStrictEqual(await fs.promises.readFile(path, 'utf8'), '12345678')
  })

  it('reports the progress of the transfer', async () => {
    const download = new Download({
      user: 'alice',
      file: 'music\\song.mp3',
      path: baseFolder + '/progress.mp3'
    })
    download.announced(4)

    const progress: number[] = []
    download.on('progress', it => progress.push(it.progress ?? 0))
    download.push(Buffer.from('12'))
    download.push(Buffer.from('34'))

    assert.deepStrictEqual(progress, [0.5, 1])
  })

  it('appends to the file and counts the offset in when resuming', async () => {
    const path = baseFolder + '/resume.mp3'
    await fs.promises.writeFile(path, '12')

    const download = new Download({ user: 'alice', file: 'music\\song.mp3', path, offset: 2 })
    download.announced(4)
    assert.strictEqual(download.push(Buffer.from('34')), true)
    await download.end()

    const result = await download.promise
    assert.strictEqual(result.receivedBytes, 4)
    assert.strictEqual(result.buffer.toString(), '34', 'only what was received')
    assert.strictEqual(await fs.promises.readFile(path, 'utf8'), '1234')
  })

  it('pushes the data to a stream taken before the transfer', async () => {
    const download = new Download({
      user: 'alice',
      file: 'music\\song.mp3',
      path: baseFolder + '/stream.mp3'
    })
    download.announced(4)

    const chunks: Buffer[] = []
    download.stream.on('data', (chunk: Buffer) => chunks.push(chunk))

    download.push(Buffer.from('12'))
    download.push(Buffer.from('34'))
    await download.end()

    assert.strictEqual(Buffer.concat(chunks).toString(), '1234')
  })

  it('rejects the promise and destroys the stream when it fails', async () => {
    const download = new Download({ user: 'alice', file: 'music\\song.mp3' })
    const stream = download.stream
    const streamError = new Promise<Error>(resolve => stream.on('error', resolve))

    assert.strictEqual(download.fail(new Error('Queue full')), true)

    await assert.rejects(download.promise, { message: 'Queue full' })
    assert.strictEqual((await streamError).message, 'Queue full')
    assert.strictEqual(download.status, 'failed')
  })

  it('cannot be settled twice', async () => {
    const download = new Download({
      user: 'alice',
      file: 'music\\song.mp3',
      path: baseFolder + '/once.mp3'
    })

    assert.strictEqual(download.fail(new Error('first')), true)
    assert.strictEqual(download.fail(new Error('second')), false)
    await download.end() // must not resolve a failed download

    await assert.rejects(download.promise, { message: 'first' })
  })

  it('does not crash the process when nobody listens to a failure', async () => {
    const download = new Download({ user: 'alice', file: 'music\\song.mp3' })
    download.fail(new Error('nobody cares'))

    await assert.rejects(download.promise, { message: 'nobody cares' })
  })

  it('does not take a search result saying 0 for an empty file', () => {
    const hinted = new Download({ user: 'alice', file: 'music\\song.mp3', expectedSize: 0 })

    assert.strictEqual(hinted.totalBytes, undefined, '0 from a search result says nothing')
    assert.strictEqual(hinted.isSizeKnown, false)
    assert.strictEqual(hinted.isComplete, false, 'nothing says the transfer is over')
    assert.strictEqual(hinted.push(Buffer.from('12')), false)
  })

  it('takes an empty file the peer announces for what it is', () => {
    const download = new Download({ user: 'alice', file: 'music\\empty.mp3' })
    download.announced(0)

    assert.strictEqual(download.isSizeKnown, true)
    assert.strictEqual(download.totalBytes, 0)
    assert.strictEqual(download.isComplete, true)
  })

  it('completes on the search-result size when the peer announces none', () => {
    // the legacy flow has no message carrying the size, the hint is all there is
    const download = new Download({ user: 'alice', file: 'music\\song.mp3', expectedSize: 4 })

    assert.strictEqual(download.isSizeKnown, false, 'the peer has not announced anything')
    assert.strictEqual(download.push(Buffer.from('12')), false)
    assert.strictEqual(download.push(Buffer.from('34')), true)
  })

  it('tells the size a peer announced from the size a search result guessed', () => {
    const download = new Download({ user: 'alice', file: 'music\\song.mp3', expectedSize: 4 })
    const progress: DownloadProgress[] = []
    download.on('progress', it => progress.push(it))

    download.push(Buffer.from('12'))
    download.announced(8)
    download.push(Buffer.from('34'))

    assert.deepStrictEqual(
      progress.map(it => [it.sizeAnnounced, it.totalBytes, it.progress]),
      [[false, 4, 0.5], [true, 8, 0.5]]
    )
  })

  it('never reports more than a whole file when the hint was too small', () => {
    const download = new Download({ user: 'alice', file: 'music\\song.mp3', expectedSize: 2 })
    const progress: number[] = []
    download.on('progress', it => progress.push(it.progress ?? 0))

    download.push(Buffer.from('1234'))

    assert.deepStrictEqual(progress, [1])
  })

  it('is cancelled by the caller, which stops what is still coming in', async () => {
    const download = new Download({ user: 'alice', file: 'music\\song.mp3' })

    assert.strictEqual(download.cancel('trying another peer'), true)
    assert.strictEqual(download.status, 'cancelled')
    assert.strictEqual(download.isCancelled, true)
    assert.strictEqual(download.cancel(), false, 'cancelling twice changes nothing')

    await assert.rejects(download.promise, (err: Error) => {
      assert.ok(err instanceof DownloadCancelledError)
      assert.strictEqual(err.message, 'trying another peer')
      return true
    })
    assert.strictEqual(download.push(Buffer.from('12')), true, 'the connection can be closed')
    assert.strictEqual(download.receivedBytes, 0, 'and the bytes are dropped')
  })

  it('is cancelled when its signal is aborted', async () => {
    const controller = new AbortController()
    const download = new Download({
      user: 'alice',
      file: 'music\\song.mp3',
      signal: controller.signal
    })

    download.announced(4)
    controller.abort(new Error('the app is shutting down'))

    await assert.rejects(download.promise, { message: 'the app is shutting down' })
    assert.strictEqual(download.status, 'cancelled')
  })

  it('is cancelled by a signal that was already aborted', async () => {
    const download = new Download({
      user: 'alice',
      file: 'music\\song.mp3',
      signal: AbortSignal.abort()
    })

    // the failure must be observable by whoever built the download
    const failure = new Promise<Error>(resolve => download.on('failed', resolve))
    assert.ok(await failure instanceof DownloadCancelledError)
    await assert.rejects(download.promise, DownloadCancelledError)
  })

  it('fails a download that stops making progress', async () => {
    const download = new Download({ user: 'alice', file: 'music\\song.mp3', timeout: 40 })
    download.queued(2)

    await assert.rejects(download.promise, (err: Error) => {
      assert.ok(err instanceof DownloadTimeoutError)
      assert.strictEqual(err.timeout, 40)
      return true
    })
    assert.strictEqual(download.status, 'failed')
  })

  it('leaves a download that keeps making progress alone', async () => {
    const download = new Download({
      user: 'alice',
      file: 'music\\song.mp3',
      path: baseFolder + '/timeout.mp3',
      timeout: 60
    })

    for (let i = 0; i < 4; i++) {
      await sleep(30)
      download.push(Buffer.from('1'))
    }
    assert.strictEqual(download.isSettled, false, 'data kept coming in')

    await download.end()
    await sleep(80)
    assert.strictEqual(download.status, 'complete', 'the timer is dropped once it is over')
  })

  it('writes next to the file name when no path is given', () => {
    const download = new Download({ user: 'alice', file: 'music\\great song.mp3' })

    assert.strictEqual(download.destination, '/tmp/slsk/alice_great song.mp3')
  })
})

describe('class Downloads', () => {
  it('keeps the downloads of a user apart from the others', () => {
    const downloads = new Downloads()
    const first = downloads.start({ user: 'alice', file: 'a.mp3' })
    const second = downloads.start({ user: 'bob', file: 'a.mp3' })

    assert.strictEqual(downloads.get('alice', 'a.mp3'), first)
    assert.strictEqual(downloads.get('bob', 'a.mp3'), second)
    assert.strictEqual(downloads.get('carol', 'a.mp3'), undefined)
    assert.strictEqual(downloads.pending.length, 2)
  })

  it('does not mix up a user and a file name that could be concatenated', () => {
    const downloads = new Downloads()
    const first = downloads.start({ user: 'a', file: 'b_c' })
    const second = downloads.start({ user: 'a_b', file: 'c' })

    assert.notStrictEqual(first, second)
    assert.strictEqual(downloads.get('a', 'b_c'), first)
    assert.strictEqual(downloads.get('a_b', 'c'), second)
  })

  it('fails the previous attempt when the same file is asked for again', async () => {
    const downloads = new Downloads()
    const first = downloads.start({ user: 'alice', file: 'a.mp3' })
    const second = downloads.start({ user: 'alice', file: 'a.mp3' })

    await assert.rejects(first.promise, { message: 'Replaced by a new download' })
    assert.strictEqual(downloads.get('alice', 'a.mp3'), second)
  })

  it('finds a download from the transfer token of the peer', () => {
    const downloads = new Downloads()
    const download = downloads.start({ user: 'alice', file: 'a.mp3' })

    downloads.bindToken('cafed00d', download)
    assert.strictEqual(downloads.byTransferToken('cafed00d'), download)

    downloads.forgetToken('cafed00d')
    assert.strictEqual(downloads.byTransferToken('cafed00d'), undefined)
  })

  it('forgets a download and its tokens once it is over', async () => {
    const downloads = new Downloads()
    const download = downloads.start({ user: 'alice', file: 'a.mp3' })
    downloads.bindToken('cafed00d', download)

    download.fail(new Error('nope'))
    await assert.rejects(download.promise)

    assert.strictEqual(downloads.get('alice', 'a.mp3'), undefined)
    assert.strictEqual(downloads.byTransferToken('cafed00d'), undefined)
    assert.deepStrictEqual(downloads.pending, [])
  })

  it('forgets a download the caller cancelled', async () => {
    const downloads = new Downloads()
    const download = downloads.start({ user: 'alice', file: 'a.mp3' })

    download.cancel()
    await assert.rejects(download.promise, DownloadCancelledError)

    assert.strictEqual(downloads.get('alice', 'a.mp3'), undefined)
    assert.deepStrictEqual(downloads.pending, [])
  })

  it('fails everything still running', async () => {
    const downloads = new Downloads()
    const first = downloads.start({ user: 'alice', file: 'a.mp3' })
    const second = downloads.start({ user: 'bob', file: 'b.mp3' })

    downloads.failAll(new Error('Client destroyed'))

    await assert.rejects(first.promise, { message: 'Client destroyed' })
    await assert.rejects(second.promise, { message: 'Client destroyed' })
    assert.deepStrictEqual(downloads.pending, [])
  })
})

describe('toSearchResult', () => {
  it('surfaces the attributes a peer sent', () => {
    const result = toSearchResult({
      user: 'alice',
      file: 'music\\great song.mp3',
      size: 4,
      attribs: {
        [FileAttribute.Bitrate]: 320,
        [FileAttribute.Duration]: 214,
        [FileAttribute.VBR]: 1
      }
    }, {
      currentToken: '0a0b0c0d',
      files: [],
      slots: 1,
      speed: 4242,
      queueLength: 3
    })

    assert.deepStrictEqual(result, {
      user: 'alice',
      file: 'music\\great song.mp3',
      size: 4,
      slots: true,
      attribs: {
        [FileAttribute.Bitrate]: 320,
        [FileAttribute.Duration]: 214,
        [FileAttribute.VBR]: 1
      },
      speed: 4242,
      queueLength: 3
    } satisfies SearchResult)

    assert.strictEqual(result.attribs[FileAttribute.Bitrate], 320)
    assert.strictEqual(result.attribs[FileAttribute.VBR] === 1, true)
  })

  it('keeps an attribute code it knows nothing about', () => {
    const result = toSearchResult(
      { user: 'alice', file: 'a.mp3', size: 4, attribs: { 42: 7 } },
      { currentToken: '0a0b0c0d', files: [], slots: 0, speed: 0, queueLength: 0 }
    )

    assert.strictEqual(result.slots, false)
    assert.strictEqual(result.attribs[42], 7)
    assert.strictEqual(result.attribs[FileAttribute.Bitrate], undefined)
  })
})

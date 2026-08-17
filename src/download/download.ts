import EventEmitter from 'events'
import fs from 'fs'
import { dirname } from 'path'
import { PassThrough, type Readable } from 'stream'
import createDebug from 'debug'
import type { DownloadProgress, DownloadResult } from '../types'

const debug = createDebug('slsk:download')

export type DownloadStatus =
  /** The peer has been asked for the file, it has not answered yet */
  | 'requested'
  /** The peer put the file in its upload queue */
  | 'queued'
  /** The peer announced the transfer, the file connection is being opened */
  | 'connected'
  /** Data is coming in */
  | 'downloading'
  /** Everything has been received and written */
  | 'complete'
  /** The transfer will not happen, see the error */
  | 'failed'

export type DownloadEvents = {
  /** Emitted on every status change */
  status: [status: DownloadStatus]
  /** Our place in the upload queue of the peer */
  queue: [place: number]
  progress: [progress: DownloadProgress]
  /** Raw chunk, as received */
  data: [chunk: Buffer]
  complete: [result: DownloadResult]
  /** Not named `error`, so a download nobody listens to cannot crash the process */
  failed: [err: Error]
}

export interface DownloadInit {
  /** Peer sending the file */
  user: string
  /** Full path of the file on the peer side */
  file: string
  /** Where the file is written (default: /tmp/slsk/{{user}}_{{originalName}}) */
  path?: string
  /** Bytes already on disk, sent to the peer as the file offset to resume */
  offset?: number
  /** Size announced by the search result, replaced by the one the peer announces */
  size?: number
}

/**
 * One running download: its state, the data received so far, and the promise resolved once the
 * file is complete. Replaces the entries the peers used to write in a shared global map.
 */
export default class Download extends EventEmitter<DownloadEvents> {
  readonly user: string
  readonly file: string
  readonly path?: string
  readonly offset: number
  /** Resolves once the file is received and written, rejects when the transfer fails */
  readonly promise: Promise<DownloadResult>
  /** Size announced by the peer, undefined until then */
  size?: number
  status: DownloadStatus = 'requested'

  private data = Buffer.alloc(0)
  private passThrough?: PassThrough
  private settled = false
  private resolveResult!: (result: DownloadResult) => void
  private rejectResult!: (err: Error) => void

  constructor (init: DownloadInit) {
    super()
    this.user = init.user
    this.file = init.file
    this.path = init.path
    this.offset = init.offset && init.offset > 0 ? init.offset : 0
    this.size = init.size

    this.promise = new Promise<DownloadResult>((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    // nobody has to await the promise, the events are enough for stream users
    this.promise.catch(() => {})
  }

  /** Bytes on disk once the transfer is over, the offset included */
  get receivedBytes (): number {
    return this.offset + this.data.length
  }

  /** true once the promise has been settled, whether the file arrived or not */
  get isSettled (): boolean {
    return this.settled
  }

  /** true when everything the peer announced has been received */
  get isComplete (): boolean {
    return this.size !== undefined && this.receivedBytes >= this.size
  }

  /**
   * Data as it is received. Reading it before the transfer starts is what `downloadStream()`
   * does, a stream taken later misses the chunks already received.
   */
  get stream (): Readable {
    if (!this.passThrough) this.passThrough = new PassThrough()
    return this.passThrough
  }

  /** Where the file will be written */
  get destination (): string {
    if (this.path) return this.path
    const parts = this.file.split('\\')
    return `/tmp/slsk/${this.user}_${parts[parts.length - 1]}`
  }

  setStatus (status: DownloadStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  /** The peer told us where we sit in its upload queue */
  queued (place: number): void {
    if (this.status === 'requested') this.setStatus('queued')
    this.emit('queue', place)
  }

  /** The peer announced the transfer, with the size of the file when it knows it */
  announced (size?: number): void {
    if (size !== undefined) this.size = size
    this.setStatus('connected')
  }

  /** Feeds received data, returns true when the file is complete */
  push (chunk: Buffer): boolean {
    if (chunk.length === 0) return this.isComplete
    this.setStatus('downloading')

    this.data = Buffer.concat([this.data, chunk])
    if (this.passThrough) this.passThrough.write(chunk)
    this.emit('data', chunk)
    this.emit('progress', {
      user: this.user,
      file: this.file,
      receivedBytes: this.receivedBytes,
      totalBytes: this.size,
      progress: this.size ? this.receivedBytes / this.size : undefined
    } satisfies DownloadProgress)

    return this.isComplete
  }

  /** Writes what has been received and settles the promise, once */
  async end (): Promise<void> {
    if (this.settled) return
    this.settled = true

    const path = this.destination
    try {
      await fs.promises.mkdir(dirname(path), { recursive: true })
      await (this.offset > 0
        ? fs.promises.appendFile(path, this.data)
        : fs.promises.writeFile(path, this.data))
    } catch (err) {
      this.settled = false
      this.fail(err as Error)
      return
    }

    if (this.passThrough) this.passThrough.end()
    this.setStatus('complete')

    const result: DownloadResult = {
      path,
      buffer: this.data,
      receivedBytes: this.receivedBytes,
      size: this.size
    }
    debug(`${this.user} ${this.file} complete, ${result.receivedBytes} bytes in ${path}`)
    this.emit('complete', result)
    this.resolveResult(result)
  }

  /** Fails the transfer, once: a peer cannot settle the same download twice */
  fail (err: Error): boolean {
    if (this.settled) return false
    this.settled = true
    this.setStatus('failed')
    debug(`${this.user} ${this.file} failed: ${err.message}`)
    if (this.passThrough) this.passThrough.destroy(err)
    this.emit('failed', err)
    this.rejectResult(err)
    return true
  }
}

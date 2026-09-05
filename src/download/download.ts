import EventEmitter from 'events'
import fs from 'fs'
import { dirname } from 'path'
import { PassThrough, type Readable } from 'stream'
import createDebug from 'debug'
import { DownloadCancelledError, DownloadTimeoutError } from './errors'
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
  /** The transfer stopped short of the announced size, it is asked for again from there */
  | 'interrupted'
  /** Everything has been received and written */
  | 'complete'
  /** The transfer will not happen, see the error */
  | 'failed'
  /** The caller gave up on the transfer */
  | 'cancelled'

export type DownloadEvents = {
  /** Emitted on every status change */
  status: [status: DownloadStatus]
  /** Our place in the upload queue of the peer */
  queue: [place: number]
  progress: [progress: DownloadProgress]
  /**
   * The transfer stopped before everything announced had arrived, whether the connection was
   * closed or went silent. What was received is kept and the transfer is asked for again.
   */
  interrupted: [evt: { receivedBytes: number, size?: number, attempts: number }]
  /** Raw chunk, as received */
  data: [chunk: Buffer]
  complete: [result: DownloadResult]
  /**
   * The transfer will not happen, whether the peer refused it, the timeout expired or the
   * caller cancelled it (`status` tells which).
   * Not named `error`, so a download nobody listens to cannot crash the process.
   */
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
  /**
   * Size the search result announced. Only a hint: the peer that serves the file is the one
   * that tells how big it is, so this never decides when the transfer is over.
   */
  expectedSize?: number
  /** ms without any progress after which the download fails (default: no timeout) */
  timeout?: number
  /** Aborting it cancels the download, whatever state it is in */
  signal?: AbortSignal
}

/**
 * One running download: its state, the data received so far, and the promise resolved once the
 * file is complete. Awaiting the download itself awaits that promise.
 */
export default class Download extends EventEmitter<DownloadEvents> implements Promise<DownloadResult> {
  readonly user: string
  readonly file: string
  readonly path?: string
  readonly offset: number
  /** Size the search result announced, if any: a hint, replaced by what the peer announces */
  readonly expectedSize?: number
  /** How many times the transfer had to be asked for again after an interruption */
  attempts = 0
  /** Resolves once the file is received and written, rejects when the transfer fails */
  readonly promise: Promise<DownloadResult>
  /** Size announced by the peer, undefined until it announced the transfer */
  size?: number
  status: DownloadStatus = 'requested'
  readonly [Symbol.toStringTag] = 'Download'

  // chunks as received, concatenated once in end(): a per-chunk concat
  // re-copies everything received so far, which is quadratic and stalls
  // the event loop on big files
  private chunks: Buffer[] = []
  private receivedLength = 0
  private passThrough?: PassThrough
  private settled = false
  private resolveResult!: (result: DownloadResult) => void
  private rejectResult!: (err: Error) => void
  /** ms without progress before the download fails, unset when the caller wants no timeout */
  private readonly timeout?: number
  private timer?: NodeJS.Timeout
  private readonly signal?: AbortSignal
  private readonly onAbort?: () => void

  constructor (init: DownloadInit) {
    super()
    this.user = init.user
    this.file = init.file
    this.path = init.path
    this.offset = init.offset && init.offset > 0 ? init.offset : 0
    // a search result saying 0 says nothing, only the peer knows whether the file is empty
    this.expectedSize = fileSize(init.expectedSize, { allowEmpty: false })
    this.timeout = init.timeout && init.timeout > 0 ? init.timeout : undefined
    this.signal = init.signal

    this.promise = new Promise<DownloadResult>((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    // nobody has to await the promise, the events are enough for stream users
    this.promise.catch(() => {})

    if (this.signal) {
      const signal = this.signal
      this.onAbort = () => this.cancel(abortReason(signal))
      if (signal.aborted) {
        // let whoever built us register its listeners before the download is settled
        queueMicrotask(this.onAbort)
      } else {
        signal.addEventListener('abort', this.onAbort, { once: true })
      }
    }

    this.touch()
  }

  /** Bytes on disk once the transfer is over, the offset included */
  get receivedBytes (): number {
    return this.offset + this.receivedLength
  }

  /**
   * Size of the file: what the peer announced, the search result hint until then, and
   * `undefined` while neither is known.
   */
  get totalBytes (): number | undefined {
    return this.size ?? this.expectedSize
  }

  /** true once the peer announced the size of the file, so `totalBytes` is not a guess */
  get isSizeKnown (): boolean {
    return this.size !== undefined
  }

  /** true once the promise has been settled, whether the file arrived or not */
  get isSettled (): boolean {
    return this.settled
  }

  /** true when the caller gave up on this transfer */
  get isCancelled (): boolean {
    return this.status === 'cancelled'
  }

  /**
   * true when the whole file has been received, which is what tells the downloader to close the
   * file connection. Based on the size the peer announced, or on the search-result hint in the
   * legacy flow, where no message carries the size. Stays false when neither is known: the file
   * is then complete when the peer closes the connection.
   */
  get isComplete (): boolean {
    const totalBytes = this.totalBytes
    return totalBytes !== undefined && this.receivedBytes >= totalBytes
  }

  /**
   * Data as it is received. Reading it before the transfer starts is what a caller streaming a
   * download does, a stream taken later misses the chunks already received.
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
    if (this.settled) return
    this.touch()
    if (this.status === 'requested') this.setStatus('queued')
    this.emit('queue', place)
  }

  /** The peer announced the transfer, with the size of the file when it knows it */
  announced (size?: number): void {
    if (this.settled) return
    this.touch()
    // the peer is authoritative, an empty file it announces is an empty file
    const announced = fileSize(size, { allowEmpty: true })
    if (announced !== undefined) this.size = announced
    this.setStatus('connected')
  }

  /**
   * The transfer stopped short of what the peer announced. Keeps everything received so the
   * next attempt can start from `receivedBytes`, and leaves the promise pending: whoever asked
   * for the file is still waiting for it.
   */
  interrupted (): void {
    if (this.settled) return
    this.attempts++
    this.setStatus('interrupted')
    debug(`${this.user} ${this.file} interrupted at ${this.receivedBytes}/${this.size ?? '?'}`)
    this.emit('interrupted', {
      receivedBytes: this.receivedBytes,
      size: this.size,
      attempts: this.attempts
    })
  }

  /** Feeds received data, returns true when nothing more is expected */
  push (chunk: Buffer): boolean {
    // whoever waited for these bytes is gone, the connection can be closed
    if (this.settled) return true
    if (chunk.length === 0) return this.isComplete

    this.touch()
    this.setStatus('downloading')

    this.chunks.push(chunk)
    this.receivedLength += chunk.length
    if (this.passThrough) this.passThrough.write(chunk)
    this.emit('data', chunk)
    this.emit('progress', this.progress())

    return this.isComplete
  }

  /** Writes what has been received and settles the promise, once */
  async end (): Promise<void> {
    if (this.settled) return
    this.settled = true

    const path = this.destination
    const data = Buffer.concat(this.chunks)
    try {
      await fs.promises.mkdir(dirname(path), { recursive: true })
      await (this.offset > 0
        ? fs.promises.appendFile(path, data)
        : fs.promises.writeFile(path, data))
    } catch (err) {
      this.settled = false
      this.fail(err as Error)
      return
    }

    this.release()
    if (this.passThrough) this.passThrough.end()
    this.setStatus('complete')

    const result: DownloadResult = {
      path,
      buffer: data,
      receivedBytes: this.receivedBytes,
      size: this.size
    }
    debug(`${this.user} ${this.file} complete, ${result.receivedBytes} bytes in ${path}`)
    this.emit('complete', result)
    this.resolveResult(result)
  }

  /** Fails the transfer, once: a peer cannot settle the same download twice */
  fail (err: Error): boolean {
    return this.settle(err, 'failed')
  }

  /**
   * Gives up on the transfer: the promise rejects with a {@link DownloadCancelledError} and the
   * client forgets it, so the same file can be asked for from another peer. Nothing is sent to
   * the peer, there is no protocol message for it, but the transfer it may still announce later
   * is refused.
   */
  cancel (reason?: string): boolean {
    return this.settle(new DownloadCancelledError(reason), 'cancelled')
  }

  /** Awaiting a download awaits its result */
  then<TResult1 = DownloadResult, TResult2 = never> (
    onfulfilled?: ((value: DownloadResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected)
  }

  catch<TResult = never> (
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<DownloadResult | TResult> {
    return this.promise.catch(onrejected)
  }

  finally (onfinally?: (() => void) | null): Promise<DownloadResult> {
    return this.promise.finally(onfinally)
  }

  private settle (err: Error, status: 'failed' | 'cancelled'): boolean {
    if (this.settled) return false
    this.settled = true
    this.release()
    this.setStatus(status)
    debug(`${this.user} ${this.file} ${status}: ${err.message}`)
    if (this.passThrough) this.passThrough.destroy(err)
    this.emit('failed', err)
    this.rejectResult(err)
    return true
  }

  private progress (): DownloadProgress {
    const totalBytes = this.totalBytes
    return {
      user: this.user,
      file: this.file,
      receivedBytes: this.receivedBytes,
      totalBytes,
      sizeAnnounced: this.size !== undefined,
      progress: progressOf(this.receivedBytes, totalBytes)
    }
  }

  /**
   * Restarts the inactivity timer: a transfer that stops halfway, or a queued file a peer never
   * comes back with, would otherwise leave the promise pending forever.
   */
  private touch (): void {
    const timeout = this.timeout
    if (timeout === undefined || this.settled) return

    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.fail(new DownloadTimeoutError(timeout, this.status))
    }, timeout)
    // a pending download must not be a reason for the process to stay alive
    this.timer.unref()
  }

  /** Drops what would outlive a settled download: the timer and the abort listener */
  private release (): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.signal && this.onAbort) {
      this.signal.removeEventListener('abort', this.onAbort)
    }
  }
}

/** Sizes that cannot be one are dropped, so `undefined` always means "not known yet" */
function fileSize (
  value: number | undefined,
  { allowEmpty }: { allowEmpty: boolean }
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  if (value === 0 && !allowEmpty) return undefined
  return value
}

/** Ratio between 0 and 1, undefined while the size of the file is unknown */
function progressOf (receivedBytes: number, totalBytes: number | undefined): number | undefined {
  if (totalBytes === undefined) return undefined
  if (totalBytes === 0) return 1
  // a wrong search-result hint must not report more than a whole file
  return Math.min(receivedBytes / totalBytes, 1)
}

/** Message of the reason an AbortSignal carries, whatever the caller aborted it with */
function abortReason (signal: AbortSignal): string | undefined {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  return undefined
}

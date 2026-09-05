import EventEmitter from 'events'
import createDebug from 'debug'
import type { ShareEntry, ShareProvider } from '../share/provider'
import type { UploadProgress } from '../types'

const debug = createDebug('slsk:upload')

export type UploadStatus =
  /** The peer asked for the file, no slot is free yet */
  | 'queued'
  /** A slot freed and the transfer has been announced to the peer */
  | 'requested'
  /** The peer accepted it, the file connection is being opened */
  | 'connected'
  /** Bytes are going out */
  | 'uploading'
  /** The whole file has been sent */
  | 'complete'
  /** The transfer will not happen, see the error */
  | 'failed'

export type UploadEvents = {
  /** Emitted on every status change */
  status: [status: UploadStatus]
  progress: [progress: UploadProgress]
  complete: [evt: { sentBytes: number, size: number }]
  /** Not named `error`, so an upload nobody listens to cannot crash the process */
  failed: [err: Error]
}

export interface UploadInit {
  /** Peer that asked for the file */
  user: string
  /** Path the peer asked for, which is the one advertised to it */
  file: string
  /** Entry of the share index, and the provider able to read its bytes back */
  entry: ShareEntry
  provider: ShareProvider
}

/**
 * One file being served to a peer: where it comes from, how far it got and what the peer has
 * been told. The client owns the queue and the slots, this only holds the state of one transfer.
 */
export default class Upload extends EventEmitter<UploadEvents> {
  readonly user: string
  readonly file: string
  readonly entry: ShareEntry
  readonly provider: ShareProvider
  /** Size of the file, refreshed by the provider before the transfer is announced */
  size: number
  status: UploadStatus = 'queued'
  /** Token of the transfer we announced, undefined while the file waits in the queue */
  token?: string
  /** First byte the peer asked for, non zero when it resumes a partial file */
  offset = 0
  /** Bytes sent on the current connection */
  transferredBytes = 0

  private settled = false

  constructor (init: UploadInit) {
    super()
    this.user = init.user
    this.file = init.file
    this.entry = init.entry
    this.provider = init.provider
    this.size = init.entry.size
  }

  /** Bytes of the file the peer holds once these are written, the offset included */
  get sentBytes (): number {
    return this.offset + this.transferredBytes
  }

  /** true once the whole file has been sent, or the transfer has failed */
  get isSettled (): boolean {
    return this.settled
  }

  /** true when everything the peer asked for has been sent */
  get isComplete (): boolean {
    return this.sentBytes >= this.size
  }

  setStatus (status: UploadStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  /** A slot freed and the transfer has been announced with this token */
  requested (token: string, size: number): void {
    this.token = token
    this.size = size
    this.setStatus('requested')
  }

  /** The file connection is up and the peer told us where to start */
  started (offset: number): void {
    this.offset = offset > 0 ? offset : 0
    this.transferredBytes = 0
    this.setStatus('connected')
    debug(`${this.user} ${this.file} starts at ${this.offset}/${this.size}`)
  }

  /** Counts what just went out on the wire */
  sent (bytes: number): void {
    if (bytes <= 0) return
    this.transferredBytes += bytes
    this.setStatus('uploading')
    this.emit('progress', {
      user: this.user,
      file: this.file,
      sentBytes: this.sentBytes,
      totalBytes: this.size,
      // a provider whose file grew since it was indexed must not report more than a whole file
      progress: this.size > 0 ? Math.min(this.sentBytes / this.size, 1) : 1
    })
  }

  complete (): boolean {
    if (this.settled) return false
    this.settled = true
    this.setStatus('complete')
    debug(`${this.user} ${this.file} sent, ${this.sentBytes}/${this.size} bytes`)
    this.emit('complete', { sentBytes: this.sentBytes, size: this.size })
    return true
  }

  /** Fails the transfer, once: nothing settles the same upload twice */
  fail (err: Error): boolean {
    if (this.settled) return false
    this.settled = true
    this.setStatus('failed')
    debug(`${this.user} ${this.file} failed: ${err.message}`)
    this.emit('failed', err)
    return true
  }
}

import createDebug from 'debug'
import Upload, { type UploadInit } from './upload'

const debug = createDebug('slsk:uploads')

/**
 * The files this client is serving, indexed by peer and file and by the tokens we chose for the
 * transfers. The insertion order is the order of the queue: the peer that asked first is served
 * first, whatever the peer asking.
 */
export default class Uploads {
  private readonly byUser = new Map<string, Map<string, Upload>>()
  private readonly byToken = new Map<string, Upload>()

  /** Puts a file in the queue, or returns the entry already there for the same peer and file */
  queue (init: UploadInit): Upload {
    const existing = this.get(init.user, init.file)
    if (existing) return existing

    const upload = new Upload(init)
    const files = this.byUser.get(init.user) ?? new Map<string, Upload>()
    files.set(init.file, upload)
    this.byUser.set(init.user, files)

    // stop tracking it as soon as it is over, whatever the outcome
    upload.once('complete', () => this.forget(upload))
    upload.once('failed', () => this.forget(upload))

    debug(`queue ${init.user} ${init.file}`)
    return upload
  }

  get (user: string, file: string): Upload | undefined {
    return this.byUser.get(user)?.get(file)
  }

  /** Upload we announced with this transfer token */
  byTransferToken (token: string): Upload | undefined {
    return this.byToken.get(token)
  }

  bindToken (token: string, upload: Upload): void {
    debug(`bind token ${token} to ${upload.user} ${upload.file}`)
    this.byToken.set(token, upload)
  }

  forgetToken (token: string): void {
    this.byToken.delete(token)
  }

  /** Every upload of this client, queued or running */
  get pending (): Upload[] {
    return [...this.byUser.values()].flatMap(files => [...files.values()])
  }

  /** The ones taking a slot: announced to their peer, or sending bytes */
  get active (): Upload[] {
    return this.pending.filter(upload => upload.status !== 'queued')
  }

  /** The ones still waiting for a slot, oldest first */
  get waiting (): Upload[] {
    return this.pending.filter(upload => upload.status === 'queued')
  }

  /** How many files this peer has waiting, to refuse a peer queueing the whole share */
  waitingFor (user: string): number {
    return this.waiting.filter(upload => upload.user === user).length
  }

  /**
   * Place of a file in the queue, counted from 1 as the protocol expects. 0 for a transfer that
   * is no longer waiting, which is what tells the peer it is starting.
   */
  placeInQueue (upload: Upload): number {
    const place = this.waiting.indexOf(upload)
    return place < 0 ? 0 : place + 1
  }

  forget (upload: Upload): void {
    const files = this.byUser.get(upload.user)
    if (files?.get(upload.file) === upload) {
      files.delete(upload.file)
      if (files.size === 0) this.byUser.delete(upload.user)
    }

    this.byToken.forEach((bound, token) => {
      if (bound === upload) this.byToken.delete(token)
    })
  }

  /** Fails everything still running, used when the client is destroyed */
  failAll (err: Error): void {
    this.pending.forEach(upload => upload.fail(err))
  }
}

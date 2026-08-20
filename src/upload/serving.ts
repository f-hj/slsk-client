import crypto from 'crypto'
import createDebug from 'debug'
import UploadPeer from '../peer/file-peer/upload-peer'
import waitFor from '../utils/wait-for'
import { PEER_TIMEOUT } from '../defaults'
import { UPLOADS_DISABLED } from '../peer/default-peer/handler'
import { UploadPermission } from '../types'
import type DefaultPeer from '../peer/default-peer/default-peer'
import type Upload from './upload'
import type { ClientContext } from '../context'

const debug = createDebug('slsk:upload:serve')

/** What a peer is told about our upload capacity, in a UserInfoResponse and with every search answer */
export interface UploadCapacity {
  uploadSlots: number
  queueSize: number
  slotsFree: boolean
  uploadPermitted: UploadPermission
}

/**
 * The side of the client that sends files: the queue peers wait in, the slots it is emptied
 * through, and the file connections the transfers run on.
 */
export default class Serving {
  constructor (private readonly ctx: ClientContext) {}

  /**
   * What we tell peers about our upload capacity. A client that does not serve its files says so,
   * instead of advertising a free slot and denying every peer that picks it for it.
   */
  capacity (): UploadCapacity {
    const config = this.ctx.uploadOptions
    const uploads = this.ctx.session.uploads

    return {
      uploadSlots: config ? config.slots : 0,
      queueSize: uploads.waiting.length,
      slotsFree: config ? uploads.active.length < config.slots : false,
      uploadPermitted: config ? UploadPermission.Everyone : UploadPermission.NoOne
    }
  }

  /**
   * A peer asked for one of our files: checks it is really shared and puts it in the queue,
   * which is emptied one slot at a time. Nothing is sent back when the file is accepted, the
   * peer learns about it when the transfer is announced or when it asks for its place.
   */
  async queue (peer: DefaultPeer, file: string): Promise<void> {
    const config = this.ctx.uploadOptions
    if (!config) {
      peer.uploadDenied(file, UPLOADS_DISABLED)
      return
    }

    const uploads = this.ctx.session.uploads
    const running = uploads.get(peer.user, file)
    if (running) {
      debug(`${peer.user} asks again for ${file}, already ${running.status}`)
      return
    }

    // resolved against the index, so a crafted path cannot reach anything we do not share
    const indexed = this.ctx.sharing.shared.resolve(file)
    if (!indexed) {
      debug(`${peer.user} wants ${file}, which is not shared`)
      peer.uploadDenied(file, 'File not shared.')
      return
    }

    if (uploads.waitingFor(peer.user) >= config.queueLimit) {
      debug(`${peer.user} has ${config.queueLimit} files waiting already`)
      peer.uploadDenied(file, 'Too many files')
      return
    }

    const upload = uploads.queue({
      user: peer.user,
      file,
      entry: indexed.entry,
      provider: indexed.provider
    })

    upload.on('progress', progress => this.ctx.emit('upload-progress', progress))
    upload.once('complete', evt => {
      this.ctx.emit('upload-complete', { user: upload.user, file, sentBytes: evt.sentBytes })
      this.serveNext()
    })
    upload.once('failed', error => {
      this.ctx.emit('upload-failed', { user: upload.user, file, error })
      // the peer is waiting for a transfer that will not come, or for a file it never gets
      if (upload.token) peer.uploadFailed(file)
      this.serveNext()
    })

    this.ctx.emit('upload-queued', { user: peer.user, file, place: uploads.placeInQueue(upload) })
    await this.serve()
  }

  /** Answers where a file the peer is waiting for stands in our queue */
  placeRequested (peer: DefaultPeer, file: string): void {
    const uploads = this.ctx.session.uploads
    const upload = uploads.get(peer.user, file)
    if (!upload) {
      debug(`${peer.user} asks its place for ${file}, which is not queued`)
      return
    }
    peer.placeInQueueResponse(file, uploads.placeInQueue(upload))
  }

  /**
   * A peer asking the old way, before QueueUpload existed. Answering `allowed` would let a peer
   * that spoofed the request open the file connection itself, so the request goes through the
   * queue like any other and the answer is the 'Queued' refusal every current client uses: the
   * transfer is then announced with our own token.
   */
  requestedByPeer (peer: DefaultPeer, evt: { token: string, file: string }): void {
    if (!this.ctx.servesUploads) {
      debug(`${peer.user} asks to download ${evt.file}, uploads are disabled`)
      peer.transferResponse(evt.token, false, UPLOADS_DISABLED)
      return
    }

    debug(`${peer.user} asks to download ${evt.file} the old way, queueing it`)
    peer.transferResponse(evt.token, false, 'Queued')
    void this.queue(peer, evt.file)
  }

  /**
   * What the peer answered to a file we announced. A refusal frees the slot for the next one in
   * the queue: 'Complete' is a peer telling us it has the file after all, everything else is a
   * transfer that will not happen.
   */
  answered (
    peer: DefaultPeer,
    upload: Upload,
    evt: { token: string, allowed: boolean, reason?: string }
  ): void {
    if (!evt.allowed) {
      const reason = evt.reason ?? ''
      debug(`${peer.user} refused ${upload.file}: ${reason || 'no reason'}`)
      upload.fail(new Error(`${peer.user} refused the file: ${reason || 'no reason'}`))
      return
    }

    debug(`${peer.user} accepted ${upload.file}, opening the file connection`)
    this.start(peer, upload)
      .catch((err: Error) => upload.fail(err))
  }

  /** Serves the queue when a slot frees, from a listener that cannot await it */
  serveNext (): void {
    this.serve()
      .catch((err: Error) => debug(`cannot serve the upload queue: ${err.message}`))
  }

  /** Announces as many queued files as there are free slots, oldest request first */
  async serve (): Promise<void> {
    const config = this.ctx.uploadOptions
    if (!config) return

    const uploads = this.ctx.session.uploads
    while (uploads.active.length < config.slots) {
      const next = uploads.waiting[0]
      if (!next) return

      await this.announce(next)
    }
  }

  /**
   * Tells the peer the file is coming, with the size the provider reports now: an entry indexed
   * a while ago may point at a file that changed since, and the size announced here is the one
   * the transfer is measured against.
   */
  private async announce (upload: Upload): Promise<void> {
    const peer = this.ctx.peers.peerConnection(upload.user)
    if (!peer) {
      // it asked on a connection that is gone, it will ask again when it comes back
      upload.fail(new Error(`No peer connection to ${upload.user}`))
      return
    }

    let size = upload.entry.size
    if (upload.provider.stat) {
      try {
        const stat = await upload.provider.stat(upload.entry)
        if (!stat) {
          upload.fail(new Error(`${upload.file} is gone`))
          peer.uploadDenied(upload.file, 'File not shared.')
          return
        }
        size = stat.size
      } catch (err) {
        upload.fail(new Error(`Cannot stat ${upload.file}: ${String(err)}`))
        peer.uploadDenied(upload.file, 'File read error.')
        return
      }
    }

    const token = crypto.randomBytes(4).toString('hex')
    this.ctx.session.uploads.bindToken(token, upload)
    upload.requested(token, size)
    peer.uploadRequest(upload.file, token, size)
  }

  /**
   * The peer accepted a transfer we announced: opens the file connection towards it, and only
   * asks the server to relay one when the peer cannot be reached. A peer connection carries the
   * ephemeral port of the peer, never the one it listens on, so the address comes from the server.
   */
  private async start (peer: DefaultPeer, upload: Upload): Promise<void> {
    const address = await this.addressOf(upload.user, peer)

    if (address) {
      const connection = UploadPeer.open({
        host: address.host,
        port: address.port,
        session: this.ctx.session,
        upload,
        transferTimeout: this.ctx.transferTimeout
      })

      try {
        await connection.ready
        return
      } catch (err) {
        debug(`cannot open a file connection to ${upload.user}: ${String(err)}`)
        connection.destroy()
      }
    }

    if (upload.isSettled) return
    this.relayFileConnection(upload)
  }

  /**
   * Address a file connection can be opened to: the one the peer connection already knows, or the
   * one the server has for that user. `undefined` for a peer the server reports as unreachable,
   * which is what port 0 means.
   */
  private async addressOf (
    user: string,
    peer: DefaultPeer
  ): Promise<{ host: string, port: number } | undefined> {
    if (peer.peer.host && peer.peer.port) {
      return { host: peer.peer.host, port: peer.peer.port }
    }

    try {
      const answer = waitFor(this.ctx.server, 'get-peer-address', {
        timeout: PEER_TIMEOUT,
        timeoutError: new Error(`GetPeerAddress timed out for ${user}`),
        match: address => address.user === user
      })
      this.ctx.server.getPeerAddress(user)

      const [address] = await answer
      if (!address.port || !address.host) return undefined
      return { host: address.host, port: address.port }
    } catch (err) {
      debug(`no address for ${user}: ${String(err)}`)
      return undefined
    }
  }

  /**
   * Asks the server to make the peer open the file connection, for a peer we cannot reach, and
   * sends the file on the connection it pierces our firewall with. Needs our own listening port
   * to be reachable, since the server hands the peer the address it has for us.
   */
  private relayFileConnection (upload: Upload): void {
    const token = upload.token as string
    debug(`asking the server to have ${upload.user} open the file connection`)

    const gaveUp = setTimeout(() => {
      if (!this.ctx.peers.forgetPierce(token)) return
      upload.fail(new Error(
        `${upload.user} never opened the file connection, and it could not be reached directly` +
        ` either: our listening port ${this.ctx.incomingPort} may not be reachable`
      ))
    }, PEER_TIMEOUT)
    gaveUp.unref()

    this.ctx.peers.expectPierce(token, (socket, initialData) => {
      clearTimeout(gaveUp)
      new UploadPeer(socket, { user: upload.user, type: 'F', token }, {
        session: this.ctx.session,
        upload,
        initialData,
        transferTimeout: this.ctx.transferTimeout
      })
    })
    this.ctx.server.connectToPeer(token, upload.user, 'F')
  }
}

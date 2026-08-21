import crypto from 'crypto'
import createDebug from 'debug'
import DefaultPeer from '../peer/default-peer/default-peer'
import FilePeer from '../peer/file-peer/file-peer'
import {
  DEFAULT_QUEUE_FALLBACK_DELAY,
  DOWNLOAD_RETRIES,
  RESUME_DELAY,
  TRANSFER_ACCEPT_DELAY
} from '../defaults'
import type Download from './download'
import type { ClientContext } from '../context'
import type { DownloadOptions } from '../types'

const debug = createDebug('slsk:download:request')

/**
 * The side of the client that asks for files: how a peer is asked, how a transfer it announces is
 * accepted, and what happens to a download that stops early or is never answered.
 */
export default class Requesting {
  constructor (private readonly ctx: ClientContext) {}

  /**
   * Asks a peer for a file. Returns the running download right away, without waiting for the
   * peer: `await` it for the finished file, read its `stream` to get the data as it arrives, or
   * follow its events. Everything that can go wrong is reported on it, connecting included.
   */
  start (options: DownloadOptions): Download {
    const { user, file } = options
    if (!user || !file) throw new Error('download() needs the user and the file to download')

    const download = this.ctx.session.downloads.start({
      user,
      file,
      path: options.path,
      offset: options.offset,
      expectedSize: options.size,
      timeout: options.timeout ?? this.ctx.options.downloadTimeout,
      signal: options.signal
    })

    download.on('progress', progress => this.ctx.emit('download-progress', progress))
    download.on('queue', place => this.ctx.emit('download-queue', { user, file, place }))
    download.on('interrupted', evt => {
      this.ctx.emit('download-interrupted', { user, file, ...evt })
      this.resume(download)
    })

    // asking on the next tick, so a caller that cancels right away asks the peer for nothing
    queueMicrotask(() => {
      if (download.isSettled) return
      this.request(download)
        .catch((err: Error) => download.fail(err))
    })

    return download
  }

  /**
   * Connects to the peer and asks it for the file: QueueUpload (43) + PlaceInQueueRequest (51),
   * the flow of every current client, and the legacy TransferRequest (40, direction 0) for the
   * peers that do not understand it. Nothing on the wire tells the two apart, so a peer that
   * answers nothing at all is asked again the old way, and remembered as such.
   */
  private async request (download: Download): Promise<void> {
    const { user, file } = download
    debug(`launch download ${user} ${file}`)

    // reuses the connection to that peer when there is one, and waits for it to be up
    const peer = await this.ctx.peers.connectToUser(user)
    if (!(peer instanceof DefaultPeer)) {
      throw new Error(`No peer connection to ${user}`)
    }
    // cancelled or replaced while we were connecting, asking for it now would download it twice
    if (download.isSettled) return

    if (peer.supportsQueue === false) {
      this.legacyRequest(peer, download)
      return
    }

    peer.queueUpload(file)
    peer.placeInQueueRequest(file)

    if (peer.supportsQueue !== true) this.fallBackWhenSilent(peer, download)
  }

  /**
   * Asks for the rest of a transfer that stopped early. The file is asked for the same way it
   * was the first time, and the offset sent to the peer is everything received so far, so
   * nothing already downloaded is asked for twice.
   */
  private resume (download: Download): void {
    const attempts = this.ctx.options.downloadRetries ?? DOWNLOAD_RETRIES
    if (download.attempts > attempts) {
      download.fail(new Error(
        `Transfer interrupted at ${download.receivedBytes}/${download.size ?? '?'} bytes,` +
        ` gave up after ${attempts} ${attempts === 1 ? 'retry' : 'retries'}`
      ))
      return
    }

    // the token of the attempt that just died must not resolve anything anymore
    this.ctx.session.downloads.forgetTokensOf(download)

    debug(`resume ${download.user} ${download.file} at ${download.receivedBytes}, ` +
      `attempt ${download.attempts}/${attempts}`)

    const retry = setTimeout(() => {
      if (download.isSettled) return
      // the peer connection is often gone too, requestDownload opens a new one when needed
      this.request(download)
        .catch((err: Error) => download.fail(err))
    }, RESUME_DELAY)
    // a transfer waiting to be asked for again must not keep the process alive
    retry.unref()
  }

  /**
   * Asks a peer that ignored the queue request for the file the way clients did before the
   * queue existed: it either starts the transfer right away or answers a refusal, so a download
   * cannot stay stuck on a message the peer never understood.
   */
  private fallBackWhenSilent (peer: DefaultPeer, download: Download): void {
    const delay = this.ctx.options.queueFallbackDelay ?? DEFAULT_QUEUE_FALLBACK_DELAY

    const fallback = setTimeout(() => {
      // anything the peer answers changes the status, silence leaves it untouched
      if (download.status !== 'requested' || peer.supportsQueue === true) return

      // silence on a connection that is gone says nothing about what the peer understands, and
      // remembering it as a peer to never ask the modern way again would be wrong
      if (!peer.connected) {
        debug(`${peer.label} never answered about its queue, its connection is gone`)
        download.fail(new Error(`Lost the connection to ${peer.user}`))
        return
      }

      debug(`${peer.label} answered nothing about its queue, asking the old way`)
      peer.supportsQueue = false
      this.legacyRequest(peer, download)
    }, delay)
    // a download waiting for a peer must not be a reason for the process to stay alive
    fallback.unref()

    download.once('status', () => clearTimeout(fallback))
  }

  /** TransferRequest (40, direction 0): we pick the token and ask for the transfer ourselves */
  private legacyRequest (peer: DefaultPeer, download: Download): void {
    const token = crypto.randomBytes(4).toString('hex')
    this.ctx.session.downloads.bindToken(token, download)
    peer.transferRequest(download.file, token)
  }

  /** A peer announces a transfer (direction 1): accept the ones we asked for, refuse the rest */
  announcedByPeer (
    peer: DefaultPeer,
    evt: { token: string, file: string, size?: number }
  ): void {
    const downloads = this.ctx.session.downloads
    const download = downloads.get(peer.user, evt.file)
    if (!download) {
      debug(`${peer.label} announces ${evt.file}, which we did not ask for`)
      peer.transferResponse(evt.token, false, 'Cancelled')
      return
    }

    downloads.bindToken(evt.token, download)
    download.announced(evt.size)
    setTimeout(() => peer.transferResponse(evt.token, true), TRANSFER_ACCEPT_DELAY)
  }

  /** The peer answered a transfer we asked for */
  answered (
    peer: DefaultPeer,
    evt: { token: string, allowed: boolean, reason?: string }
  ): void {
    const downloads = this.ctx.session.downloads
    const download = downloads.byTransferToken(evt.token)

    if (!evt.allowed) {
      const reason = evt.reason ?? ''
      // the token we picked is only ever used by a peer that starts the transfer itself
      downloads.forgetToken(evt.token)

      if (isQueuedReason(reason)) {
        // the peer will announce the transfer with its own token once a slot frees
        debug(`${peer.label} queued ${download?.file ?? evt.token}`)
        if (download) {
          download.setStatus('queued')
          // pointless towards a peer that already ignored a place request
          if (peer.supportsQueue !== false) peer.placeInQueueRequest(download.file)
        }
        return
      }

      debug(`${peer.label} refused the transfer: ${reason || 'no reason'}`)
      download?.fail(new Error(reason || 'Transfer refused'))
      return
    }

    if (!download) {
      debug(`${peer.label} allowed the unknown transfer ${evt.token}`)
      return
    }

    if (!peer.peer.host || !peer.peer.port) {
      // nothing to connect to, and net.createConnection would throw on the missing port
      download.fail(new Error(`No address to reach ${peer.user}`))
      return
    }

    debug(`${peer.label} allowed the transfer, opening a file connection with PeerInit + ${evt.token}`)
    FilePeer.open({
      host: peer.peer.host,
      port: peer.peer.port,
      token: evt.token,
      user: peer.user,
      session: this.ctx.session,
      handshake: 'init',
      // introducing ourselves is enough, the uploader waits for our offset
      offsetDelay: 1000,
      transferTimeout: this.ctx.transferTimeout
    })
  }

  /** The peer told us where the file it is sending stands in its queue */
  queued (user: string, file: string, place: number): void {
    this.ctx.session.downloads.get(user, file)?.queued(place)
  }

  /** The transfer will not happen: the peer said so, or its connection did */
  fail (user: string, file: string, err: Error): void {
    const download = this.ctx.session.downloads.get(user, file)
    if (!download) {
      debug(`Cannot reject download for ${user} ${file}`)
      return
    }
    download.fail(err)
  }

  /** The server could not reach a peer we asked it to have connect to us */
  cannotConnect (token: string): void {
    const download = this.ctx.session.downloads.byTransferToken(token)
    if (download) download.fail(new Error(`Cannot connect to ${download.user}`))
  }
}

/**
 * true when a peer refused a transfer only to queue it: 'Queued' is what the protocol prescribes,
 * clients write it with or without a trailing dot. Every other reason is a refusal for good
 * ('Queue full', 'File not shared', 'Banned'...).
 */
function isQueuedReason (reason: string): boolean {
  return reason.trim().toLowerCase().startsWith('queued')
}

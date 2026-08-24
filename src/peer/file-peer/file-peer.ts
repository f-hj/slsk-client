import net from 'net'
import createDebug from 'debug'
import Peer, { type PeerOptions } from '../peer'
import dial from '../../utils/dial'
import fileMessages from './messages'
import createFileTransferHandler from './handler'
import type Download from '../../download/download'
import type Session from '../../session'
import type { PeerInfo } from '../../types'

const debug = createDebug('slsk:peer:file')

/** ms of silence on a file connection before it is considered dead */
const DEFAULT_TRANSFER_TIMEOUT = 60000

export interface FilePeerOptions extends PeerOptions {
  /**
   * How we introduce ourselves once the connection is up:
   * - `pierce` answers a connection the server asked the peer to open to us
   * - `init` introduces us on a connection we opened ourselves
   * - unset for a connection the peer opened to us, it already introduced itself
   */
  handshake?: 'pierce' | 'init'
  /**
   * true when the uploader announces the transfer with its 4 bytes token, which has to be read
   * before we answer with the file offset
   */
  readToken?: boolean
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
  /** ms to wait before sending the offset, used by the legacy PeerInit flow */
  offsetDelay?: number
  /**
   * ms of silence before the connection is dropped. A file connection either carries the
   * transfer or has nothing to say, so an idle one is a transfer that will not finish
   * (default: 60000).
   */
  transferTimeout?: number
}

export interface OpenFilePeerOptions {
  host: string
  port: number
  /** Transfer token, ours in the legacy flow, the peer's when the server relayed the connection */
  token: string
  user: string
  session: Session
  handshake: 'pierce' | 'init'
  readToken?: boolean
  offsetDelay?: number
  transferTimeout?: number
}

/**
 * A file connection (type F): one transfer, one connection. It carries the transfer token, the
 * offset the downloader wants and then the file itself, which its handler feeds to the
 * {@link Download} the token belongs to.
 */
export default class FilePeer extends Peer {
  /** Transfer token, known upfront or read from what the uploader announces */
  token?: string
  /** true when the uploader announces its token before the file */
  readonly readsToken: boolean
  private resolved?: Download
  private offsetSent = false

  constructor (socket: net.Socket, peer: PeerInfo, options: FilePeerOptions) {
    super(socket, peer, options)
    this.token = peer.token
    this.readsToken = options.readToken === true

    const onData = createFileTransferHandler(this)

    if (options.handshake) {
      this.conn.once('connect', () => {
        debug(`${this.label} file connection up, ${options.handshake}`)
        if (options.handshake === 'pierce') {
          this.sendPierceFw(this.token as string)
        } else {
          this.sendPeerInit('F', this.token as string)
        }

        if (this.readsToken) return
        // the uploader will not announce anything, it waits for our offset
        if (options.offsetDelay) {
          setTimeout(() => this.sendOffset(), options.offsetDelay)
        } else {
          this.sendOffset()
        }
      })
    }

    // a peer that stops sending mid file, or that opens a connection it then forgets about,
    // would otherwise hold the transfer forever: nothing else times a file connection out
    this.conn.setTimeout(options.transferTimeout ?? DEFAULT_TRANSFER_TIMEOUT, () => {
      debug(`${this.label} sent nothing for too long, dropping the file connection`)
      this.conn.destroy()
    })

    this.resolveDownload()
    this.conn.on('data', onData)

    if (options.initialData && options.initialData.length > 0) {
      onData(options.initialData)
    }

    this.conn.on('close', () => {
      debug(`${this.label} file connection closed`)
      const download = this.resolved
      if (!download) {
        // the uploader never announced a transfer on it: a connection it asked the server to
        // relay and then did not need, nothing was waiting for it
        debug(`${this.label} no transfer was announced on it (${this.token ?? 'no token'})`)
        return
      }
      if (download.isSettled) return

      // a peer that hangs up mid file must not look like a peer that sent everything
      if (download.size !== undefined && !download.isComplete) {
        download.interrupted()
        return
      }
      void download.end()
    })
  }

  /** Opens a file connection to a peer to download a file */
  static open (options: OpenFilePeerOptions): FilePeer {
    debug(`${options.user}[out:${options.port}] open file connection`)
    const conn = dial(options.host, options.port)

    const peer = new FilePeer(conn, {
      user: options.user,
      type: 'F',
      token: options.token
    }, {
      session: options.session,
      handshake: options.handshake,
      readToken: options.readToken,
      offsetDelay: options.offsetDelay,
      transferTimeout: options.transferTimeout
    })

    peer.ready.catch(() => {
      debug(`${options.user}[out:${options.port}] file connection never came up`)
      peer.download?.fail(new Error(`Cannot connect to ${options.user}`))
    })

    return peer
  }

  /** The download these bytes belong to, once the token is known */
  get download (): Download | undefined {
    return this.resolveDownload()
  }

  /** Finds the download the transfer token belongs to, and remembers it */
  resolveDownload (): Download | undefined {
    if (!this.resolved && this.token) {
      this.resolved = this.session.downloads.byTransferToken(this.token)
    }
    return this.resolved
  }

  /** Tells the uploader where to start, non zero to resume a partial file */
  sendOffset (): void {
    if (this.offsetSent) return
    if (this.conn.destroyed) {
      debug(`${this.label} closed before the offset could be sent`)
      return
    }
    this.offsetSent = true
    // everything received so far, so a transfer asked for again carries on where it stopped
    const offset = this.resolveDownload()?.receivedBytes ?? 0
    debug(`${this.label} send FileOffset ${offset}`)
    this.conn.write(fileMessages.offset(offset))
  }

  /** Closes the connection once everything has been received */
  end (): void {
    this.conn.end()
  }
}

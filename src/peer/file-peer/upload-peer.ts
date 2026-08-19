import net from 'net'
import createDebug from 'debug'
import Peer, { type PeerOptions } from '../peer'
import fileMessages, { OFFSET_SIZE } from './messages'
import type { Readable } from 'stream'
import type Upload from '../../upload/upload'
import type { PeerInfo } from '../../types'

const debug = createDebug('slsk:peer:upload')

/** ms of silence on a file connection before it is considered dead */
const DEFAULT_TRANSFER_TIMEOUT = 60000

export interface UploadPeerOptions extends PeerOptions {
  /** The transfer these bytes belong to */
  upload: Upload
  /**
   * `init` introduces us on a connection we opened to the peer, unset for the connection the
   * peer opened to us after the server relayed our ConnectToPeer.
   */
  handshake?: 'init'
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
  /** ms of silence before the connection is dropped (default: 60000) */
  transferTimeout?: number
}

export interface OpenUploadPeerOptions extends PeerOptions {
  host: string
  port: number
  upload: Upload
  transferTimeout?: number
}

/**
 * The uploading side of a file connection (type F): we announce the transfer with its token, the
 * downloader answers with the offset it wants, and the bytes of the file follow until the
 * downloader closes the connection or everything has been sent.
 */
export default class UploadPeer extends Peer {
  readonly upload: Upload

  /** Offset frame of the downloader, read before anything can be sent */
  private pending = Buffer.alloc(0)
  private offsetRead = false
  private stream?: Readable
  /** true once the connection came up: a socket that never did is not a failed transfer yet */
  private established = false

  constructor (socket: net.Socket, peer: PeerInfo, options: UploadPeerOptions) {
    super(socket, peer, options)
    this.upload = options.upload

    if (options.handshake === 'init') {
      this.conn.once('connect', () => {
        debug(`${this.label} file connection up`)
        this.established = true
        // PeerInit carries no transfer token, the FileTransferInit frame right after does
        this.sendPeerInit('F', '00000000')
        this.announceTransfer()
      })
    } else {
      // the peer pierced our firewall, the socket is already up
      this.established = true
      this.announceTransfer()
    }

    // a downloader that never sends its offset, or one that stops reading, would otherwise
    // hold the slot forever
    this.conn.setTimeout(options.transferTimeout ?? DEFAULT_TRANSFER_TIMEOUT, () => {
      debug(`${this.label} went silent, dropping the file connection`)
      this.fail(new Error(`${this.user} stopped reading ${this.upload.file}`))
    })

    this.conn.on('data', data => this.onData(data))
    if (options.initialData && options.initialData.length > 0) {
      this.onData(options.initialData)
    }

    this.conn.on('close', () => {
      debug(`file socket close ${this.label}`)
      this.stream?.destroy()
      if (this.upload.isSettled) return

      if (!this.established) {
        // a connection that never came up leaves the transfer alone: whoever opened it still has
        // the server-relayed route to try
        debug(`${this.user} could not be reached on this connection`)
        return
      }

      // the downloader closes the connection as soon as it holds everything it asked for
      if (this.upload.isComplete) {
        this.upload.complete()
        return
      }
      this.upload.fail(new Error(
        `Transfer to ${this.user} stopped at ${this.upload.sentBytes}/${this.upload.size} bytes`
      ))
    })
  }

  /**
   * Opens a file connection to the peer that is waiting for the file. Await `ready` to know
   * whether it came up: a peer that cannot be reached is the caller's business, it still has the
   * server-relayed route to try.
   */
  static open (options: OpenUploadPeerOptions): UploadPeer {
    debug(`open file connection to ${options.upload.user}`)
    const conn = net.createConnection({ host: options.host, port: options.port })

    return new UploadPeer(conn, {
      user: options.upload.user,
      type: 'F',
      host: options.host,
      port: options.port
    }, {
      session: options.session,
      upload: options.upload,
      handshake: 'init',
      transferTimeout: options.transferTimeout
    })
  }

  /** FileTransferInit: the token of the transfer, which is what the downloader matches it by */
  private announceTransfer (): void {
    const token = this.upload.token
    if (!token) {
      this.fail(new Error(`No transfer token for ${this.upload.file}`))
      return
    }
    debug(`${this.label} send FileTransferInit, token ${token}`)
    this.conn.write(fileMessages.token(token))
  }

  /** The only thing the downloader sends is the offset it wants to start at */
  private onData (data: Buffer): void {
    if (this.offsetRead) return

    this.pending = Buffer.concat([this.pending, data])
    if (this.pending.length < OFFSET_SIZE) return

    this.offsetRead = true
    const offset = fileMessages.parseOffset(this.pending)
    this.pending = Buffer.alloc(0)
    debug(`${this.label} recv FileOffset ${offset}`)

    if (offset > this.upload.size) {
      this.fail(new Error(`${this.user} asked for offset ${offset} of a ${this.upload.size} bytes file`))
      return
    }

    this.upload.started(offset)
    void this.sendFile(offset)
  }

  /** Reads the file from the provider and writes it out, at the pace the peer reads it */
  private async sendFile (offset: number): Promise<void> {
    if (offset === this.upload.size) {
      // nothing left to send, the peer already holds the file
      this.upload.complete()
      this.conn.end()
      return
    }

    let stream: Readable
    try {
      stream = await this.upload.provider.read(this.upload.entry, { start: offset })
    } catch (err) {
      this.fail(new Error(`Cannot read ${this.upload.file}: ${String(err)}`))
      return
    }

    if (this.conn.destroyed) {
      stream.destroy()
      return
    }
    this.stream = stream

    stream.on('data', (chunk: Buffer) => {
      this.upload.sent(chunk.length)
      // a downloader reading slower than the provider produces must not fill our memory
      if (!this.conn.write(chunk)) stream.pause()
    })
    this.conn.on('drain', () => stream.resume())

    stream.on('end', () => {
      debug(`${this.label} sent ${this.upload.sentBytes}/${this.upload.size} bytes`)
      this.upload.complete()
      // ending flushes what is still buffered, the downloader closes on its side as well
      this.conn.end()
    })

    stream.on('error', (err: Error) => {
      this.fail(new Error(`Cannot read ${this.upload.file}: ${err.message}`))
    })
  }

  /** Gives up on the transfer and closes the connection */
  private fail (err: Error): void {
    this.stream?.destroy()
    this.upload.fail(err)
    this.destroy()
  }
}

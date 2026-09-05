import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Messages from '../src/utils/messages'
import Message from '../src/utils/message'
import peerMessages from '../src/peer/messages'
import { parseUserInfo } from '../src/peer/default-peer/messages'
import type { ServerAddress, UserInfo } from '../src/types'

const debug = createDebug('slsk:mock:peer:download')

export interface MockDownloadPeerOptions {
  /** Where this peer accepts the file connection the client opens */
  address: ServerAddress
  /** Port the client listens on, where the peer connection is opened */
  clientListenPort: number
  /** Name of the mock peer */
  username: string
  /**
   * How a transfer the client announces is answered: `allow` it (default), `refuse` it, or
   * `ignore` it to play a peer that leaves the transfer hanging, keeping the slot busy.
   */
  answer?: 'allow' | 'refuse' | 'ignore'
  /** Reason sent when the transfer is refused (default: Cancelled) */
  refusal?: string
  /** First byte asked for on the file connection, non zero to resume (default: 0) */
  offset?: number
}

export interface MockDownloadPeerEvents {
  /** The client announced a transfer: TransferRequest direction 1 */
  'upload-request': [evt: { file: string, token: string, size: number }]
  /** The client refuses to send the file */
  'upload-denied': [evt: { file: string, reason: string }]
  /** The client gave up on a transfer it had announced */
  'upload-failed': [file: string]
  /** Where the client says the file stands in its queue */
  'place-in-queue': [evt: { file: string, place: number }]
  /** Everything received on a file connection, once the client closed it */
  file: [evt: { token: string, data: Buffer }]
  /** What the client tells about itself */
  'user-info': [info: UserInfo]
}

/**
 * Plays the downloading side of an upload: asks the client for a file, answers the transfer it
 * announces, then reads the bytes on the file connection, sending the offset it wants first.
 */
export default class MockDownloadPeer extends EventEmitter<MockDownloadPeerEvents> {
  private readonly server: net.Server
  private readonly options: MockDownloadPeerOptions
  private readonly sockets: net.Socket[] = []
  /** Peer connection (type P) opened to the client, where the requests are sent */
  private peerConnection?: net.Socket

  constructor (options: MockDownloadPeerOptions) {
    super()
    this.options = options

    this.server = net.createServer(c => this.handleFileConnection(c))
    this.server.on('error', (err: NodeJS.ErrnoException) => debug(`Error ${err.code}`))
    this.server.listen(options.address.port, options.address.host, () => {
      debug(`MockDownloadPeer bound on ${options.address.host}:${options.address.port}`)
    })
  }

  /** Opens the peer connection to the client and introduces itself */
  async connect (): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const conn = net.createConnection({
        host: '127.0.0.1',
        port: this.options.clientListenPort
      }, () => {
        conn.write(new Message()
          .int8(1) // PeerInit
          .str(this.options.username)
          .str('P')
          .rawHexStr('00000000')
          .getBuff())
        resolve()
      })
      conn.on('error', (err: NodeJS.ErrnoException) => {
        debug(`peer socket error ${err.code}`)
        reject(err)
      })

      this.sockets.push(conn)
      this.peerConnection = conn
      this.readPeerMessages(conn)
    })
  }

  /** QueueUpload (43): the modern way of asking for a file */
  queueUpload (file: string): void {
    debug(`send QueueUpload ${file}`)
    this.write(new Message().int32(43).str(file).getBuff())
  }

  /** TransferRequest (40) direction 0: the way clients asked before the queue existed */
  legacyRequest (file: string, token: string): void {
    debug(`send TransferRequest direction 0 ${file}`)
    this.write(new Message()
      .int32(40)
      .int32(0)
      .rawHexStr(token)
      .str(file)
      .getBuff())
  }

  /** PlaceInQueueRequest (51) */
  placeInQueueRequest (file: string): void {
    debug(`send PlaceInQueueRequest ${file}`)
    this.write(new Message().int32(51).str(file).getBuff())
  }

  /** UserInfoRequest (15): asks the client what it tells about itself */
  userInfoRequest (): void {
    debug('send UserInfoRequest')
    this.write(new Message().int32(15).getBuff())
  }

  /**
   * Answers a ConnectToPeer the server relayed for a file connection: connects to the client and
   * pierces its firewall, which is the route taken when the client has no address for us.
   */
  pierce (token: string): void {
    debug(`pierce the firewall of the client with ${token}`)
    const conn = net.createConnection({
      host: '127.0.0.1',
      port: this.options.clientListenPort
    }, () => {
      conn.write(new Message().int8(0).rawHexStr(token).getBuff())
    })
    conn.on('error', (err: NodeJS.ErrnoException) => debug(`pierced socket error ${err.code}`))
    this.sockets.push(conn)
    this.readFile(conn, Buffer.alloc(0))
  }

  /**
   * Opens the file connection ourselves instead of waiting for the client to, introducing it with
   * a PeerInit that carries the token of the transfer: what a downloader does when it accepted a
   * transfer and would rather not be dialled for it.
   */
  openFileConnection (token: string): void {
    debug(`open the file connection of ${token} to the client`)
    const conn = net.createConnection({
      host: '127.0.0.1',
      port: this.options.clientListenPort
    }, () => {
      conn.write(peerMessages.peerInit(this.options.username, 'F', token).getBuff())
    })
    conn.on('error', (err: NodeJS.ErrnoException) => debug(`file socket error ${err.code}`))
    this.sockets.push(conn)
    this.readFile(conn, Buffer.alloc(0))
  }

  destroy (): void {
    this.sockets.forEach(socket => socket.destroy())
    this.server.close()
  }

  private write (buffer: Buffer): void {
    if (!this.peerConnection) throw new Error('connect() first')
    this.peerConnection.write(buffer)
  }

  /** Reads what the client sends on the peer connection */
  private readPeerMessages (c: net.Socket): void {
    const msgs = new Messages()
    c.on('data', data => msgs.write(data))

    msgs.on('message', (msg: Message) => {
      const size = msg.int32()
      if (size < 4) return
      const code = msg.int32()

      switch (code) {
        case 40: {
          const direction = msg.int32()
          const token = msg.rawHexStr(4)
          const file = msg.str()
          const fileSize = msg.int64()
          debug(`recv TransferRequest direction ${direction} ${file} ${fileSize} bytes`)
          if (direction !== 1) return
          this.emit('upload-request', { file, token, size: fileSize })

          if (this.options.answer === 'ignore') {
            debug('leaving the transfer unanswered')
            return
          }

          if (this.options.answer === 'refuse') {
            c.write(new Message()
              .int32(41)
              .rawHexStr(token)
              .int8(0)
              .str(this.options.refusal ?? 'Cancelled')
              .getBuff())
            return
          }

          c.write(new Message()
            .int32(41)
            .rawHexStr(token)
            .int8(1)
            .getBuff())
          break
        }
        case 41: {
          const token = msg.rawHexStr(4)
          const allowed = msg.int8()
          const reason = allowed === 1 ? undefined : msg.str()
          debug(`recv TransferResponse ${token} allowed ${allowed} ${reason ?? ''}`)
          break
        }
        case 16: {
          const info = parseUserInfo(msg, 'client')
          debug(`recv UserInfoResponse, ${info.uploadSlots} slots`)
          this.emit('user-info', info)
          break
        }
        case 44: {
          const file = msg.str()
          const place = msg.int32()
          debug(`recv PlaceInQueueResponse ${file} at ${place}`)
          this.emit('place-in-queue', { file, place })
          break
        }
        case 46: {
          const file = msg.str()
          debug(`recv UploadFailed ${file}`)
          this.emit('upload-failed', file)
          break
        }
        case 50: {
          const file = msg.str()
          const reason = msg.str()
          debug(`recv UploadDenied ${file}: ${reason}`)
          this.emit('upload-denied', { file, reason })
          break
        }
        default: {
          debug(`unknown peer message code ${code}`)
        }
      }
    })
  }

  /** The client opened a file connection: read its PeerInit, then the transfer itself */
  private handleFileConnection (c: net.Socket): void {
    this.sockets.push(c)
    c.on('error', (err: NodeJS.ErrnoException) => debug(`file socket error ${err.code}`))

    let buf = Buffer.alloc(0)
    const onInit = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const size = buf.readUInt32LE(0)
      if (buf.length < size + 4) return

      const msg = new Message(buf.subarray(0, size + 4))
      const rest = buf.subarray(size + 4)
      msg.int32() // size
      const code = msg.int8()
      if (code === 1) {
        const user = msg.str()
        const type = msg.str()
        debug(`recv PeerInit from ${user} type ${type}`)
      } else {
        debug(`recv peer init code ${code}`)
      }

      c.removeListener('data', onInit)
      this.readFile(c, rest)
    }

    c.on('data', onInit)
  }

  /** Reads the transfer token, answers with the offset, then collects the file */
  private readFile (c: net.Socket, initial: Buffer): void {
    let buf = initial
    let token: string | undefined
    let data = Buffer.alloc(0)

    const onData = (chunk: Buffer): void => {
      if (!token) {
        buf = Buffer.concat([buf, chunk])
        if (buf.length < 4) return
        token = buf.toString('hex', 0, 4)
        debug(`recv FileTransferInit, token ${token}`)

        const offset = Buffer.alloc(8)
        offset.writeBigUInt64LE(BigInt(this.options.offset ?? 0), 0)
        c.write(offset)

        data = Buffer.concat([data, buf.subarray(4)])
        return
      }

      data = Buffer.concat([data, chunk])
    }

    c.on('data', onData)
    // the uploader closes once it has sent everything
    c.on('end', () => {
      debug(`file connection ended, ${data.length} bytes received`)
      this.emit('file', { token: token ?? '', data })
    })

    if (initial.length > 0) {
      buf = Buffer.alloc(0)
      onData(initial)
    }
  }
}

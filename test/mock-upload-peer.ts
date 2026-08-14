import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Messages from '../src/messages'
import Message from '../src/message'
import type { ServerAddress } from '../src/types'

const debug = createDebug('slsk:mock:peer:upload:i')

export interface MockUploadPeerOptions {
  /** Where the mock peer accepts connections */
  address: ServerAddress
  /** Port the client listens on, used to open the file connection ourselves */
  clientListenPort: number
  /** Name of the file the mock peer uploads */
  file: string
  /** Content of the file */
  data: Buffer
  /** Name of the mock peer */
  username: string
  /** Place in queue answered to PlaceInQueueRequest (default: 2) */
  place?: number
}

export interface MockUploadPeerEvents {
  'queue-upload': [file: string]
  'place-in-queue-request': [file: string]
  /** Legacy download request (TransferRequest direction 0) */
  'transfer-request': [evt: { file: string, token: string }]
  'transfer-response': [evt: { token: string, allowed: number }]
  /** File offset asked by the client, non zero when it resumes a download */
  offset: [offset: number]
}

/**
 * Plays the uploader side of a download: answers the queue messages, announces the transfer
 * and sends the file data on a file connection, honouring the offset sent by the client.
 */
export default class MockUploadPeer extends EventEmitter<MockUploadPeerEvents> {
  private readonly server: net.Server
  private readonly options: MockUploadPeerOptions
  private readonly sockets: net.Socket[] = []

  constructor (options: MockUploadPeerOptions) {
    super()
    this.options = options

    this.server = net.createServer(c => this.handleConnection(c))
    this.server.on('error', (err: NodeJS.ErrnoException) => debug(`Error ${err.code}`))
    this.server.listen(options.address.port, options.address.host, () => {
      debug(`MockUploadPeer bound on ${options.address.host}:${options.address.port}`)
    })
  }

  private handleConnection (c: net.Socket): void {
    this.sockets.push(c)
    c.on('error', (err: NodeJS.ErrnoException) => debug(`socket error ${err.code}`))

    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return
      const size = buf.readUInt32LE(0)
      if (buf.length < size + 4) return

      const msg = new Message(buf.subarray(0, size + 4))
      const rest = buf.subarray(size + 4)
      msg.int32() // size
      const code = msg.int8()

      c.removeListener('data', onData)

      if (code === 1) {
        const user = msg.str()
        const type = msg.str()
        debug(`recv PeerInit from ${user} type ${type}`)
        if (type === 'F') {
          // the client connected to download, it sends the offset then we send the data
          this.handleFileConnection(c, rest)
          return
        }
      } else {
        debug(`recv peer init code ${code}`)
      }

      this.handlePeerConnection(c, rest)
    }

    c.on('data', onData)
  }

  /** Peer connection (type P): download requests and queue messages */
  private handlePeerConnection (c: net.Socket, rest: Buffer): void {
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
          debug(`recv TransferRequest direction ${direction} ${file}`)
          if (direction !== 0) return
          this.emit('transfer-request', { file, token })
          // legacy flow: allow it right away, the client opens the file connection
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
          debug(`recv TransferResponse ${token} allowed ${allowed}`)
          this.emit('transfer-response', { token, allowed })
          if (allowed === 1) this.uploadTo(token)
          break
        }
        case 43: {
          const file = msg.str()
          debug(`recv QueueUpload ${file}`)
          this.emit('queue-upload', file)
          this.announceTransfer(c)
          break
        }
        case 51: {
          const file = msg.str()
          debug(`recv PlaceInQueueRequest ${file}`)
          this.emit('place-in-queue-request', file)
          c.write(new Message()
            .int32(44)
            .str(file)
            .int32(this.options.place ?? 2)
            .getBuff())
          break
        }
        default: {
          debug(`unknown peer message code ${code}`)
        }
      }
    })

    if (rest.length > 0) msgs.write(rest)
  }

  /** Tells the client the upload is starting, as a real peer does once the file is dequeued */
  private announceTransfer (c: net.Socket): void {
    setTimeout(() => {
      if (c.destroyed) return
      debug('send TransferRequest direction 1')
      c.write(new Message()
        .int32(40)
        .int32(1) // direction: we upload
        .rawHexStr('cafed00d')
        .str(this.options.file)
        .int64(this.options.data.length)
        .getBuff())
    }, 20)
  }

  /** Opens a file connection to the client and sends the data from the offset it asks for */
  private uploadTo (token: string): void {
    const conn = net.createConnection({
      host: '127.0.0.1',
      port: this.options.clientListenPort
    }, () => {
      this.sockets.push(conn)
      conn.write(new Message()
        .int8(1)
        .str(this.options.username)
        .str('F')
        .rawHexStr(token)
        .getBuff())
      // the uploader announces the transfer with its raw token
      conn.write(Buffer.from(token, 'hex'))
    })

    conn.on('error', (err: NodeJS.ErrnoException) => debug(`upload socket error ${err.code}`))
    this.waitForOffset(conn)
  }

  /** Reads the 8 bytes offset then sends the file data */
  private waitForOffset (conn: net.Socket): void {
    let buf = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 8) return
      conn.removeListener('data', onData)
      const offset = Number(buf.readBigUInt64LE(0))
      debug(`recv offset ${offset}`)
      this.emit('offset', offset)
      conn.write(this.options.data.subarray(offset))
    }
    conn.on('data', onData)
  }

  /** File connection the client opened itself (legacy flow) */
  private handleFileConnection (c: net.Socket, rest: Buffer): void {
    this.waitForOffset(c)
    if (rest.length > 0) c.emit('data', rest)
  }

  destroy (): void {
    this.sockets.forEach(socket => socket.destroy())
    this.server.close()
  }
}

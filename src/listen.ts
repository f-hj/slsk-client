import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Message from './utils/message'
import type { PeerInfo } from './types'

const debug = createDebug('slsk:listen:i')

export interface NewPeerEvent {
  socket: net.Socket
  peer: PeerInfo
  /** Bytes received after the peer init message, must be handed to the peer parser */
  initialData?: Buffer
}

export interface FileTransferEvent {
  socket: net.Socket
  user: string
  token: string
  /** Bytes received after the peer init message, the beginning of the transfer */
  initialData?: Buffer
}

export interface PierceFirewallEvent {
  socket: net.Socket
  token: string
  /** Bytes received after the pierce firewall message */
  initialData?: Buffer
}

export interface ListenEvents {
  'new-peer': [evt: NewPeerEvent]
  /** An upload is starting on a connection the peer opened directly (peer init of type F) */
  'file-transfer': [evt: FileTransferEvent]
  /** Answer of a peer we asked the server to connect to us */
  'pierce-firewall': [evt: PierceFirewallEvent]
  'socket-error': [err: Error]
}

export default class Listen extends EventEmitter<ListenEvents> {
  private server: net.Server

  constructor (readonly port: number) {
    super()

    this.server = net.createServer(c => this.handleConnection(c))

    this.server.on('error', err => {
      debug(`Listen Server Error ${err}`)
      this.emit('socket-error', err)
    })

    this.server.listen(this.port, '0.0.0.0', () => {
      debug(`Listen peer connections on port ${this.port}`)
    })
  }

  /**
   * The first message of an incoming connection tells what the connection is for, the rest of
   * the bytes belong to the peer or to the file transfer: they are parsed by hand so nothing
   * is swallowed by a framing parser before the connection is handed over.
   */
  private handleConnection (c: net.Socket): void {
    let buf = Buffer.alloc(0)

    const onError = (err: NodeJS.ErrnoException): void => {
      debug(`listen connection error ${err.code}`)
      this.emit('socket-error', err)
    }

    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (buf.length < 4) return

      const size = buf.readUInt32LE(0)
      if (size < 1 || buf.length < size + 4) return

      const msg = new Message(buf.subarray(0, size + 4))
      const initialData = buf.subarray(size + 4)
      msg.int32() // size

      const handedOver = this.handleInit(c, msg, initialData.length > 0 ? initialData : undefined)
      if (!handedOver) {
        buf = Buffer.alloc(0)
        return
      }

      c.pause()
      c.removeListener('data', onData)
      c.removeListener('error', onError)
      c.resume()
    }

    c.on('data', onData)
    c.on('error', onError)

    c.on('end', () => {
      debug('client disconnected')
    })
  }

  /** Returns true when the socket has been handed over to a peer or a file transfer */
  private handleInit (c: net.Socket, msg: Message, initialData?: Buffer): boolean {
    const code = msg.int8()
    switch (code) {
      case 0: {
        const token = msg.rawHexStr(4)
        debug(`recv Pierce Firewall, token: ${token}`)
        this.emit('pierce-firewall', { socket: c, token, initialData })
        return true
      }
      case 1: {
        const user = msg.str()
        const type = msg.str()
        const token = msg.remaining() >= 4 ? msg.rawHexStr(4) : '00000000'
        debug(`peerInit ${user}, type ${type}, token ${token}`)

        if (type === 'F') {
          // a peer is about to send us a file it queued for upload
          this.emit('file-transfer', { socket: c, user, token, initialData })
          return true
        }

        this.emit('new-peer', {
          socket: c,
          peer: { user, type, token },
          initialData
        })
        return true
      }
      default: {
        debug(`unattended case, peer init code ${code}`)
        return false
      }
    }
  }

  destroy (): void {
    if (this.server) this.server.close(() => debug('Listen peer connections server closed'))
  }
}

import EventEmitter from 'events'
import type net from 'net'
import createDebug from 'debug'
import peerMessages from './messages'
import { INIT_MESSAGES, nameOf } from '../utils/message-names'
import type Message from '../utils/message'
import type Session from '../session'
import type { PeerInfo } from '../types'

const debug = createDebug('slsk:peer:i')

export type PeerEvents = {
  disconnect: [evt: object]
  /** Socket level error, always followed by a disconnect */
  'socket-error': [err: Error]
}

export interface PeerOptions {
  /** State of the client this peer belongs to */
  session: Session
}

/**
 * A connection to a peer, whatever its type: the socket, the handshake and the plumbing every
 * peer type shares. What travels on the connection is the business of the subclasses.
 */
export default class Peer<Events extends Record<string, any[]> = Record<never, never>> extends EventEmitter<PeerEvents & Events> {
  protected conn: net.Socket
  protected readonly session: Session
  readonly peer: PeerInfo
  /**
   * Resolves once the connection is usable, rejects when it could not be established.
   * Already resolved for connections a peer opened to us.
   */
  readonly ready: Promise<void>
  /**
   * true when the peer opened this connection to our listening port, false when we dialled it.
   * A socket handed over by the listening server is already connected, one we just asked for
   * is still connecting, which is the only thing telling the two apart.
   */
  readonly incoming: boolean
  /** Port of the connection, kept for the log lines the socket outlives */
  private loggedPort?: number

  constructor (socket: net.Socket, peer: PeerInfo, options: PeerOptions) {
    super()
    this.conn = socket
    this.peer = peer
    this.session = options.session
    this.incoming = !socket.connecting

    this.ready = socket.connecting
      ? new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', (err: Error) => reject(err))
      })
      : Promise.resolve()
    // nobody has to await ready, the disconnect event is enough for most callers
    this.ready.catch(() => {})

    this.conn.on('error', (error: NodeJS.ErrnoException) => {
      debug(`${this.label} error ${error.code}`)
      this.base.emit('socket-error', error)
      this.emitDisconnect()
    })

    this.conn.on('end', () => {
      debug(`${this.label} connection ended`)
      this.emitDisconnect()
    })
  }

  /** Name of the peer on the other end */
  get user (): string {
    return this.peer.user
  }

  /**
   * How a connection is named in the logs: the peer, and which side opened it on which port.
   * `alice[in:2234]` reached our listening port, `alice[out:49271]` is a connection we opened
   * to the address the server gave us. Two peers can hold both at once.
   */
  get label (): string {
    // a closed socket has no port anymore, and the last lines of a connection are the ones
    // worth reading, so it is remembered as soon as it is known
    const port = this.incoming ? this.conn.localPort : this.conn.remotePort
    if (port !== undefined) this.loggedPort = port

    const known = this.loggedPort ?? this.peer.port
    return `${this.peer.user}[${this.incoming ? 'in' : 'out'}:${known ?? '?'}]`
  }

  // the cast narrows the emitter to the base events, which every subclass map includes
  private get base (): EventEmitter<PeerEvents> {
    return this as unknown as EventEmitter<PeerEvents>
  }

  private emitDisconnect (): void {
    this.base.emit('disconnect', {})
  }

  /** Sends a message on the connection, its size prefix included */
  send (msg: Message, detail?: string): void {
    this.logSent(msg, detail)
    this.conn.write(msg.getBuff())
  }

  /**
   * Names what is being sent, so every connection logs its traffic. Subclasses override it with
   * the table of the messages they carry: only the init messages are shared by every type.
   */
  protected logSent (msg: Message, detail?: string): void {
    debug(`${this.label} send ${msg.data.length} bytes${detail ? `: ${detail}` : ''}`)
  }

  /** Sends an init message, whose code is a single byte, unlike the rest of a connection */
  private sendInit (msg: Message): void {
    debug(`${this.label} send ${nameOf(INIT_MESSAGES, msg.data.readUInt8(0))}, ${msg.data.length} bytes`)
    this.conn.write(msg.getBuff())
  }

  /** PierceFireWall (0): answers a connection the server asked this peer to open */
  protected sendPierceFw (token: string): void {
    this.sendInit(peerMessages.pierceFw(token))
  }

  /** PeerInit (1): introduces us on a connection we opened ourselves */
  protected sendPeerInit (type: string, token: string): void {
    this.sendInit(peerMessages.peerInit(this.session.username, type, token))
  }

  setAddress (host: string, port: number): void {
    debug(`setAddress for ${this.label}: ${host} ${port}`)
    this.peer.host = host
    this.peer.port = port
  }

  destroy (): void {
    this.conn.destroy()
  }
}

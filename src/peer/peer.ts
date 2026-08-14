import EventEmitter from 'events'
import type net from 'net'
import createDebug from 'debug'
import MessageFactory, { type FileSearchResultOptions } from '../message-factory'
import type Message from '../message'
import type { PeerInfo, SharedFileEntry } from '../types'

const debug = createDebug('slsk:peer:i')

export type PeerEvents = {
  disconnect: [evt: object]
  /** Socket level error, always followed by a disconnect */
  'socket-error': [err: Error]
}

export default class Peer<Events extends Record<string, any[]> = Record<never, never>> extends EventEmitter<PeerEvents & Events> {
  protected conn: net.Socket
  readonly peer: PeerInfo
  /**
   * Resolves once the connection is usable, rejects when it could not be established.
   * Already resolved for connections a peer opened to us.
   */
  readonly ready: Promise<void>

  constructor (socket: net.Socket, peer: PeerInfo) {
    super()
    this.conn = socket
    this.peer = peer

    this.ready = socket.connecting
      ? new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', (err: Error) => reject(err))
      })
      : Promise.resolve()
    // nobody has to await ready, the disconnect event is enough for most callers
    this.ready.catch(() => {})

    this.conn.on('error', (error: NodeJS.ErrnoException) => {
      debug(`${peer.user} error ${error.code}`)
      this.base.emit('socket-error', error)
      this.emitDisconnect()
    })

    this.conn.on('end', () => {
      debug(`${peer.user} connection ended`)
      this.emitDisconnect()
    })
  }

  // the cast narrows the emitter to the base events, which every subclass map includes
  private get base (): EventEmitter<PeerEvents> {
    return this as unknown as EventEmitter<PeerEvents>
  }

  private emitDisconnect (): void {
    this.base.emit('disconnect', {})
  }

  protected write (msg: Message): void {
    this.conn.write(msg.getBuff())
  }

  /** TransferRequest (40) direction 0: legacy way of asking for a download */
  transferRequest (file: string, token: string): void {
    debug(`Transfer request ${file}`)
    this.write(MessageFactory.to.peer.transferRequest(file, token))
  }

  /** QueueUpload (43): asks the peer to queue a file for upload to us */
  queueUpload (file: string): void {
    debug(`Queue upload ${file}`)
    this.write(MessageFactory.to.peer.queueUpload(file))
  }

  /** PlaceInQueueRequest (51): asks our position in the upload queue of the peer */
  placeInQueueRequest (file: string): void {
    debug(`Place in queue request ${file}`)
    this.write(MessageFactory.to.peer.placeInQueueRequest(file))
  }

  setAddress (host: string, port: number): void {
    debug(`setAddress for ${this.peer.user}: ${host} ${port}`)
    this.peer.host = host
    this.peer.port = port
  }

  fileSearchResult (
    files: SharedFileEntry[],
    token: string,
    user: string,
    options?: FileSearchResultOptions
  ): void {
    debug(`send FileSearchResult to user ${this.peer.user} with token ${token}`)
    this.write(MessageFactory.to.peer.fileSearchResult(files, token, user, options))
  }

  destroy (): void {
    this.conn.destroy()
  }
}

import type net from 'net'
import createDebug from 'debug'
import Peer from './peer'
import Messages from '../messages'
import Message from '../message'
import MessageFactory from '../message-factory'
import stack from '../stack'
import type { PeerInfo, PeerSearchRequest } from '../types'

const debug = createDebug('slsk:peer:distributed:i')

export type DistributedPeerEvents = {
  search: [search: PeerSearchRequest]
  /** Distance of this parent to the root of the distributed network */
  'branch-level': [level: number]
  /** User name of the root of the branch this parent belongs to */
  'branch-root': [root: string]
}

export interface DistributedPeerOptions {
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
}

export default class DistributedPeer extends Peer<DistributedPeerEvents> {
  constructor (socket: net.Socket, peer: PeerInfo, options: DistributedPeerOptions = {}) {
    super(socket, peer)

    this.conn.on('connect', () => {
      if (peer.token) {
        this.conn.write(MessageFactory
          .to.peer
          .peerInit(peer.user, peer.type as string, peer.token)
          .getBuff())
        const buf = Buffer.from('05000000' + '00' + peer.token, 'hex')
        this.conn.write(buf)
      }
    })

    const msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', (msg: Message) => this.handleMessage(msg))

    if (options.initialData && options.initialData.length > 0) {
      msgs.write(options.initialData)
    }
  }

  private handleMessage (msg: Message): void {
    const size = msg.int32()
    if (size <= 4) return

    this.handleCode(msg.int8(), msg)
  }

  private handleCode (code: number, msg: Message): void {
    const peer = this.peer

    switch (code) {
      case 0: {
        debug(`${peer.user} DistribPing`)
        break
      }
      case 3: {
        this.handleSearchRequest(msg)
        break
      }
      case 4: {
        const branchLevel = msg.int32()
        debug(`${peer.user} Branch Level ${branchLevel}`)
        this.emit('branch-level', branchLevel)
        break
      }
      case 5: {
        const branchRoot = msg.str()
        debug(`${peer.user} Branch Root ${branchRoot}`)
        this.emit('branch-root', branchRoot)
        break
      }
      case 93: {
        // the server sends searches this way when it acts as our branch root
        const embedded = msg.int8()
        debug(`${peer.user} DistribEmbeddedMessage, embedded code ${embedded}`)
        if (embedded === 3) {
          this.handleSearchRequest(msg)
        }
        break
      }
      default: {
        debug(`${peer.user} unknown distributed message code ${code}`)
      }
    }
  }

  private handleSearchRequest (msg: Message): void {
    const peer = this.peer
    msg.int32() // unknown field
    const user = msg.str()
    const ticket = msg.readRawHexStr(4)
    const query = msg.str()
    const searchKey = `${user}_${ticket}_${query}`
    if (stack.peerSearchRequests.includes(searchKey)) return

    stack.peerSearchRequests.push(searchKey)
    debug(`${peer.user} Search Request from ${user}, ticket ${ticket}. query: ${query}`)
    this.emit('search', { user, ticket, query } satisfies PeerSearchRequest)
  }
}

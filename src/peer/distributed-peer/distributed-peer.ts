import type net from 'net'
import Peer, { type PeerOptions } from '../peer'
import Messages from '../../utils/messages'
import handleDistributedPeerMessage from './handler'
import type Message from '../../utils/message'
import type { PeerInfo, PeerSearchRequest } from '../../types'

export type DistributedPeerEvents = {
  search: [search: PeerSearchRequest]
  /** Distance of this parent to the root of the distributed network */
  'branch-level': [level: number]
  /** User name of the root of the branch this parent belongs to */
  'branch-root': [root: string]
}

export interface DistributedPeerOptions extends PeerOptions {
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
}

/**
 * A distributed parent (type D): it forwards us the searches travelling on the network.
 * Nothing is sent on this connection beyond the init message.
 */
export default class DistributedPeer extends Peer<DistributedPeerEvents> {
  constructor (socket: net.Socket, peer: PeerInfo, options: DistributedPeerOptions) {
    super(socket, peer, options)

    this.conn.on('connect', () => {
      if (peer.token) {
        this.sendPeerInit(peer.type as string, peer.token)
        this.sendPierceFw(peer.token)
      }
    })

    const msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', (msg: Message) => handleDistributedPeerMessage(msg, this))

    if (options.initialData && options.initialData.length > 0) {
      msgs.write(options.initialData)
    }
  }
}

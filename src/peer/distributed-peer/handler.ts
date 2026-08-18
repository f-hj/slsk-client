import createDebug from 'debug'
import type Message from '../../utils/message'
import type DistributedPeer from './distributed-peer'
import type { PeerSearchRequest } from '../../types'

const debug = createDebug('slsk:peer:distributed:i')

/**
 * Handles a message received from a distributed parent (type D). Their code is a single byte,
 * and everything they carry is reported to the client: searches to answer, and where the
 * parent sits in the distributed network.
 */
export default function handleDistributedPeerMessage (msg: Message, peer: DistributedPeer): void {
  const size = msg.int32()
  if (size <= 4) return

  handleCode(msg.int8(), msg, peer)
}

function handleCode (code: number, msg: Message, peer: DistributedPeer): void {
  const user = peer.user

  switch (code) {
    case 0: {
      debug(`${user} DistribPing`)
      break
    }
    case 3: {
      handleSearchRequest(msg, peer)
      break
    }
    case 4: {
      const branchLevel = msg.int32()
      debug(`${user} Branch Level ${branchLevel}`)
      peer.emit('branch-level', branchLevel)
      break
    }
    case 5: {
      const branchRoot = msg.str()
      debug(`${user} Branch Root ${branchRoot}`)
      peer.emit('branch-root', branchRoot)
      break
    }
    case 93: {
      // the server sends searches this way when it acts as our branch root
      const embedded = msg.int8()
      debug(`${user} DistribEmbeddedMessage, embedded code ${embedded}`)
      if (embedded === 3) {
        handleSearchRequest(msg, peer)
      }
      break
    }
    default: {
      debug(`${user} unknown distributed message code ${code}`)
    }
  }
}

function handleSearchRequest (msg: Message, peer: DistributedPeer): void {
  msg.int32() // unknown field
  const user = msg.str()
  const ticket = msg.readRawHexStr(4)
  const query = msg.str()
  // the same request reaches us from several parents, the client drops the duplicates
  peer.emit('search', { user, ticket, query } satisfies PeerSearchRequest)
}

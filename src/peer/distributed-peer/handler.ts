import createDebug from 'debug'
import { DISTRIBUTED_MESSAGES, nameOf } from '../../utils/message-names'
import type Message from '../../utils/message'
import type DistributedPeer from './distributed-peer'
import type { PeerSearchRequest } from '../../types'

const debug = createDebug('slsk:peer:distributed:recv')

/**
 * Handles a message received from a distributed parent (type D). Their code is a single byte,
 * and everything they carry is reported to the client: searches to answer, and where the
 * parent sits in the distributed network.
 */
export default function handleDistributedPeerMessage (msg: Message, peer: DistributedPeer): void {
  const size = msg.int32()
  if (size <= 4) return

  const code = msg.int8()
  // every search of the whole network travels through here, several times a second: logging
  // them one by one buries everything else, so only what is not a search is named
  if (!isSearch(code)) {
    debug(`${peer.label} recv ${nameOf(DISTRIBUTED_MESSAGES, code)}, ${size} bytes`)
  }

  try {
    handleCode(code, msg, peer)
  } catch (err) {
    // a message that does not match its documented layout, or one truncated on the wire: it
    // must not take the connection, and the process with it, down
    debug(`${peer.label} cannot read ${nameOf(DISTRIBUTED_MESSAGES, code)}: ${String(err)}`)
  }
}

/** true for the messages carrying a search, directly or embedded by our branch root */
function isSearch (code: number): boolean {
  return code === 3 || code === 93
}

function handleCode (code: number, msg: Message, peer: DistributedPeer): void {
  // which connection carried it, the parent name alone does not say
  const from = peer.label

  switch (code) {
    case 0: {
      // DistribPing, named by the line above, nothing to answer
      break
    }
    case 3: {
      handleSearchRequest(msg, peer)
      break
    }
    case 4: {
      const branchLevel = msg.int32()
      debug(`${from} Branch Level ${branchLevel}`)
      peer.emit('branch-level', branchLevel)
      break
    }
    case 5: {
      const branchRoot = msg.str()
      debug(`${from} Branch Root ${branchRoot}`)
      peer.emit('branch-root', branchRoot)
      break
    }
    case 93: {
      // the server sends searches this way when it acts as our branch root
      const embedded = msg.int8()
      if (embedded === 3) {
        handleSearchRequest(msg, peer)
        break
      }
      // anything else embedded is unexpected and rare enough to be worth a line
      debug(`${from} recv ${nameOf(DISTRIBUTED_MESSAGES, code)} wrapping code ${embedded}`)
      break
    }
    default: {
      debug(`${from} nothing is done with ${nameOf(DISTRIBUTED_MESSAGES, code)}`)
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

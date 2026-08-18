import crypto from 'crypto'
import createDebug from 'debug'
import { SERVER_MESSAGES, nameOf } from '../utils/message-names'
import type Message from '../utils/message'
import type Server from './server'
import type { PeerInfo } from '../types'

const debug = createDebug('slsk:server:i')

/**
 * Handles a message received from the slsk server: answers what the protocol expects right
 * away (the session bootstrap after a login, the parent address after a NetInfo) and reports
 * the rest as events of the server connection.
 */
export default function handleServerMessage (msg: Message, server: Server): void {
  const size = msg.int32()
  if (size < 4) return

  const code = msg.int32()
  debug(`recv ${nameOf(SERVER_MESSAGES, code)}, ${size} bytes`)

  switch (code) {
    case 1: {
      const success = msg.int8()
      if (success === 1) {
        const greet = msg.str()
        debug(`logged in: ${greet}`)
        // the server drops everything sent before a successful login, announce again
        server.onLoggedIn()
        server.emit('login', { success: true, greet })
      } else {
        const reason = msg.str()
        debug(`login refused: ${reason}`)
        server.emit('login', { success: false, reason })
      }
      break
    }
    case 3: {
      const user = msg.str()
      const { host } = readAddress(msg)
      const port = msg.int32()
      server.emit('get-peer-address', { user, host, port } satisfies PeerInfo)
      break
    }
    case 7: {
      const user = msg.str()
      const status = msg.int32()
      const privileged = msg.remaining() >= 1 ? msg.int8() : 0
      debug(`${user} is ${status}, privileged: ${privileged}`)
      break
    }
    case 18: {
      const user = msg.str()
      const type = msg.str()
      const { ip, host } = readAddress(msg)
      const port = msg.int32()
      const token = msg.readRawHexStr(4)
      server.emit('connect-to-peer', { user, type, ip, host, port, token } satisfies PeerInfo)
      break
    }
    case 36: {
      const user = msg.str()
      const avgSpeed = msg.int32()
      const downloadNum = msg.int32()
      const something = msg.int32()
      const files = msg.int32()
      const folders = msg.int32()
      debug(`${user}: avgSpeed ${avgSpeed}, files ${files}, folders ${folders}. downloadNum ${downloadNum}. something... ${something}`)
      break
    }
    case 64: {
      const nbRooms = msg.int32()
      const rooms: Array<{ name: string, users?: number }> = []
      for (let i = 0; i < nbRooms; i++) {
        rooms.push({
          name: msg.str()
        })
      }
      // the number of rooms is repeated before the user counts
      const nbUserCounts = msg.remaining() >= 4 ? msg.int32() : 0
      for (let i = 0; i < nbUserCounts && i < nbRooms; i++) {
        rooms[i].users = msg.int32()
      }
      break
    }
    case 69: {
      const number = msg.int32()
      debug(`${number} privileged users`)
      break
    }
    case 83: {
      const number = msg.int32()
      debug(`min speed ${number}`)
      break
    }
    case 84: {
      const number = msg.int32()
      debug(`speed ratio ${number}`)
      break
    }
    case 102: {
      const numberOfParents = msg.int32()
      debug(`${numberOfParents} possible parents`)
      for (let i = 0; i < numberOfParents; i++) {
        const user = msg.str()
        const { ip, host } = readAddress(msg)
        const port = msg.int32()
        debug(`Parent ${user} ${host} ${port}`)
        server.parentIp(ip)
        server.emit('connect-to-peer', {
          user,
          type: 'D',
          ip,
          host,
          port,
          token: crypto.randomBytes(4).toString('hex')
        } satisfies PeerInfo)
      }
      break
    }
    case 104: {
      const number = msg.int32()
      debug(`interval ${number}`)
      break
    }
    case 160: {
      // phrases the search network does not allow: our answers should leave them out
      const number = msg.int32()
      const phrases: string[] = []
      for (let i = 0; i < number && msg.remaining() >= 4; i++) {
        phrases.push(msg.str())
      }
      debug(`${phrases.length} of ${number}: ${phrases.join(', ')}`)
      break
    }
    case 1001: {
      const token = msg.readRawHexStr(4)
      debug(`the server could not reach the peer of token ${token}`)
      server.emit('cant-connect-to-peer', { token })
      break
    }
    default: {
      debug(`nothing is done with ${nameOf(SERVER_MESSAGES, code)}`)
    }
  }
}

/** Reads the 4 address bytes, which the server sends in reverse order */
function readAddress (msg: Message): { ip: number[], host: string } {
  const ip: number[] = []
  for (let i = 0; i < 4; i++) {
    ip.push(msg.int8())
  }
  return { ip, host: ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0] }
}

import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Messages from '../src/utils/messages'
import Message from '../src/utils/message'
import type { ServerAddress } from '../src/types'

const debug = createDebug('slsk:mock:peer:distributed:i')

export interface PeerInitEvent {
  client: net.Socket
  token: string
}

export interface MockDistributedPeerEvents {
  'peer-init': [evt: PeerInitEvent]
}

export default class MockDistributedPeer extends EventEmitter<MockDistributedPeerEvents> {
  private server: net.Server

  constructor (address: ServerAddress) {
    super()

    this.server = net.createServer(client => {
      debug('Peer connected')
      const msgs = new Messages()

      client.on('data', data => {
        msgs.write(data)
      })

      msgs.on('message', (msg: Message) => {
        const size = msg.int32()
        if (size < 4) return
        const code = msg.int8()
        switch (code) {
          case 1: {
            const user = msg.str()
            const type = msg.str()
            const token = msg.readRawHexStr(4)
            debug(`recv PeerInit user ${user}, type ${type}, token ${token}`)
            this.emit('peer-init', { client, token } satisfies PeerInitEvent)
            break
          }
          default: {
            debug(`unknown distributed peer message code: ${code}`)
          }
        }
      })
    })

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      debug(`Error ${err.code}`)
    })

    this.server.listen(address.port, address.host, () => {
      debug(`MockDistributedPeer bound on ${address.host}:${address.port}`)
    })
  }

  searchRequest (client: net.Socket, user: string, ticket: string, query: string): void {
    client.write(
      searchRequest(user, ticket, query).getBuff()
    )
  }

  destroy (): void {
    this.server.close()
  }
}

function searchRequest (user: string, ticket: string, query: string): Message {
  return new Message()
    .int8(3)
    .int32(39)
    .str(user)
    .rawHexStr(ticket)
    .str(query)
}

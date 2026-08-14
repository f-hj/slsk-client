import EventEmitter from 'events'
import net from 'net'
import zlib from 'zlib'
import createDebug from 'debug'
import Messages from '../src/messages'
import Message from '../src/message'
import MessageFactory, { type FileSearchResult } from '../src/message-factory'
import type { ServerAddress } from '../src/types'

const debug = createDebug('slsk:mock:peer:default:i')

export interface MockDefaultPeerEvents {
  'file-search-result': [result: FileSearchResult]
}

export default class MockDefaultPeer extends EventEmitter<MockDefaultPeerEvents> {
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
        const code = msg.int32()
        switch (code) {
          case 9: {
            debug('recv FileSearchResult')
            const content = msg.data.subarray(msg.pointer, size + 4)
            zlib.unzip(content, (err, buffer) => {
              if (err) {
                debug(err)
                return
              }

              this.emit('file-search-result', MessageFactory.from.peer.fileSearchResult(buffer))
            })
            break
          }
          default: {
            debug(`unknown default peer message code: ${code}`)
          }
        }
      })
    })

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      debug(`Error ${err.code}`)
    })

    this.server.listen(address.port, address.host, () => {
      debug(`MockDefaultPeer bound on ${address.host}:${address.port}`)
    })
  }

  destroy (): void {
    this.server.close()
  }
}

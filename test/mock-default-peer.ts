import EventEmitter from 'events'
import net from 'net'
import zlib from 'zlib'
import createDebug from 'debug'
import Messages from '../src/utils/messages'
import Message from '../src/utils/message'
import { parseFileSearchResult, type FileSearchResult } from '../src/peer/default-peer/messages'
import type { ServerAddress } from '../src/types'

const debug = createDebug('slsk:mock:peer:default:i')

/** UserInfoResponse (16), as a real peer puts it on the wire */
function userInfoResponse (info: MockUserInfo): Buffer {
  const msg = new Message()
    .int32(16)
    .str(info.description)

  if (info.picture) {
    msg.int8(1)
    msg.int32(info.picture.length)
    msg.writeBuffer(info.picture)
  } else {
    msg.int8(0)
  }

  msg
    .int32(info.uploadSlots)
    .int32(info.queueSize)
    .int8(info.slotsFree ? 1 : 0)

  if (info.uploadPermitted !== undefined) msg.int32(info.uploadPermitted)

  return msg.getBuff()
}

export interface MockDefaultPeerEvents {
  'file-search-result': [result: FileSearchResult]
  /** The client asked what this peer tells about itself */
  'user-info-request': []
}

/** Info a mock peer answers with, written by hand so the parser is checked against real bytes */
export interface MockUserInfo {
  description: string
  picture?: Buffer
  uploadSlots: number
  queueSize: number
  slotsFree: boolean
  uploadPermitted?: number
}

export interface MockDefaultPeerOptions {
  /** Answered to a UserInfoRequest, nothing is answered when unset */
  userInfo?: MockUserInfo
}

export default class MockDefaultPeer extends EventEmitter<MockDefaultPeerEvents> {
  private server: net.Server

  constructor (address: ServerAddress, readonly options: MockDefaultPeerOptions = {}) {
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

              this.emit('file-search-result', parseFileSearchResult(buffer))
            })
            break
          }
          case 15: {
            debug('recv UserInfoRequest')
            this.emit('user-info-request')
            const info = this.options.userInfo
            if (info) client.write(userInfoResponse(info))
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

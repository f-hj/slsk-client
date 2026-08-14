import type net from 'net'
import zlib from 'zlib'
import createDebug from 'debug'
import Peer from './peer'
import Messages from '../messages'
import Message from '../message'
import MessageFactory from '../message-factory'
import downloadPeerFile from './download-peer-file'
import stack, { downloadKey, failDownload } from '../stack'
import { FileAttribute, type PeerInfo, type SearchResult } from '../types'
import type Shared from '../share/shared'

const debug = createDebug('slsk:peer:default:i')

export interface DefaultPeerOptions {
  /** Shared files, used to answer share browsing and folder content requests */
  shared?: Shared
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
}

export default class DefaultPeer extends Peer {
  private readonly shared?: Shared

  constructor (socket: net.Socket, peer: PeerInfo, options: DefaultPeerOptions = {}) {
    super(socket, peer)
    this.shared = options.shared

    this.conn.on('connect', () => {
      if (peer.token) {
        // the server asked us to connect to this peer, pierce its firewall with the given token
        this.write(MessageFactory.to.peer.pierceFw(peer.token))
      } else {
        // we reached the peer on our own, introduce ourselves
        this.write(MessageFactory.to.peer.peerInit(stack.currentLogin ?? '', 'P', '00000000'))
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
    const peer = this.peer
    const size = msg.int32()
    if (size <= 4) return

    const code = msg.int32()
    switch (code) {
      case 4: {
        debug(`${peer.user} recv GetSharedFileList ${size}`)
        const files = this.shared ? this.shared.files : []
        debug(`${peer.user} sending SharedFileList with ${files.length} files`)
        this.write(MessageFactory.to.peer.sharedFileList(files))
        break
      }
      case 9: {
        debug(`${peer.user} recv FileSearchResult size ${size}`)
        const content = msg.data.subarray(msg.pointer, size + 4)
        zlib.unzip(content, (err, buffer) => {
          if (err) {
            debug(err)
            return
          }

          let result
          try {
            result = MessageFactory.from.peer.fileSearchResult(buffer)
          } catch (parseError) {
            debug(`${peer.user} cannot parse FileSearchResult: ${String(parseError)}`)
            return
          }

          const search = stack.search[result.currentToken]
          if (!search) return

          result.files.forEach(file => {
            const attribs = file.attribs
            search.cb({
              user: file.user,
              file: file.file,
              size: file.size,
              slots: result.slots === 1,
              bitrate: attribs[FileAttribute.Bitrate],
              duration: attribs[FileAttribute.Duration],
              vbr: FileAttribute.VBR in attribs ? attribs[FileAttribute.VBR] === 1 : undefined,
              sampleRate: attribs[FileAttribute.SampleRate],
              bitDepth: attribs[FileAttribute.BitDepth],
              attribs,
              speed: result.speed,
              queueLength: result.queueLength
            } satisfies SearchResult)
          })
        })
        break
      }
      case 15: {
        debug(`${peer.user} recv UserInfoRequest`)
        this.write(MessageFactory.to.peer.userInfoResponse({
          description: 'slsk-client',
          slotsFree: false
        }))
        break
      }
      case 36: {
        const token = msg.rawHexStr(4)
        const folder = msg.str()
        debug(`${peer.user} recv FolderContentsRequest for ${folder}`)
        if (!this.shared) break
        const files = this.shared.filesInFolder(folder)
        debug(`${peer.user} sending FolderContentsResponse with ${files.length} files`)
        this.write(MessageFactory.to.peer.folderContentsResponse(token, folder, files))
        break
      }
      case 40: {
        const dir = msg.int32()
        const token = msg.rawHexStr(4)
        const file = msg.str()

        if (dir !== 1) {
          // the peer wants to download from us, uploading is not supported
          debug(`${peer.user} recv TransferRequest (download) ${file}, denying`)
          this.write(MessageFactory.to.peer.transferResponse(token, false, 'Cancelled'))
          break
        }

        debug(`${peer.user} recv TransferRequest ${file}`)
        stack.downloadTokens[token] = {
          user: peer.user,
          file,
          size: msg.int64()
        }
        const res = MessageFactory
          .to.peer
          .transferResponse(token)

        setTimeout(() => {
          debug(`${peer.user} sending TransferResponse`)
          this.write(res)
        }, 200)
        break
      }
      case 41: {
        const token = msg.rawHexStr(4)
        const allowed = msg.int8()
        debug(`${peer.user} recv TransferResponse token: ${token} allowed: ${allowed}`)
        if (allowed === 0) {
          const reason = msg.str()
          debug(`reason: ${reason}, I will receive TransferRequest soon...`)
          delete stack.downloadTokens[token] // avoid memory leak
        } else if (allowed === 1) {
          debug(`Directly allowed. Connecting to peer with PeerInit + ${token}`)
          downloadPeerFile(peer.host as string, peer.port as number, token, peer.user, true)
        }
        break
      }
      case 43: {
        const filename = msg.str()
        debug(`${peer.user} recv QueueUpload ${filename}, uploading is not supported`)
        this.write(MessageFactory.to.peer.uploadDenied(filename, 'Cancelled'))
        break
      }
      case 44: {
        const filename = msg.str()
        const place = msg.int32()
        debug(`${peer.user} recv PlaceInQueueResponse ${filename}: ${place}`)
        const down = stack.download[downloadKey(peer.user, filename)]
        if (down?.onQueue) down.onQueue(place)
        break
      }
      case 46: {
        const filename = msg.str()
        debug(`${peer.user} UploadFailed ${filename}`)
        if (!failDownload(peer.user, filename, new Error('Peer error'))) {
          debug(`Cannot reject download for ${peer.user} ${filename}`)
        }
        break
      }
      case 50: {
        const filename = msg.str()
        const reason = msg.str()
        debug(`${peer.user} UploadDenied ${filename} reason ${reason}`)
        if (!failDownload(peer.user, filename, new Error(reason || 'Upload denied'))) {
          debug(`Cannot reject download for ${peer.user} ${filename}`)
        }
        break
      }
      case 51: {
        const filename = msg.str()
        debug(`${peer.user} recv PlaceInQueueRequest ${filename}, nothing is queued`)
        break
      }
      default: {
        debug(`${peer.user} unknown peer message code ${code}`)
      }
    }
  }
}

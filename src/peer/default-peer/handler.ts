import zlib from 'zlib'
import createDebug from 'debug'
import messages, { parseFileSearchResult, parseUserInfo } from './messages'
import type Message from '../../utils/message'
import type DefaultPeer from './default-peer'

const debug = createDebug('slsk:peer:default:i')

/**
 * Handles a message received on a peer connection (type P): answers what belongs to the
 * connection itself (share browsing, refusing uploads) and reports the rest to the client,
 * which is the one keeping track of searches and transfers.
 */
export default function handleDefaultPeerMessage (msg: Message, peer: DefaultPeer): void {
  const user = peer.user
  const size = msg.int32()
  // 4 is a message carrying nothing but its code, GetSharedFileList and UserInfoRequest do
  if (size < 4) return

  const code = msg.int32()
  switch (code) {
    case 4: {
      debug(`${user} recv GetSharedFileList ${size}`)
      const files = peer.shared ? peer.shared.files : []
      debug(`${user} sending SharedFileList with ${files.length} files`)
      peer.send(messages.sharedFileList(files))
      break
    }
    case 9: {
      debug(`${user} recv FileSearchResult size ${size}`)
      const content = msg.data.subarray(msg.pointer, size + 4)
      zlib.unzip(content, (err, buffer) => {
        if (err) {
          debug(err)
          return
        }

        let result
        try {
          result = parseFileSearchResult(buffer)
        } catch (parseError) {
          debug(`${user} cannot parse FileSearchResult: ${String(parseError)}`)
          return
        }

        peer.emit('search-result', result)
      })
      break
    }
    case 15: {
      debug(`${user} recv UserInfoRequest`)
      peer.send(messages.userInfoResponse(peer.userInfo))
      break
    }
    case 16: {
      debug(`${user} recv UserInfoResponse`)
      let info
      try {
        info = parseUserInfo(msg, user)
      } catch (parseError) {
        debug(`${user} cannot parse UserInfoResponse: ${String(parseError)}`)
        break
      }
      peer.emit('user-info', info)
      break
    }
    case 36: {
      const token = msg.rawHexStr(4)
      const folder = msg.str()
      debug(`${user} recv FolderContentsRequest for ${folder}`)
      if (!peer.shared) break
      const files = peer.shared.filesInFolder(folder)
      debug(`${user} sending FolderContentsResponse with ${files.length} files`)
      peer.send(messages.folderContentsResponse(token, folder, files))
      break
    }
    case 40: {
      const direction = msg.int32()
      const token = msg.rawHexStr(4)
      const file = msg.str()
      const size = direction === 1 ? msg.int64() : undefined
      debug(`${user} recv TransferRequest direction ${direction} ${file}`)
      peer.emit('transfer-request', { direction, token, file, size })
      break
    }
    case 41: {
      const token = msg.rawHexStr(4)
      const allowed = msg.int8() === 1
      const reason = allowed ? undefined : msg.str()
      debug(`${user} recv TransferResponse token: ${token} allowed: ${String(allowed)}`)
      peer.emit('transfer-response', { token, allowed, reason })
      break
    }
    case 43: {
      const file = msg.str()
      debug(`${user} recv QueueUpload ${file}, uploading is not supported`)
      peer.uploadDenied(file, 'Cancelled')
      break
    }
    case 44: {
      const file = msg.str()
      const place = msg.int32()
      debug(`${user} recv PlaceInQueueResponse ${file}: ${place}`)
      peer.emit('place-in-queue', { file, place })
      break
    }
    case 46: {
      const file = msg.str()
      debug(`${user} UploadFailed ${file}`)
      peer.emit('upload-failed', file)
      break
    }
    case 50: {
      const file = msg.str()
      const reason = msg.str()
      debug(`${user} UploadDenied ${file} reason ${reason}`)
      peer.emit('upload-denied', { file, reason })
      break
    }
    case 51: {
      const file = msg.str()
      debug(`${user} recv PlaceInQueueRequest ${file}, nothing is queued`)
      break
    }
    default: {
      debug(`${user} unknown peer message code ${code}`)
    }
  }
}

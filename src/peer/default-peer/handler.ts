import zlib from 'zlib'
import createDebug from 'debug'
import messages, { parseFileSearchResult, parseUserInfo } from './messages'
import { PEER_MESSAGES, nameOf } from '../../utils/message-names'
import type Message from '../../utils/message'
import type DefaultPeer from './default-peer'

const debug = createDebug('slsk:peer:default:i')

/**
 * Reason sent to a peer asking for a file of a client that shares without serving. Not one of
 * the reasons clients special case, so it reaches the user of the asking client as it is,
 * instead of looking like a transfer somebody cancelled.
 */
export const UPLOADS_DISABLED = 'Uploads are disabled'

/**
 * Handles a message received on a peer connection (type P): answers what belongs to the
 * connection itself (share browsing, refusing uploads) and reports the rest to the client,
 * which is the one keeping track of searches and transfers.
 */
export default function handleDefaultPeerMessage (msg: Message, peer: DefaultPeer): void {
  const user = peer.user
  // which connection carried it: a peer often holds one it opened and one we opened
  const from = peer.label
  const size = msg.int32()
  // 4 is a message carrying nothing but its code, GetSharedFileList and UserInfoRequest do
  if (size < 4) return

  const code = msg.int32()
  debug(`${from} recv ${nameOf(PEER_MESSAGES, code)}, ${size} bytes`)

  switch (code) {
    case 4: {
      const files = peer.shared ? peer.shared.files : []
      peer.send(messages.sharedFileList(files), `${files.length} files`)
      break
    }
    case 9: {
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
          debug(`${from} cannot parse FileSearchResult: ${String(parseError)}`)
          return
        }

        peer.emit('search-result', result)
      })
      break
    }
    case 15: {
      peer.send(messages.userInfoResponse(peer.userInfo))
      break
    }
    case 16: {
      let info
      try {
        info = parseUserInfo(msg, user)
      } catch (parseError) {
        debug(`${from} cannot parse UserInfoResponse: ${String(parseError)}`)
        break
      }
      peer.emit('user-info', info)
      break
    }
    case 36: {
      const token = msg.rawHexStr(4)
      const folder = msg.str()
      debug(`${from} wants the contents of ${folder}`)
      if (!peer.shared) break
      const files = peer.shared.filesInFolder(folder)
      peer.send(messages.folderContentsResponse(token, folder, files), `${folder}, ${files.length} files`)
      break
    }
    case 40: {
      const direction = msg.int32()
      const token = msg.rawHexStr(4)
      const file = msg.str()
      const size = direction === 1 ? msg.int64() : undefined
      debug(`${from} direction ${direction}, ${file}`)
      peer.emit('transfer-request', { direction, token, file, size })
      break
    }
    case 41: {
      const token = msg.rawHexStr(4)
      const allowed = msg.int8() === 1
      const reason = allowed ? undefined : msg.str()
      debug(`${from} token ${token} allowed ${String(allowed)}${reason ? ` (${reason})` : ''}`)
      peer.emit('transfer-response', { token, allowed, reason })
      break
    }
    case 43: {
      const file = msg.str()
      if (!peer.serves) {
        debug(`${from} wants ${file}, uploads are disabled`)
        peer.uploadDenied(file, UPLOADS_DISABLED)
        break
      }
      // the client owns the queue and the slots, it decides what happens to this request
      debug(`${from} wants ${file}`)
      peer.emit('queue-upload', file)
      break
    }
    case 44: {
      const file = msg.str()
      const place = msg.int32()
      debug(`${from} places us at ${place} for ${file}`)
      peer.emit('place-in-queue', { file, place })
      break
    }
    case 46: {
      const file = msg.str()
      debug(`${from} gave up on ${file}`)
      peer.emit('upload-failed', file)
      break
    }
    case 50: {
      const file = msg.str()
      const reason = msg.str()
      debug(`${from} refuses ${file}: ${reason}`)
      peer.emit('upload-denied', { file, reason })
      break
    }
    case 51: {
      const file = msg.str()
      if (!peer.serves) {
        debug(`${from} asks its place for ${file}, nothing is queued`)
        break
      }
      // the queue is the client's, only it knows where the file stands
      peer.emit('place-in-queue-request', file)
      break
    }
    default: {
      debug(`${from} nothing is done with ${nameOf(PEER_MESSAGES, code)}`)
    }
  }
}

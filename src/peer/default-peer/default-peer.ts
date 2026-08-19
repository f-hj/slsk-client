import type net from 'net'
import createDebug from 'debug'
import Peer, { type PeerOptions } from '../peer'
import Messages from '../../utils/messages'
import messages, {
  type FileSearchResult,
  type FileSearchResultOptions,
  type TransferRequestEvent,
  type TransferResponseEvent
} from './messages'
import handleDefaultPeerMessage from './handler'
import { PEER_MESSAGES, nameOf } from '../../utils/message-names'
import type Message from '../../utils/message'
import type Shared from '../../share/shared'
import type { PeerInfo, UserInfo, UserInfoOptions } from '../../types'
import type { ShareEntry } from '../../share/provider'

const debug = createDebug('slsk:peer:default:i')

export interface DefaultPeerOptions extends PeerOptions {
  /** Shared files, used to answer share browsing and folder content requests */
  shared?: Shared
  /** Bytes already received on the socket, after the peer init message */
  initialData?: Buffer
  /**
   * What is answered to a UserInfoRequest, `DEFAULT_USER_INFO` fills what is left out. A
   * function is called every time a peer asks, for the parts that change while we run.
   */
  userInfo?: UserInfoOptions | (() => UserInfoOptions)
  /**
   * true when the client serves the files it shares: the requests of the peer are then reported
   * as events for the client to queue, instead of being denied on the spot (default: false).
   */
  uploads?: boolean
}

export type { TransferRequestEvent, TransferResponseEvent }

export type DefaultPeerEvents = {
  /** Files a peer sends back for one of our searches */
  'search-result': [result: FileSearchResult]
  /** The peer wants to transfer a file, in one direction or the other */
  'transfer-request': [evt: TransferRequestEvent]
  /** The peer answered a transfer we asked for */
  'transfer-response': [evt: TransferResponseEvent]
  /** Our place in the upload queue of the peer */
  'place-in-queue': [evt: { file: string, place: number }]
  /** The peer gave up on an upload it had accepted */
  'upload-failed': [file: string]
  /** The peer refuses to upload a file, with its reason */
  'upload-denied': [evt: { file: string, reason: string }]
  /** The peer wants one of our files, only reported when the client serves them */
  'queue-upload': [file: string]
  /** The peer asks where the file it is waiting for stands in our queue */
  'place-in-queue-request': [file: string]
  /** What the peer tells about itself, its answer to a UserInfoRequest */
  'user-info': [info: UserInfo]
}

/**
 * A peer connection (type P): the messages it receives are parsed by its handler, which
 * answers what belongs to the connection and reports the rest as events.
 */
export default class DefaultPeer extends Peer<DefaultPeerEvents> {
  /** Shared files, used to answer share browsing and folder content requests */
  readonly shared?: Shared
  private readonly userInfoSource?: UserInfoOptions | (() => UserInfoOptions)
  /** true when the client serves its shared files, so a request for one is worth reporting */
  readonly serves: boolean
  /**
   * Whether this peer understands the upload queue (QueueUpload 43, PlaceInQueueRequest 51),
   * which nothing on the wire announces: `undefined` until it answered anything about it, true
   * as soon as it did, false once it stayed silent and the old request had to be used instead.
   */
  supportsQueue?: boolean

  constructor (socket: net.Socket, peer: PeerInfo, options: DefaultPeerOptions) {
    super(socket, peer, options)
    this.shared = options.shared
    this.userInfoSource = options.userInfo
    this.serves = options.uploads === true

    this.conn.on('connect', () => {
      if (peer.token) {
        // the server asked us to connect to this peer, pierce its firewall with the given token
        this.sendPierceFw(peer.token)
      } else {
        // we reached the peer on our own, introduce ourselves
        this.sendPeerInit('P', '00000000')
      }
    })

    const msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', (msg: Message) => handleDefaultPeerMessage(msg, this))

    const initialData = options.initialData
    if (initialData && initialData.length > 0) {
      /*
       * A peer often sends its first message in the same segment as its PeerInit, and whoever
       * built us registers its listeners once the constructor returned: parsing those bytes now
       * would report them to nobody. A microtask runs before the event loop comes back with more
       * socket data, so nothing is reordered either.
       */
      queueMicrotask(() => {
        if (this.conn.destroyed) return
        msgs.write(initialData)
      })
    }
  }

  /** What is answered to a UserInfoRequest of this peer, as it stands right now */
  get userInfo (): UserInfoOptions | undefined {
    return typeof this.userInfoSource === 'function' ? this.userInfoSource() : this.userInfoSource
  }

  /** The messages of a peer connection have an uint32 code, unlike the init ones */
  protected override logSent (msg: Message, detail?: string): void {
    const name = nameOf(PEER_MESSAGES, msg.data.readUInt32LE(0))
    debug(`${this.label} send ${name}, ${msg.data.length} bytes${detail ? `: ${detail}` : ''}`)
  }

  /** UserInfoRequest (15): asks the peer what it tells about itself */
  userInfoRequest (): void {
    this.send(messages.userInfoRequest())
  }

  /** TransferRequest (40) direction 0: legacy way of asking for a download */
  transferRequest (file: string, token: string): void {
    this.send(messages.transferRequest(file, token), `${file} token ${token}`)
  }

  /** TransferRequest (40) direction 1: announces a file we are about to send */
  uploadRequest (file: string, token: string, size: number): void {
    this.send(messages.uploadRequest(file, token, size), `${file} token ${token}, ${size} bytes`)
  }

  /** TransferResponse (41): answers a transfer a peer announced */
  transferResponse (token: string, allowed = true, reason?: string): void {
    this.send(
      messages.transferResponse(token, allowed, reason),
      `token ${token} allowed ${String(allowed)}${reason ? ` (${reason})` : ''}`
    )
  }

  /** QueueUpload (43): asks the peer to queue a file for upload to us */
  queueUpload (file: string): void {
    this.send(messages.queueUpload(file), file)
  }

  /** PlaceInQueueRequest (51): asks our position in the upload queue of the peer */
  placeInQueueRequest (file: string): void {
    this.send(messages.placeInQueueRequest(file), file)
  }

  /** PlaceInQueueResponse (44): tells the peer where its file stands in our queue */
  placeInQueueResponse (file: string, place: number): void {
    this.send(messages.placeInQueueResponse(file, place), `${file} at ${place}`)
  }

  /** UploadFailed (46): tells the peer the transfer we announced will not happen */
  uploadFailed (file: string): void {
    this.send(messages.uploadFailed(file), file)
  }

  /** UploadDenied (50): tells the peer it will not get the file */
  uploadDenied (file: string, reason: string): void {
    this.send(messages.uploadDenied(file, reason), `${file}: ${reason}`)
  }

  /** FileSearchResponse (9): our matches for a search the peer asked the network */
  fileSearchResult (
    files: ShareEntry[],
    token: string,
    user: string,
    options?: FileSearchResultOptions
  ): void {
    this.send(
      messages.fileSearchResult(files, token, user, options),
      `${files.length} files, ticket ${token}`
    )
  }
}

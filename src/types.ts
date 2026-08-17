import type { ShareProvider } from './share/provider'

export interface ServerAddress {
  host: string
  port: number
}

/** Everything a client needs to know before it logs in */
export interface SlskClientOptions {
  /** Soulseek server host (default: server.slsknet.org) */
  host?: string
  /** Soulseek server port (default: 2242) */
  port?: number
  /** Port used for incoming peer connections (default: 2234) */
  incomingPort?: number
  /** Folders of the local file system to be shared with other peers (default: []) */
  sharedFolders?: string[]
  /**
   * Share providers, to share files that do not come from the local file system
   * (object storage, database, remote API...). Used on top of `sharedFolders`.
   */
  shares?: ShareProvider | ShareProvider[]
  /** Time in ms after which the login attempt fails (default: 2000) */
  timeout?: number
  /**
   * What is answered to a peer asking for our info with a UserInfoRequest
   * (default: no description, one free slot, nothing queued and uploads open to everyone)
   */
  userInfo?: UserInfoOptions
}

export interface SearchOptions {
  /** Query sent to the slsk server/peers, use spaces to add keywords */
  req: string
  /** Slsk doesn't tell when a search is finished, results are collected until this time (ms, default: 4000) */
  timeout?: number
}

/**
 * Attribute codes used in search results and shared file lists,
 * as documented by the Soulseek protocol.
 */
export enum FileAttribute {
  Bitrate = 0,
  Duration = 1,
  VBR = 2,
  Encoder = 3,
  SampleRate = 4,
  BitDepth = 5
}

export interface SearchResult {
  /** Peer name owning the file */
  user: string
  /** Full path of the file on the peer side */
  file: string
  /** Size of the file in bytes */
  size: number
  /** true if the peer has a free slot to send the file immediately */
  slots: boolean
  /** Bitrate of the file, may be undefined when not sent by the peer */
  bitrate?: number
  /** Duration in seconds, may be undefined when not sent by the peer */
  duration?: number
  /** true when the file is VBR encoded, undefined when not sent by the peer */
  vbr?: boolean
  /** Sample rate in Hz, may be undefined when not sent by the peer */
  sampleRate?: number
  /** Bit depth of the file, may be undefined when not sent by the peer */
  bitDepth?: number
  /** All raw attributes sent by the peer, keyed by {@link FileAttribute} */
  attribs?: Record<number, number>
  /** Speed of the peer, as reported by the peer itself */
  speed: number
  /** Number of files queued for upload on the peer side, when reported */
  queueLength?: number
}

export interface DownloadOptions {
  /** A file object obtained from a search */
  file: SearchResult
  /** Complete path where the file will be stored (default: /tmp/slsk/{{originalName}}) */
  path?: string
  /**
   * Number of bytes already downloaded, sent to the peer as the file offset to resume a
   * partial download. When set, `path` is appended to instead of being overwritten (default: 0)
   */
  offset?: number
  /**
   * How the download is asked for:
   * - `queue` (default) sends QueueUpload (43), the flow used by modern clients, and follows
   *   the place in queue with PlaceInQueueRequest (51)
   * - `transfer` sends the legacy TransferRequest (40, direction 0), kept for peers that only
   *   understand the old flow
   */
  request?: 'queue' | 'transfer'
}

export interface DownloadProgress {
  /** Peer name sending the file */
  user: string
  /** Full path of the file on the peer side */
  file: string
  /** Bytes received so far, including `DownloadOptions.offset` when resuming */
  receivedBytes: number
  /** Total size of the file, undefined until the peer announced it */
  totalBytes?: number
  /** Ratio between 0 and 1, undefined until the peer announced the total size */
  progress?: number
}

export interface QueuePlace {
  /** Peer name holding the file */
  user: string
  /** Full path of the file on the peer side */
  file: string
  /** Position in the upload queue of the peer, 0 means the transfer is starting */
  place: number
}

/** What a finished download resolves with */
export interface DownloadResult {
  /** Path where the file has been written */
  path: string
  /** Buffer of the received data, the whole file unless the download was resumed */
  buffer: Buffer
  /** Bytes on disk, including `DownloadOptions.offset` when the download was resumed */
  receivedBytes: number
  /** Size announced by the peer, when known: a smaller `receivedBytes` means a partial file */
  size?: number
}

/** Who a peer accepts uploads from, as sent at the end of a UserInfoResponse */
export enum UploadPermission {
  NoOne = 0,
  Everyone = 1,
  /** Only the users of its buddy list */
  UserList = 2,
  /** Only the users it explicitly allowed */
  PermittedList = 3
}

/** What a peer tells about itself, its answer to a UserInfoRequest */
export interface UserInfo {
  /** Peer the info is about */
  user: string
  /** Free text the peer set as its description, empty when it has none */
  description: string
  /** Picture the peer shares, undefined when it sent none */
  picture?: Buffer
  /** Number of upload slots of the peer */
  uploadSlots: number
  /** Number of files queued for upload on the peer side */
  queueSize: number
  /** true when a slot is free to upload immediately */
  slotsFree: boolean
  /** Who the peer accepts uploads from, undefined when it did not send the field */
  uploadPermitted?: UploadPermission
}

/** What this client answers to a peer asking for our info */
export interface UserInfoOptions {
  /** Free text sent as our description (default: slsk-client) */
  description?: string
  /** Picture sent along the description, none by default */
  picture?: Buffer
  /** Number of upload slots we advertise (default: 1) */
  uploadSlots?: number
  /** Number of files we advertise as queued for upload (default: 0) */
  queueSize?: number
  /** true to advertise a free upload slot (default: true) */
  slotsFree?: boolean
  /** Who we tell the peer we accept uploads from (default: everyone) */
  uploadPermitted?: UploadPermission
}

export interface PeerInfo {
  user: string
  type?: string
  token?: string
  host?: string
  port?: number
  ip?: number[]
}

export interface PeerSearchRequest {
  user: string
  ticket: string
  query: string
}

/**
 * @deprecated shared files are described by `ShareEntry` since the share providers were
 * introduced, this type is only kept so imports of older versions still compile.
 */
export interface SharedFileEntry {
  key: string
  value: {
    file: string
    size: number
  }
}

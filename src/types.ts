import type { Readable } from 'stream'

export interface ServerAddress {
  host: string
  port: number
}

export interface ConnectOptions {
  /** Your Soulseek username */
  user: string
  /** Your Soulseek password */
  pass: string
  /** Soulseek server host (default: server.slsknet.org) */
  host?: string
  /** Soulseek server port (default: 2242) */
  port?: number
  /** Port used for incoming peer connections (default: 2234) */
  incomingPort?: number
  /** Folders to be shared with other peers (default: []) */
  sharedFolders?: string[]
  /** Time in ms after which the login attempt fails (default: 2000) */
  timeout?: number
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

export interface Download {
  /** Path where the file has been written */
  path: string
  /** Buffer of the received data, the whole file unless the download was resumed */
  buffer: Buffer
  /** Stream, only set for stream downloads */
  stream?: Readable
  /** Bytes on disk, including `DownloadOptions.offset` when the download was resumed */
  receivedBytes: number
  /** Size announced by the peer, when known: a smaller `receivedBytes` means a partial file */
  size?: number
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

export interface SharedFileEntry {
  key: string
  value: {
    file: string
    size: number
  }
}

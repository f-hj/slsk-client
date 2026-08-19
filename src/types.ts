import type { ShareProvider } from './share/provider'

export interface ServerAddress {
  host: string
  port: number
}

/** How a lost connection to the slsk server is picked up again */
export interface ReconnectOptions {
  /** How many times the connection is retried before giving up (default: unlimited) */
  retries?: number
  /** ms before the first attempt, doubled after every failure (default: 1000) */
  delay?: number
  /** Upper bound of that growing delay, in ms (default: 60000) */
  maxDelay?: number
}

/** Everything a client needs to know before it logs in */
export interface SlskClientOptions {
  /** Soulseek server host (default: server.slsknet.org) */
  host?: string
  /** Soulseek server port (default: 2242) */
  port?: number
  /** Port used for incoming peer connections (default: 2234) */
  incomingPort?: number
  /**
   * What is shared with the other peers, as one or several share providers:
   * `fsShareProvider({ folders })` for folders of the local file system,
   * `memoryShareProvider()` for files held in memory, or your own for anything else
   * (object storage, database, remote API...).
   */
  shares?: ShareProvider | ShareProvider[]
  /** Time in ms after which the login attempt fails (default: 2000) */
  timeout?: number
  /**
   * How many times a transfer that stopped before the end is asked for again, from the bytes
   * already received (default: 3). 0 to fail an interrupted download right away.
   */
  downloadRetries?: number
  /**
   * Time in ms of silence on a file connection before the transfer is considered dead and
   * asked for again (default: 60000). A file connection carries the transfer or nothing, so
   * an idle one is a transfer that will not finish.
   */
  transferTimeout?: number
  /**
   * What is answered to a peer asking for our info with a UserInfoRequest
   * (default: no description, one free slot, nothing queued and uploads open to everyone)
   */
  userInfo?: UserInfoOptions
  /**
   * What happens when the connection to the slsk server drops: log in again, with a growing
   * delay between the attempts (default), or `false` to leave it to the caller, which is then
   * told about it by the `server-disconnect` event.
   */
  reconnect?: boolean | ReconnectOptions
  /**
   * ms without any progress after which a download fails, unless it sets its own
   * `DownloadOptions.timeout` (default: no timeout, a queued file can wait for hours)
   */
  downloadTimeout?: number
  /**
   * ms to wait for any sign that a peer understands the upload queue (QueueUpload 43) before
   * asking it for the file the way clients did before the queue existed (default: 10000).
   * Rarely worth changing: it only delays the downloads from peers old enough to ignore the
   * queue messages entirely.
   */
  queueFallbackDelay?: number
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

/**
 * Attributes of a file, keyed by {@link FileAttribute}: `attribs[FileAttribute.Bitrate]`. Codes
 * this version knows nothing about are kept as they came, so nothing a peer sends is lost.
 */
export type FileAttributes = Partial<Record<FileAttribute, number>> & Record<number, number | undefined>

export interface SearchResult {
  /** Peer name owning the file */
  user: string
  /** Full path of the file on the peer side */
  file: string
  /** Size of the file in bytes */
  size: number
  /** true if the peer has a free slot to send the file immediately */
  slots: boolean
  /**
   * Everything the peer said about the file, keyed by {@link FileAttribute}: an empty object
   * when it sent nothing. `attribs[FileAttribute.Bitrate]`, `attribs[FileAttribute.Duration]`,
   * `attribs[FileAttribute.VBR] === 1`...
   */
  attribs: FileAttributes
  /** Speed of the peer, as reported by the peer itself */
  speed: number
  /** Number of files queued for upload on the peer side, when reported */
  queueLength?: number
}

/**
 * What to download and how. A {@link SearchResult} already holds `user`, `file` and `size`, so
 * `download(result)` and `download({ ...result, path })` both work.
 */
export interface DownloadOptions {
  /** Peer holding the file */
  user: string
  /** Full path of the file on the peer side, as a search result reports it */
  file: string
  /**
   * Size the search result announced, used to report the progress before the peer announces the
   * transfer. Only a hint: the peer is the one that knows how big the file is.
   */
  size?: number
  /** Complete path where the file will be stored (default: /tmp/slsk/{{user}}_{{originalName}}) */
  path?: string
  /**
   * Number of bytes already downloaded, sent to the peer as the file offset to resume a
   * partial download. When set, `path` is appended to instead of being overwritten (default: 0)
   */
  offset?: number
  /**
   * ms without any progress after which the download fails with a `DownloadTimeoutError`
   * (default: `SlskClientOptions.downloadTimeout`, none unless it is set). Queue updates count
   * as progress; use `signal: AbortSignal.timeout(ms)` for a deadline that nothing resets.
   */
  timeout?: number
  /** Aborting it cancels the download, whatever state it is in */
  signal?: AbortSignal
}

export interface DownloadProgress {
  /** Peer name sending the file */
  user: string
  /** Full path of the file on the peer side */
  file: string
  /** Bytes received so far, including `DownloadOptions.offset` when resuming */
  receivedBytes: number
  /**
   * Size of the file: what the peer announced, the `DownloadOptions.size` hint until then, and
   * undefined when neither is known
   */
  totalBytes?: number
  /** true when `totalBytes` is what the peer announced, false when it is the search-result hint */
  sizeAnnounced: boolean
  /** Ratio between 0 and 1, undefined while the size of the file is unknown */
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
  /**
   * Size the peer announced, undefined when it announced none: a `receivedBytes` smaller than
   * an announced size means the file is partial
   */
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

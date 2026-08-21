import type {
  DownloadProgress,
  PrivateMessage,
  QueuePlace,
  SearchResult,
  UploadProgress
} from './types'

/** Everything a client reports, on top of the events of the individual transfers */
export type SlskClientEvents = {
  /** Emitted for every incoming search result */
  found: [res: SearchResult]
  /** Progress of a running download */
  'download-progress': [progress: DownloadProgress]
  /** Position of a download in the upload queue of the peer */
  'download-queue': [place: QueuePlace]
  /** A transfer stopped early and is being asked for again from where it stopped */
  'download-interrupted': [evt: {
    user: string
    file: string
    receivedBytes: number
    size?: number
    attempts: number
  }]
  /** A peer asked for one of our files and it went into the upload queue */
  'upload-queued': [evt: { user: string, file: string, place: number }]
  /** Progress of a file being sent to a peer */
  'upload-progress': [progress: UploadProgress]
  /** A file has been sent whole */
  'upload-complete': [evt: { user: string, file: string, sentBytes: number }]
  /** A file could not be sent, the peer has been told */
  'upload-failed': [evt: { user: string, file: string, error: Error }]
  /** A private message another user sent us */
  'private-message': [msg: PrivateMessage]
  /** Error on the connection to the slsk server */
  'server-error': [err: Error]
  /**
   * The connection to the slsk server is gone. `reconnecting` is false when the client will not
   * try to log in again, which makes it the moment to `destroy()` it or to build a new one.
   */
  'server-disconnect': [evt: { reconnecting: boolean }]
  /** Logged in again after a lost connection: searches and downloads can be started again */
  'server-reconnect': []
  /**
   * Another client logged in with the same name and the server dropped this session. Two
   * instances sharing one account kick each other off in a loop, so stop one of them.
   */
  relogged: []
  /** Error on the server listening for incoming peer connections */
  'listen-error': [err: Error]
  /** Error on a peer connection */
  'peer-error': [err: Error, user: string]
  /** The first share listing is over and its counts have been announced to the server */
  'shares-ready': [stats: { folders: number, files: number }]
  /** The first share listing failed, nothing is shared until a `refreshShares()` succeeds */
  'shares-error': [err: Error]
} & {
  /** Emitted for every incoming result of a specific search request */
  [K in `found:${string}`]: [res: SearchResult]
}

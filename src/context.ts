import type EventEmitter from 'events'
import type Server from './server/server'
import type Session from './session'
import type Peers from './peer/peers'
import type Serving from './upload/serving'
import type Requesting from './download/requesting'
import type Searching from './search/searching'
import type Sharing from './share/sharing'
import type { SlskClientEvents } from './client-events'
import type { ServerAddress, SlskClientOptions, UploadOptions } from './types'

/**
 * What the parts of a client see of each other. Every one of them owns a piece of the work —
 * the peer connections, the upload queue, the downloads, the searches, the shares — and reaches
 * the others through this, which the client implements over its own state.
 */
export interface ClientContext {
  /** State the peers and the file transfers share */
  readonly session: Session
  /** Options the client was built with, as they were given */
  readonly options: SlskClientOptions
  /** Connection to the slsk server, replaced by every reconnection */
  readonly server: Server
  /** Address that connection is opened to */
  readonly serverAddress: ServerAddress
  readonly peers: Peers
  readonly serving: Serving
  readonly requesting: Requesting
  readonly searching: Searching
  readonly sharing: Sharing
  /** Port incoming peer connections are accepted on */
  readonly incomingPort: number
  /** ms of silence on a file connection before the transfer is asked for again */
  readonly transferTimeout: number
  /** How the shared files are served, false when this client shares without uploading */
  readonly uploadOptions: Required<UploadOptions> | false
  /** true when the shared files are sent to the peers asking for them */
  readonly servesUploads: boolean
  /** Reports something on the client itself */
  emit: EventEmitter<SlskClientEvents>['emit']
}

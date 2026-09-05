import EventEmitter from 'events'
import { LoginRefusedError } from './server/server'
import ServerLink from './server/link'
import DefaultPeer from './peer/default-peer/default-peer'
import Peers from './peer/peers'
import Shared from './share/shared'
import ShareIndex from './share/share-index'
import Sharing from './share/sharing'
import fsShareProvider from './share/providers/fs'
import memoryShareProvider from './share/providers/memory'
import Session from './session'
import Searching from './search/searching'
import Serving from './upload/serving'
import Requesting from './download/requesting'
import Download from './download/download'
import Upload from './upload/upload'
import { DownloadCancelledError, DownloadTimeoutError } from './download/errors'
import waitFor from './utils/wait-for'
import {
  DEFAULT_INCOMING_PORT,
  DEFAULT_QUEUE_LIMIT,
  DEFAULT_SERVER,
  DEFAULT_TRANSFER_TIMEOUT,
  DEFAULT_UPLOAD_SLOTS,
  PEER_TIMEOUT,
  USER_INFO_TIMEOUT
} from './defaults'
import type { ClientContext } from './context'
import type { SlskClientEvents } from './client-events'
import type {
  DownloadOptions,
  SearchOptions,
  SearchResult,
  ServerAddress,
  SlskClientOptions,
  UploadOptions,
  UserInfo
} from './types'

export * from './types'
export * from './share/provider'
export type { FsLike, FsLikeFileHandle, FsLikeStats, FsShareProviderOptions } from './share/providers/fs'
export type { MemoryShareFile } from './share/providers/memory'
export type { IndexedEntry } from './share/share-index'
export type { DownloadEvents, DownloadInit, DownloadStatus } from './download/download'
export type { UploadEvents, UploadInit, UploadStatus } from './upload/upload'
export type { LoginResult } from './server/server'
export type { SlskClientEvents } from './client-events'
export { toSearchResult } from './search/searching'
export {
  Shared,
  ShareIndex,
  Download,
  Upload,
  DownloadCancelledError,
  DownloadTimeoutError,
  LoginRefusedError,
  fsShareProvider,
  memoryShareProvider
}

/**
 * A slsk client: the connection to the server, the peers it talks to, the files it shares and
 * the transfers running in both directions. The work itself lives next to what it acts on —
 * `peer/peers.ts`, `upload/serving.ts`, `download/requesting.ts`, `search/searching.ts` and
 * `share/sharing.ts` — and they reach each other through a {@link ClientContext} this builds.
 */
export class SlskClient extends EventEmitter<SlskClientEvents> {
  /** What the parts of this client see of each other */
  private readonly ctx: ClientContext
  /** The connection to the slsk server, the login it carries and the reconnection loop */
  private readonly link: ServerLink
  /** Every connection to another peer, and how they are opened */
  private readonly peers: Peers
  /** The files this client shares and the listing of them */
  private readonly sharing: Sharing
  /** The upload queue and the transfers going out */
  private readonly serving: Serving
  /** The transfers coming in and how peers are asked for them */
  private readonly requesting: Requesting
  /** The searches sent, and the ones answered with our shares */
  private readonly searching: Searching
  /**
   * Resolves once the first share listing is over and its counts have been announced, rejects
   * when that listing failed. `login()` does not wait for it: listing a large share takes
   * minutes, and the client is usable while it runs.
   */
  readonly sharesReady: Promise<void>
  /** State the peers and the file transfers of this client share */
  private readonly session = new Session()

  constructor (readonly options: SlskClientOptions = {}) {
    super()

    this.ctx = this.buildContext()
    // the shares are built here, not on login: `shares` is documented as usable at any time
    this.sharing = new Sharing(this.ctx)
    this.serving = new Serving(this.ctx)
    this.requesting = new Requesting(this.ctx)
    this.searching = new Searching(this.ctx)
    this.peers = new Peers(this.ctx)
    this.link = new ServerLink(this.ctx)

    this.sharesReady = this.sharing.ready
  }

  /**
   * What the parts of this client are given of it. Everything is read through a getter: the
   * server connection is replaced by every reconnection, and the parts themselves only exist
   * once this returned.
   */
  private buildContext (): ClientContext {
    const client = this

    return {
      session: this.session,
      options: this.options,
      get server () { return client.link.server },
      get serverAddress () { return client.serverAddress },
      get peers () { return client.peers },
      get sharing () { return client.sharing },
      get serving () { return client.serving },
      get requesting () { return client.requesting },
      get searching () { return client.searching },
      get incomingPort () { return client.incomingPort },
      get transferTimeout () { return client.transferTimeout },
      get uploadOptions () { return client.uploadOptions },
      get servesUploads () { return client.servesUploads },
      emit: this.emit.bind(this)
    }
  }

  /** Address of the slsk server this client logs into */
  get serverAddress (): ServerAddress {
    return {
      host: this.options.host ?? DEFAULT_SERVER.host,
      port: this.options.port ?? DEFAULT_SERVER.port
    }
  }

  /** Port incoming peer connections are accepted on */
  get incomingPort (): number {
    return this.options.incomingPort ?? DEFAULT_INCOMING_PORT
  }

  /** ms of silence on a file connection before the transfer is asked for again */
  private get transferTimeout (): number {
    return this.options.transferTimeout ?? DEFAULT_TRANSFER_TIMEOUT
  }

  /** How the shared files are served, false when this client shares without uploading */
  private get uploadOptions (): Required<UploadOptions> | false {
    const option = this.options.uploads ?? false
    if (option === false) return false

    const config = option === true ? {} : option
    const slots = config.slots ?? DEFAULT_UPLOAD_SLOTS
    if (slots < 1) return false

    return { slots, queueLimit: config.queueLimit ?? DEFAULT_QUEUE_LIMIT }
  }

  /** true when the shared files are sent to the peers asking for them */
  get servesUploads (): boolean {
    return this.uploadOptions !== false
  }

  /** Files being sent to peers, queued ones included */
  get uploads (): Upload[] {
    return this.session.uploads.pending
  }

  /** What is shared with the other peers */
  get shares (): Shared {
    return this.sharing.shared
  }

  /** Downloads currently running */
  get downloads (): Download[] {
    return this.session.downloads.pending
  }

  /** Name this client logs in as, empty until `login()` is called */
  get username (): string {
    return this.session.username
  }

  /**
   * Connects to the slsk server, starts listening for incoming peer connections and logs in:
   * everything the client needs to be usable.
   * Rejects when the connection fails, the credentials are refused, or the server did not
   * answer the login after `options.timeout` ms.
   * Listing the shares is started once the login is through and is *not* waited for, see
   * {@link sharesReady} to know when peers can find our files.
   * Calling it again while a session is up does nothing: a second Login on the same connection
   * makes the server answer Relogged and drop the session.
   */
  async login (user: string, pass: string): Promise<void> {
    await this.link.login(user, pass)
  }

  /**
   * Searches for files. Slsk doesn't tell when a search is finished, so results are
   * collected until the timeout is reached and then returned all at once.
   * Individual results are also emitted as 'found' and 'found:{req}' events.
   */
  async search (obj: SearchOptions): Promise<SearchResult[]> {
    return await this.searching.search(obj)
  }

  /**
   * Lists the shares again and tells the server how much is shared, to pick up files added
   * or removed since the last listing.
   */
  async refreshShares (): Promise<void> {
    await this.sharing.refresh()
  }

  /**
   * Sends a private message to a user, through the slsk server: no connection to the peer is
   * needed, and the server keeps it for a user who is offline. Their answers arrive as
   * `private-message` events.
   *
   * The server refuses a message carrying newlines, so they are turned into spaces.
   */
  sendPrivateMessage (user: string, message: string): void {
    this.link.server.messageUser(user, message.replace(/\r/g, '').replace(/\n/g, ' '))
  }

  /**
   * Connects to a peer, directly using the address given by the server and, at the same time,
   * indirectly by asking the server to make the peer connect to us. Resolves with the peer
   * connection that answered first, rejects when none did before `timeout` ms.
   */
  async connectToUser (user: string, timeout = PEER_TIMEOUT): Promise<DefaultPeer> {
    return await this.peers.connectToUser(user, timeout)
  }

  /**
   * Asks a peer what it tells about itself: its description, its picture and how busy its
   * upload queue is. Connects to the peer when there is no connection to it yet.
   * Rejects when the peer cannot be reached or did not answer before `timeout` ms.
   */
  async getUserInfo (user: string, timeout = USER_INFO_TIMEOUT): Promise<UserInfo> {
    const connection = await this.peers.connectToUser(user)

    // the listener must be registered before the request is sent
    const answer = waitFor(connection, 'user-info', {
      timeout,
      timeoutError: new Error(`UserInfo timed out for ${user}`)
    })
    connection.userInfoRequest()

    const [info] = await answer
    return info
  }

  /**
   * Asks a peer for a file. Returns the running download right away, without waiting for the
   * peer: `await` it for the finished file, read its `stream` to get the data as it arrives, or
   * follow its events. Everything that can go wrong is reported on it, connecting included.
   *
   * A `SearchResult` is all it needs: `download(result)`, or `download({ ...result, path })`.
   */
  download (options: DownloadOptions): Download {
    return this.requesting.start(options)
  }

  /** Closes everything: the server connection, the peers, the transfers and the shares */
  destroy (): void {
    this.link.destroy()
    this.sharing.close()

    this.session.downloads.failAll(new Error('Client destroyed'))
    this.session.uploads.failAll(new Error('Client destroyed'))
    this.searching.clear()
    this.peers.destroy()
  }
}

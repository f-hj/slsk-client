import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import createDebug from 'debug'
import Server, { LoginRefusedError } from './server/server'
import DefaultPeer from './peer/default-peer/default-peer'
import DistributedPeer from './peer/distributed-peer/distributed-peer'
import FilePeer from './peer/file-peer/file-peer'
import UploadPeer from './peer/file-peer/upload-peer'
import Listen from './listen'
import Shared from './share/shared'
import ShareIndex from './share/share-index'
import fsShareProvider from './share/providers/fs'
import memoryShareProvider from './share/providers/memory'
import Session from './session'
import Download from './download/download'
import Upload from './upload/upload'
import { DownloadCancelledError, DownloadTimeoutError } from './download/errors'
import { UPLOADS_DISABLED } from './peer/default-peer/handler'
import waitFor from './utils/wait-for'
import { UploadPermission } from './types'
import type {
  FileSearchResultFile,
  FileSearchResult,
  FileSearchResultOptions
} from './peer/default-peer/messages'
import type { ShareProvider } from './share/provider'
import type {
  DownloadOptions,
  DownloadProgress,
  PeerInfo,
  QueuePlace,
  ReconnectOptions,
  SearchOptions,
  SearchResult,
  ServerAddress,
  SlskClientOptions,
  UploadOptions,
  UploadProgress,
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

const debug = createDebug('slsk:i')

/** Where a client connects when nothing else is asked for */
const DEFAULT_SERVER: ServerAddress = { host: 'server.slsknet.org', port: 2242 }
/** Port incoming peer connections are accepted on by default */
const DEFAULT_INCOMING_PORT = 2234
/** ms before the login attempt fails */
const DEFAULT_LOGIN_TIMEOUT = 10000
/** ms to wait for a peer connection, direct or relayed by the server */
const PEER_TIMEOUT = 10000
/** ms before accepting a transfer a peer announced, some peers need a beat */
const TRANSFER_ACCEPT_DELAY = 200
/** ms a peer is given to answer a UserInfoRequest */
const USER_INFO_TIMEOUT = 10000
/** How many times a transfer that stopped early is asked for again */
const DOWNLOAD_RETRIES = 3
/** ms before asking a peer for the rest of an interrupted transfer */
const RESUME_DELAY = 1000
/** ms of silence on a file connection before the transfer is considered dead */
const DEFAULT_TRANSFER_TIMEOUT = 10 * 60 * 1000
/** How many files are sent at the same time when nothing else is asked for */
const DEFAULT_UPLOAD_SLOTS = 1
/** How many files one peer may keep waiting in our queue */
const DEFAULT_QUEUE_LIMIT = 100
/** How many distributed search requests are remembered to drop the duplicates */
const MAX_SEEN_SEARCHES = 5000
/** ms to wait for any sign that a peer understands the upload queue before asking the old way */
const DEFAULT_QUEUE_FALLBACK_DELAY = 10000
/** ms before the first attempt at reconnecting to the slsk server */
const DEFAULT_RECONNECT_DELAY = 1000
/** Longest ms between two reconnection attempts, the delay doubles until it */
const DEFAULT_MAX_RECONNECT_DELAY = 60000

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

interface PendingSearch {
  query: string
  onResult: (res: SearchResult) => void
}

export class SlskClient extends EventEmitter<SlskClientEvents> {
  private server!: Server
  private listen?: Listen
  private readonly shared: Shared
  /**
   * Resolves once the first share listing is over and its counts have been announced, rejects
   * when that listing failed. `login()` does not wait for it: listing a large share takes
   * minutes, and the client is usable while it runs.
   */
  readonly sharesReady: Promise<void>
  private resolveSharesReady!: () => void
  private rejectSharesReady!: (err: Error) => void
  /** Connection to the server, opened once by `login()` */
  private initialized?: Promise<void>
  /** Login in flight or done, so a caller retrying does not send a second Login */
  private loginAttempt?: Promise<void>
  private peers: Record<string, DefaultPeer | DistributedPeer> = {}
  /** State the peers and the file transfers of this client share */
  private readonly session = new Session()
  /** Searches waiting for results, by token */
  private readonly searches = new Map<string, PendingSearch>()
  /** Distributed search requests already answered, the same one reaches us from every parent */
  private readonly seenSearches = new Set<string>()
  /** Tokens of the ConnectToPeer requests we sent, by token */
  private pendingIndirect: Record<string, (socket: net.Socket, initialData?: Buffer) => void> = {}
  /** Kept in memory to log in again after a lost connection, set once the login went through */
  private credentials?: { user: string, pass: string }
  private destroyed = false
  /** true while the reconnection loop runs, so a failed attempt does not start a second one */
  private reconnecting = false
  /** Cuts the wait between two reconnection attempts short when the client is destroyed */
  private cancelPause?: () => void

  constructor (readonly options: SlskClientOptions = {}) {
    super()

    // built here, not on login: `shares` is documented as usable at any time, and a provider
    // added before logging in must not be thrown away
    this.shared = new Shared()
    this.shareProviders.forEach(provider => this.shared.addProvider(provider))

    this.sharesReady = new Promise<void>((resolve, reject) => {
      this.resolveSharesReady = resolve
      this.rejectSharesReady = reject
    })
    // nobody has to await it, the events report the same thing
    this.sharesReady.catch(() => {})
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

  /** How a lost server connection is picked up again, false when the caller does it itself */
  private get reconnectOptions (): Required<ReconnectOptions> | false {
    const option = this.options.reconnect ?? true
    if (option === false) return false

    const config = option === true ? {} : option
    const retries = config.retries ?? Infinity
    if (retries < 1) return false

    return {
      retries,
      delay: config.delay ?? DEFAULT_RECONNECT_DELAY,
      maxDelay: config.maxDelay ?? DEFAULT_MAX_RECONNECT_DELAY
    }
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

  /** Share providers given in the options, whether one or several were passed */
  private get shareProviders (): ShareProvider[] {
    const shares = this.options.shares
    if (!shares) return []
    return Array.isArray(shares) ? shares : [shares]
  }

  /** What is shared with the other peers */
  get shares (): Shared {
    return this.shared
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
   * Connects to the slsk server and starts listening for incoming peer connections.
   * Called by `login()`, once however many times it is called.
   */
  private init (): Promise<void> {
    if (!this.initialized) this.initialized = this.initialize()
    return this.initialized
  }

  private async initialize (): Promise<void> {
    debug('Init client')
    await this.connectServer()
    this.startListening()
  }

  /**
   * Opens the connection to the slsk server and wires what it reports. Called again by the
   * reconnection loop, which is why nothing but the connection itself is set up here.
   */
  private async connectServer (): Promise<void> {
    const server = new Server(this.serverAddress)
    this.server = server

    server.on('socket-error', err => {
      this.emit('server-error', err)
    })

    server.on('close', () => {
      this.onServerClose(server)
    })

    server.on('connect-to-peer', peer => {
      this.connectToPeer(peer)
    })

    // the session is gone, not the connection: a new login is needed, and whatever logs in with
    // the same name has to stop first or the two keep kicking each other off
    server.on('relogged', () => {
      this.loginAttempt = undefined
      this.emit('relogged')
    })

    server.on('get-peer-address', peer => {
      if (this.peers[peer.user]) {
        this.peers[peer.user].setAddress(peer.host as string, peer.port as number)
      } else {
        this.peers[peer.user] = this.createDefaultPeer(net.createConnection({
          host: peer.host,
          port: peer.port as number
        }), peer)
      }
    })

    // the server could not reach a peer it was asked to connect to us
    server.on('cant-connect-to-peer', evt => {
      const download = this.session.downloads.byTransferToken(evt.token)
      if (download) download.fail(new Error(`Cannot connect to ${download.user}`))
    })

    // a new connection knows nothing about us, both are queued until the login goes through
    if (this.listen) server.setWaitPort(this.incomingPort)
    // nothing yet on the first connection, the first listing announces the real counts
    this.announceShares()

    await server.ready
  }

  /** The server connection dropped: report it and log in again, unless the caller said not to */
  private onServerClose (server: Server): void {
    // a connection we already replaced, or one the reconnection loop just gave up on
    if (this.server !== server || this.reconnecting || this.destroyed) return

    // the session went with the connection, so a caller asking to log in again is not a caller
    // retrying a login that already went through
    this.loginAttempt = undefined

    const reconnecting = this.credentials !== undefined && this.reconnectOptions !== false
    debug(`server connection lost${reconnecting ? ', logging in again' : ''}`)
    this.emit('server-disconnect', { reconnecting })

    if (reconnecting) void this.reconnectServer()
  }

  /** Connects and logs in again after the server dropped us, waiting longer after every failure */
  private async reconnectServer (): Promise<void> {
    const config = this.reconnectOptions
    const credentials = this.credentials
    if (!config || !credentials) return

    this.reconnecting = true
    try {
      for (let attempt = 1; attempt <= config.retries; attempt++) {
        await this.pause(Math.min(config.delay * 2 ** (attempt - 1), config.maxDelay))
        if (this.destroyed) return

        try {
          await this.connectServer()
          await this.sendLogin(credentials.user, credentials.pass)
          debug(`logged in again after ${attempt} attempt(s)`)
          this.emit('server-reconnect')
          return
        } catch (err) {
          debug(`reconnection attempt ${attempt} failed: ${String(err)}`)
          this.server.destroy()

          if (err instanceof LoginRefusedError) {
            // retrying refused credentials would only hammer the server
            this.credentials = undefined
            this.emit('server-error', err)
            this.emit('server-disconnect', { reconnecting: false })
            return
          }
        }
      }

      this.emit('server-error', new Error(
        `Cannot reconnect to the slsk server, gave up after ${config.retries} attempts`
      ))
      this.emit('server-disconnect', { reconnecting: false })
    } finally {
      this.reconnecting = false
    }
  }

  /** Waits, without keeping the process alive and without outliving a destroyed client */
  private async pause (ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      timer.unref()
      this.cancelPause = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    this.cancelPause = undefined
  }

  /** Accepts the connections peers open to us, to browse our shares or to send us a file */
  private startListening (): void {
    this.listen = new Listen(this.incomingPort)

    this.listen.on('socket-error', err => {
      this.emit('listen-error', err)
    })

    this.listen.on('new-peer', evt => {
      const peer = evt.peer
      if (this.isOurOwnName(peer.user)) {
        this.dropSelfConnection(evt.socket, peer.user)
      } else if (this.peers[peer.user]) {
        debug(`already connected to ${peer.user}, dropping the connection it just opened` +
          `${evt.initialData ? ` and the ${evt.initialData.length} bytes it sent on it` : ''}`)
      } else {
        this.server.getPeerAddress(peer.user)
        debug(`new Peer connected ${peer.user} token ${peer.token}`)
        this.peers[peer.user] = this.createDefaultPeer(evt.socket, peer, evt.initialData)
      }
    })

    // a peer starts sending a file it queued for us
    this.listen.on('file-transfer', evt => {
      if (this.isOurOwnName(evt.user)) {
        this.dropSelfConnection(evt.socket, evt.user)
        return
      }
      debug(`incoming file transfer from ${evt.user}`)
      new FilePeer(evt.socket, { user: evt.user, type: 'F' }, {
        session: this.session,
        readToken: true,
        initialData: evt.initialData,
        transferTimeout: this.transferTimeout
      })
    })

    // answer of a peer the server asked to connect to us
    this.listen.on('pierce-firewall', evt => {
      const pending = this.pendingIndirect[evt.token]
      if (!pending) {
        debug(`unexpected PierceFirewall token ${evt.token}, closing`)
        evt.socket.destroy()
        return
      }
      delete this.pendingIndirect[evt.token]
      pending(evt.socket, evt.initialData)
    })

    this.server.setWaitPort(this.incomingPort)
  }

  /**
   * true when an incoming connection introduces itself with the name we logged in as. A PeerInit
   * carries the name of whoever opened the connection, and that name is ours on the network, so
   * the only things that send it are this client reaching its own address and a peer lying about
   * who it is.
   */
  private isOurOwnName (user: string): boolean {
    return this.session.username !== '' && user === this.session.username
  }

  /**
   * Closes such a connection. Keeping it would put us in our own peer map, where a search answer
   * or a download would then be sent to ourselves instead of to the peer that asked.
   */
  private dropSelfConnection (socket: net.Socket, user: string): void {
    debug(`a connection introduced itself as ${user}, which is the name we logged in as: closing it`)
    socket.destroy()
  }

  /**
   * Lists the shares again and tells the server how much is shared, to pick up files added
   * or removed since the last listing.
   */
  async refreshShares (): Promise<void> {
    await this.shared.refresh()
    this.announceShares()
  }

  private announceShares (): void {
    const stats = this.shared.stats()
    debug(`sharing ${stats.files} files in ${stats.folders} folders`)
    if (!this.server) {
      debug('not connected yet, the counts go out with the login')
      return
    }
    this.server.sharedFoldersFiles(stats.folders, stats.files)
  }

  /**
   * Lists the providers and announces what they hold. Runs in the background of the login: a
   * few thousand files on a slow volume take minutes, and the slsk server drops a connection
   * that stays unauthenticated that long.
   */
  private async listShares (): Promise<void> {
    try {
      await this.shared.refresh()
      this.announceShares()
      this.emit('shares-ready', this.shared.stats())
      this.resolveSharesReady()
    } catch (err) {
      debug(`cannot list the shares: ${String(err)}`)
      this.emit('shares-error', err as Error)
      this.rejectSharesReady(err as Error)
    }
  }

  private createDefaultPeer (socket: net.Socket, peer: PeerInfo, initialData?: Buffer): DefaultPeer {
    const defaultPeer = new DefaultPeer(socket, peer, {
      session: this.session,
      shared: this.shared,
      initialData,
      // read every time a peer asks: the slots and the queue change while we run
      userInfo: () => ({ ...this.uploadCapacity(), ...this.options.userInfo }),
      uploads: this.servesUploads
    })

    defaultPeer.on('socket-error', err => this.emit('peer-error', err, peer.user))
    defaultPeer.on('disconnect', () => {
      if (this.peers[peer.user] === defaultPeer) delete this.peers[peer.user]
    })

    defaultPeer.on('search-result', result => this.handleSearchResult(result))
    defaultPeer.on('transfer-request', evt => this.handleTransferRequest(defaultPeer, evt))
    defaultPeer.on('transfer-response', evt => this.handleTransferResponse(defaultPeer, evt))
    // only a peer that speaks the queue flow answers any of these three
    defaultPeer.on('place-in-queue', evt => {
      defaultPeer.supportsQueue = true
      this.session.downloads.get(peer.user, evt.file)?.queued(evt.place)
    })
    defaultPeer.on('upload-failed', file => {
      defaultPeer.supportsQueue = true
      this.failDownload(peer.user, file, new Error('Peer error'))
    })
    defaultPeer.on('upload-denied', evt => {
      defaultPeer.supportsQueue = true
      this.failDownload(peer.user, evt.file, new Error(evt.reason || 'Upload denied'))
    })

    // a peer asking for one of our files, only reported when this client serves them
    defaultPeer.on('queue-upload', file => {
      this.queueUpload(defaultPeer, file)
        .catch((err: Error) => debug(`cannot queue ${file} for ${peer.user}: ${err.message}`))
    })
    defaultPeer.on('place-in-queue-request', file => {
      const upload = this.session.uploads.get(peer.user, file)
      if (!upload) {
        debug(`${peer.user} asks its place for ${file}, which is not queued`)
        return
      }
      defaultPeer.placeInQueueResponse(file, this.session.uploads.placeInQueue(upload))
    })

    return defaultPeer
  }

  /**
   * What we tell peers about our upload capacity, in a UserInfoResponse and next to every search
   * answer. A client that does not serve its files says so, instead of advertising a free slot
   * and denying every peer that picks it for it.
   */
  private uploadCapacity (): {
    uploadSlots: number
    queueSize: number
    slotsFree: boolean
    uploadPermitted: UploadPermission
  } {
    const config = this.uploadOptions
    const uploads = this.session.uploads

    return {
      uploadSlots: config ? config.slots : 0,
      queueSize: uploads.waiting.length,
      slotsFree: config ? uploads.active.length < config.slots : false,
      uploadPermitted: config ? UploadPermission.Everyone : UploadPermission.NoOne
    }
  }

  /**
   * A peer asked for one of our files: checks it is really shared and puts it in the queue,
   * which is emptied one slot at a time. Nothing is sent back when the file is accepted, the
   * peer learns about it when the transfer is announced or when it asks for its place.
   */
  private async queueUpload (peer: DefaultPeer, file: string): Promise<void> {
    const config = this.uploadOptions
    if (!config) {
      peer.uploadDenied(file, UPLOADS_DISABLED)
      return
    }

    const uploads = this.session.uploads
    const running = uploads.get(peer.user, file)
    if (running) {
      debug(`${peer.user} asks again for ${file}, already ${running.status}`)
      return
    }

    // resolved against the index, so a crafted path cannot reach anything we do not share
    const indexed = this.shared.resolve(file)
    if (!indexed) {
      debug(`${peer.user} wants ${file}, which is not shared`)
      peer.uploadDenied(file, 'File not shared.')
      return
    }

    if (uploads.waitingFor(peer.user) >= config.queueLimit) {
      debug(`${peer.user} has ${config.queueLimit} files waiting already`)
      peer.uploadDenied(file, 'Too many files')
      return
    }

    const upload = uploads.queue({
      user: peer.user,
      file,
      entry: indexed.entry,
      provider: indexed.provider
    })

    upload.on('progress', progress => this.emit('upload-progress', progress))
    upload.once('complete', evt => {
      this.emit('upload-complete', { user: upload.user, file, sentBytes: evt.sentBytes })
      this.serveNextInQueue()
    })
    upload.once('failed', error => {
      this.emit('upload-failed', { user: upload.user, file, error })
      // the peer is waiting for a transfer that will not come, or for a file it never gets
      if (upload.token) peer.uploadFailed(file)
      this.serveNextInQueue()
    })

    this.emit('upload-queued', { user: peer.user, file, place: uploads.placeInQueue(upload) })
    await this.serveQueue()
  }

  /** Serves the queue when a slot frees, from a listener that cannot await it */
  private serveNextInQueue (): void {
    this.serveQueue()
      .catch((err: Error) => debug(`cannot serve the upload queue: ${err.message}`))
  }

  /** Announces as many queued files as there are free slots, oldest request first */
  private async serveQueue (): Promise<void> {
    const config = this.uploadOptions
    if (!config) return

    const uploads = this.session.uploads
    while (uploads.active.length < config.slots) {
      const next = uploads.waiting[0]
      if (!next) return

      await this.announceUpload(next)
    }
  }

  /**
   * Tells the peer the file is coming, with the size the provider reports now: an entry indexed
   * a while ago may point at a file that changed since, and the size announced here is the one
   * the transfer is measured against.
   */
  private async announceUpload (upload: Upload): Promise<void> {
    const peer = this.peerConnection(upload.user)
    if (!peer) {
      // it asked on a connection that is gone, it will ask again when it comes back
      upload.fail(new Error(`No peer connection to ${upload.user}`))
      return
    }

    let size = upload.entry.size
    if (upload.provider.stat) {
      try {
        const stat = await upload.provider.stat(upload.entry)
        if (!stat) {
          upload.fail(new Error(`${upload.file} is gone`))
          peer.uploadDenied(upload.file, 'File not shared.')
          return
        }
        size = stat.size
      } catch (err) {
        upload.fail(new Error(`Cannot stat ${upload.file}: ${String(err)}`))
        peer.uploadDenied(upload.file, 'File read error.')
        return
      }
    }

    const token = crypto.randomBytes(4).toString('hex')
    this.session.uploads.bindToken(token, upload)
    upload.requested(token, size)
    peer.uploadRequest(upload.file, token, size)
  }

  /** The peer accepted a transfer we announced: open the file connection and send the bytes */
  private startUpload (peer: DefaultPeer, upload: Upload): void {
    const token = upload.token as string

    if (peer.peer.host && peer.peer.port) {
      UploadPeer.open({
        host: peer.peer.host,
        port: peer.peer.port,
        session: this.session,
        upload,
        transferTimeout: this.transferTimeout
      })
      return
    }

    /*
     * No address for the peer: ask the server to make it connect to us instead, on a connection
     * of type F, and send the bytes on the one it pierces our firewall with.
     */
    debug(`no address for ${upload.user}, asking the server to relay a file connection`)

    const gaveUp = setTimeout(() => {
      if (!this.pendingIndirect[token]) return
      delete this.pendingIndirect[token]
      upload.fail(new Error(`${upload.user} never opened the file connection`))
    }, PEER_TIMEOUT)
    gaveUp.unref()

    this.pendingIndirect[token] = (socket, initialData) => {
      clearTimeout(gaveUp)
      new UploadPeer(socket, { user: upload.user, type: 'F', token }, {
        session: this.session,
        upload,
        initialData,
        transferTimeout: this.transferTimeout
      })
    }
    this.server.connectToPeer(token, upload.user, 'F')
  }

  private failDownload (user: string, file: string, err: Error): void {
    const download = this.session.downloads.get(user, file)
    if (!download) {
      debug(`Cannot reject download for ${user} ${file}`)
      return
    }
    download.fail(err)
  }

  /** A peer announced a transfer: accept the ones we asked for, refuse the rest */
  private handleTransferRequest (
    peer: DefaultPeer,
    evt: { direction: number, token: string, file: string, size?: number }
  ): void {
    if (evt.direction !== 1) {
      if (!this.servesUploads) {
        debug(`${peer.user} asks to download ${evt.file}, uploads are disabled`)
        peer.transferResponse(evt.token, false, UPLOADS_DISABLED)
        return
      }

      /*
       * A peer asking the old way, before QueueUpload existed. Answering `allowed` would let a
       * peer that spoofed the request open the file connection itself, so the request goes
       * through the queue like any other and the answer is the 'Queued' refusal every current
       * client uses: the transfer is then announced with our own token.
       */
      debug(`${peer.user} asks to download ${evt.file} the old way, queueing it`)
      peer.transferResponse(evt.token, false, 'Queued')
      void this.queueUpload(peer, evt.file)
      return
    }

    const download = this.session.downloads.get(peer.peer.user, evt.file)
    if (!download) {
      debug(`${peer.peer.user} announces ${evt.file}, which we did not ask for`)
      peer.transferResponse(evt.token, false, 'Cancelled')
      return
    }

    this.session.downloads.bindToken(evt.token, download)
    download.announced(evt.size)
    setTimeout(() => peer.transferResponse(evt.token, true), TRANSFER_ACCEPT_DELAY)
  }

  /** The peer answered a transfer: one we asked for, or one we announced to it */
  private handleTransferResponse (
    peer: DefaultPeer,
    evt: { token: string, allowed: boolean, reason?: string }
  ): void {
    const upload = this.session.uploads.byTransferToken(evt.token)
    if (upload) {
      this.handleUploadResponse(peer, upload, evt)
      return
    }

    const download = this.session.downloads.byTransferToken(evt.token)

    if (!evt.allowed) {
      const reason = evt.reason ?? ''
      // the token we picked is only ever used by a peer that starts the transfer itself
      this.session.downloads.forgetToken(evt.token)

      if (isQueuedReason(reason)) {
        // the peer will announce the transfer with its own token once a slot frees
        debug(`${peer.peer.user} queued ${download?.file ?? evt.token}`)
        if (download) {
          download.setStatus('queued')
          // pointless towards a peer that already ignored a place request
          if (peer.supportsQueue !== false) peer.placeInQueueRequest(download.file)
        }
        return
      }

      debug(`${peer.peer.user} refused the transfer: ${reason || 'no reason'}`)
      download?.fail(new Error(reason || 'Transfer refused'))
      return
    }

    if (!download) {
      debug(`${peer.peer.user} allowed the unknown transfer ${evt.token}`)
      return
    }

    if (!peer.peer.host || !peer.peer.port) {
      // nothing to connect to, and net.createConnection would throw on the missing port
      download.fail(new Error(`No address to reach ${peer.user}`))
      return
    }

    debug(`Directly allowed. Connecting to ${peer.user} with PeerInit + ${evt.token}`)
    FilePeer.open({
      host: peer.peer.host,
      port: peer.peer.port,
      token: evt.token,
      user: peer.user,
      session: this.session,
      handshake: 'init',
      // introducing ourselves is enough, the uploader waits for our offset
      offsetDelay: 1000,
      transferTimeout: this.transferTimeout
    })
  }

  /**
   * What the peer answered to a file we announced. A refusal frees the slot for the next one in
   * the queue: 'Complete' is a peer telling us it has the file after all, everything else is a
   * transfer that will not happen.
   */
  private handleUploadResponse (
    peer: DefaultPeer,
    upload: Upload,
    evt: { token: string, allowed: boolean, reason?: string }
  ): void {
    if (!evt.allowed) {
      const reason = evt.reason ?? ''
      debug(`${peer.user} refused ${upload.file}: ${reason || 'no reason'}`)
      upload.fail(new Error(`${peer.user} refused the file: ${reason || 'no reason'}`))
      return
    }

    debug(`${peer.user} accepted ${upload.file}, opening the file connection`)
    this.startUpload(peer, upload)
  }

  /** Files a peer sent back for one of our searches */
  private handleSearchResult (result: FileSearchResult): void {
    const search = this.searches.get(result.currentToken)
    if (!search) {
      // a search that already returned, or a token we never asked for
      debug(`dropping ${result.files.length} results of the unknown search ${result.currentToken}`)
      return
    }

    result.files.forEach(file => {
      search.onResult(toSearchResult(file, result))
    })
  }

  private connectToPeer (peer: PeerInfo): void {
    debug(`connectToPeer ${peer.user} ${peer.host} ${peer.port} ${peer.token} ${peer.type}`)

    switch (peer.type) {
      case 'F': {
        FilePeer.open({
          host: peer.host as string,
          port: peer.port as number,
          token: peer.token as string,
          user: peer.user,
          session: this.session,
          handshake: 'pierce',
          // the uploader announces the transfer with its own token
          readToken: true,
          transferTimeout: this.transferTimeout
        })
        break
      }
      case 'D': {
        const distributedPeer = new DistributedPeer(net.createConnection({
          host: peer.host,
          port: peer.port as number
        }), peer, { session: this.session })
        this.peers[peer.user] = distributedPeer
        distributedPeer.on('socket-error', err => this.emit('peer-error', err, peer.user))
        distributedPeer.on('search', search => {
          this.answerSearchRequest(search.user, search.ticket, search.query)
            .catch(err => debug(`cannot answer the search of ${search.user}: ${String(err)}`))
        })
        distributedPeer.on('branch-level', level => {
          // we have a parent, tell the server where we sit in the distributed network
          this.server.haveNoParents(false)
          this.server.branchLevel(level + 1)
        })
        distributedPeer.on('branch-root', root => {
          this.server.branchRoot(root)
        })
        distributedPeer.on('disconnect', () => {
          if (this.peers[peer.user] === distributedPeer) delete this.peers[peer.user]
          this.server.haveNoParents(true)
        })
        break
      }
      default: {
        this.peers[peer.user] = this.createDefaultPeer(net.createConnection({
          host: peer.host,
          port: peer.port as number
        }), peer)
      }
    }
  }

  /** Answers a search request received from the distributed network with our shares */
  private async answerSearchRequest (user: string, ticket: string, query: string): Promise<void> {
    if (!this.rememberSearchRequest(`${user}_${ticket}_${query}`)) return

    const matched = await this.shared.search(query)
    if (matched.length === 0) return

    debug(`Search from peer ${user}, query: ${query}. Matched: ${matched.length} files`)

    const existing = this.peerConnection(user)
    if (existing) {
      existing.fileSearchResult(matched, ticket, this.session.username)
      return
    }

    /*
     * Most searchers cannot accept a connection: they are behind a router that forwards
     * nothing. Asking the server for their address and connecting to it only works for the
     * few that are reachable, so the answer goes through connectToUser, which also asks the
     * server to make the peer connect to us.
     */
    const connection = await this.connectToUser(user)
    if (!(connection instanceof DefaultPeer)) {
      throw new Error(`No peer connection to ${user}`)
    }
    connection.fileSearchResult(matched, ticket, this.session.username, this.searchAnswerState())
  }

  /**
   * Slots and queue length sent with a search answer: what a searcher uses to pick the source it
   * asks first, so a client with nothing free must not claim a free slot.
   */
  private searchAnswerState (): FileSearchResultOptions {
    const capacity = this.uploadCapacity()
    return { slotsFree: capacity.slotsFree, queueLength: capacity.queueSize }
  }

  /**
   * Peer connection (type P) to a user, when there is one: the connection to a distributed
   * parent carries searches, not the messages a peer connection understands.
   */
  private peerConnection (user: string): DefaultPeer | undefined {
    const peer = this.peers[user]
    return peer instanceof DefaultPeer ? peer : undefined
  }

  /** false when this exact search request was already answered */
  private rememberSearchRequest (key: string): boolean {
    if (this.seenSearches.has(key)) return false

    this.seenSearches.add(key)
    if (this.seenSearches.size > MAX_SEEN_SEARCHES) {
      // a Set keeps the insertion order, the first key is the oldest one
      const oldest = this.seenSearches.values().next().value
      if (oldest !== undefined) this.seenSearches.delete(oldest)
    }
    return true
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
    // a caller retrying a login is common, sending Login twice is what gets us relogged
    if (this.loginAttempt) return await this.loginAttempt

    this.loginAttempt = this.attemptLogin(user, pass)
    try {
      await this.loginAttempt
    } catch (err) {
      // a failed attempt must not stop the caller from trying again
      this.loginAttempt = undefined
      throw err
    }
  }

  /** Everything a login needs around the credentials themselves */
  private async attemptLogin (user: string, pass: string): Promise<void> {
    await this.init()

    // logging in again after the connection was lost: that socket will not come back
    if (!this.server.connected && !this.reconnecting) await this.connectServer()

    if (this.server.isLoggedIn) {
      debug(`already logged in as ${this.session.username}, not sending Login again`)
      return
    }

    await this.sendLogin(user, pass)

    // only a working session is worth reconnecting, credentials the server refused are not
    this.credentials = { user, pass }

    // the shares are listed once the session exists, and on their own time
    void this.listShares()
  }

  /** Sends the credentials and waits for the answer of the server */
  private async sendLogin (user: string, pass: string): Promise<void> {
    // peers we talk to before the answer comes back must know how to introduce us
    this.session.username = user

    // the listener must be registered before the request is sent
    const answer = waitFor(this.server, 'login', {
      timeout: this.options.timeout ?? DEFAULT_LOGIN_TIMEOUT,
      timeoutError: new Error('timeout login')
    })
    this.server.login({ user, pass })

    const [result] = await answer
    if (!result.success) throw new LoginRefusedError(result.reason)
  }

  /**
   * Searches for files. Slsk doesn't tell when a search is finished, so results are
   * collected until the timeout is reached and then returned all at once.
   * Individual results are also emitted as 'found' and 'found:{req}' events.
   */
  async search (obj: SearchOptions): Promise<SearchResult[]> {
    const token = crypto.randomBytes(4).toString('hex')
    const timeout = obj.timeout || 4000
    const results: SearchResult[] = []

    this.searches.set(token, {
      query: obj.req,
      onResult: res => {
        this.emit('found', res)
        this.emit(`found:${obj.req}`, res)
        results.push(res)
      }
    })

    try {
      this.server.fileSearch(obj.req, token)
      await new Promise<void>(resolve => setTimeout(resolve, timeout))
      return results
    } finally {
      this.searches.delete(token)
    }
  }

  /**
   * Connects to a peer, directly using the address given by the server and, at the same time,
   * indirectly by asking the server to make the peer connect to us. Resolves with the peer
   * connection that answered first, rejects when none did before `timeout` ms.
   */
  async connectToUser (user: string, timeout = PEER_TIMEOUT): Promise<DefaultPeer | DistributedPeer> {
    const existing = this.peers[user]
    if (existing) return existing

    const token = crypto.randomBytes(4).toString('hex')

    try {
      return await Promise.any([
        this.connectDirect(user, timeout),
        this.connectIndirect(user, token, timeout)
      ])
    } catch {
      this.server.cantConnectToPeer(token, user)
      throw new Error('User not exist')
    } finally {
      delete this.pendingIndirect[token]
    }
  }

  /** Asks the server for the address of the peer and connects to it */
  private async connectDirect (
    user: string,
    timeout: number
  ): Promise<DefaultPeer | DistributedPeer> {
    const answer = waitFor(this.server, 'get-peer-address', {
      timeout,
      timeoutError: new Error(`GetPeerAddress timed out for ${user}`),
      match: peer => peer.user === user
    })
    this.server.getPeerAddress(user)

    const [address] = await answer
    // the slsk server answers port 0 for a user that is not connected
    if (!address.port) throw new Error(`${user} is not connected`)

    // the 'get-peer-address' handler created the peer with the address we just received
    const peer = this.peers[user]
    if (!peer) throw new Error(`No connection to ${user}`)
    await peer.ready
    return peer
  }

  /** Asks the server to make the peer connect to us */
  private async connectIndirect (
    user: string,
    token: string,
    timeout: number
  ): Promise<DefaultPeer | DistributedPeer> {
    const pierced = new Promise<DefaultPeer>(resolve => {
      // the peer pierces our firewall on the listening port
      this.pendingIndirect[token] = (socket, initialData) => {
        debug(`${user} pierced our firewall with token ${token}`)
        const peer = this.createDefaultPeer(socket, { user, type: 'P' }, initialData)
        this.peers[user] = peer
        resolve(peer)
      }
    })

    const relayed = waitFor(this.server, 'connect-to-peer', {
      timeout,
      timeoutError: new Error(`ConnectToPeer timed out for ${user}`),
      match: peer => peer.user === user && peer.type !== 'F'
    }).then(() => {
      // the 'connect-to-peer' handler connected to the peer
      const peer = this.peers[user]
      if (!peer) throw new Error(`No connection to ${user}`)
      return peer
    })

    this.server.connectToPeer(token, user, 'P')

    return await Promise.race([pierced, relayed])
  }

  /**
   * Asks a peer what it tells about itself: its description, its picture and how busy its
   * upload queue is. Connects to the peer when there is no connection to it yet.
   * Rejects when the peer cannot be reached or did not answer before `timeout` ms.
   */
  async getUserInfo (user: string, timeout = USER_INFO_TIMEOUT): Promise<UserInfo> {
    const connection = await this.connectToUser(user)
    if (!(connection instanceof DefaultPeer)) {
      throw new Error(`No peer connection to ${user}`)
    }

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
    const { user, file } = options
    if (!user || !file) throw new Error('download() needs the user and the file to download')

    const download = this.session.downloads.start({
      user,
      file,
      path: options.path,
      offset: options.offset,
      expectedSize: options.size,
      timeout: options.timeout ?? this.options.downloadTimeout,
      signal: options.signal
    })

    download.on('progress', progress => this.emit('download-progress', progress))
    download.on('queue', place => this.emit('download-queue', { user, file, place }))
    download.on('interrupted', evt => {
      this.emit('download-interrupted', { user, file, ...evt })
      this.resumeDownload(download)
    })

    // asking on the next tick, so a caller that cancels right away asks the peer for nothing
    queueMicrotask(() => {
      if (download.isSettled) return
      this.requestDownload(download)
        .catch((err: Error) => download.fail(err))
    })

    return download
  }

  /**
   * Asks for the rest of a transfer that stopped early. The file is asked for the same way it
   * was the first time, and the offset sent to the peer is everything received so far, so
   * nothing already downloaded is asked for twice.
   */
  private resumeDownload (download: Download): void {
    const attempts = this.options.downloadRetries ?? DOWNLOAD_RETRIES
    if (download.attempts > attempts) {
      download.fail(new Error(
        `Transfer interrupted at ${download.receivedBytes}/${download.size ?? '?'} bytes,` +
        ` gave up after ${attempts} ${attempts === 1 ? 'retry' : 'retries'}`
      ))
      return
    }

    // the token of the attempt that just died must not resolve anything anymore
    this.session.downloads.forgetTokensOf(download)

    debug(`resume ${download.user} ${download.file} at ${download.receivedBytes}, ` +
      `attempt ${download.attempts}/${attempts}`)

    const retry = setTimeout(() => {
      if (download.isSettled) return
      // the peer connection is often gone too, requestDownload opens a new one when needed
      this.requestDownload(download)
        .catch((err: Error) => download.fail(err))
    }, RESUME_DELAY)
    // a transfer waiting to be asked for again must not keep the process alive
    retry.unref()
  }

  /**
   * Connects to the peer and asks it for the file: QueueUpload (43) + PlaceInQueueRequest (51),
   * the flow of every current client, and the legacy TransferRequest (40, direction 0) for the
   * peers that do not understand it. Nothing on the wire tells the two apart, so a peer that
   * answers nothing at all is asked again the old way, and remembered as such.
   */
  private async requestDownload (download: Download): Promise<void> {
    const { user, file } = download
    debug(`launch download ${user} ${file}`)

    const peer = this.peers[user] ?? await this.connectToUser(user)
    if (!(peer instanceof DefaultPeer)) {
      throw new Error(`No peer connection to ${user}`)
    }
    // cancelled or replaced while we were connecting, asking for it now would download it twice
    if (download.isSettled) return

    if (peer.supportsQueue === false) {
      this.legacyTransferRequest(peer, download)
      return
    }

    peer.queueUpload(file)
    peer.placeInQueueRequest(file)

    if (peer.supportsQueue !== true) this.fallBackWhenSilent(peer, download)
  }

  /**
   * Asks a peer that ignored the queue request for the file the way clients did before the
   * queue existed: it either starts the transfer right away or answers a refusal, so a download
   * cannot stay stuck on a message the peer never understood.
   */
  private fallBackWhenSilent (peer: DefaultPeer, download: Download): void {
    const delay = this.options.queueFallbackDelay ?? DEFAULT_QUEUE_FALLBACK_DELAY

    const fallback = setTimeout(() => {
      // anything the peer answers changes the status, silence leaves it untouched
      if (download.status !== 'requested' || peer.supportsQueue === true) return

      debug(`${peer.user} answered nothing about its queue, asking the old way`)
      peer.supportsQueue = false
      this.legacyTransferRequest(peer, download)
    }, delay)
    // a download waiting for a peer must not be a reason for the process to stay alive
    fallback.unref()

    download.once('status', () => clearTimeout(fallback))
  }

  /** TransferRequest (40, direction 0): we pick the token and ask for the transfer ourselves */
  private legacyTransferRequest (peer: DefaultPeer, download: Download): void {
    const token = crypto.randomBytes(4).toString('hex')
    this.session.downloads.bindToken(token, download)
    peer.transferRequest(download.file, token)
  }

  destroy (): void {
    this.destroyed = true
    this.cancelPause?.()
    this.credentials = undefined

    if (this.server) this.server.destroy()
    if (this.listen) this.listen.destroy()
    if (this.shared) {
      this.shared.close().catch(err => debug(`cannot close the shares: ${String(err)}`))
    }

    this.session.downloads.failAll(new Error('Client destroyed'))
    this.session.uploads.failAll(new Error('Client destroyed'))
    this.searches.clear()

    Object.keys(this.peers).forEach(peer => {
      this.peers[peer].destroy()
    })
  }
}

/**
 * true when a peer refused a transfer only to queue it: 'Queued' is what the protocol prescribes,
 * clients write it with or without a trailing dot. Every other reason is a refusal for good
 * ('Queue full', 'File not shared', 'Banned'...).
 */
function isQueuedReason (reason: string): boolean {
  return reason.trim().toLowerCase().startsWith('queued')
}

/** Turns a file of a FileSearchResult into what the search API exposes */
export function toSearchResult (file: FileSearchResultFile, result: FileSearchResult): SearchResult {
  return {
    user: file.user,
    file: file.file,
    size: file.size,
    slots: result.slots === 1,
    // as they came: what a peer sends about a file is its own business, including unknown codes
    attribs: file.attribs,
    speed: result.speed,
    queueLength: result.queueLength
  }
}

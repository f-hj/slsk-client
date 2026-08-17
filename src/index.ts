import EventEmitter from 'events'
import crypto from 'crypto'
import { PassThrough, type Readable } from 'stream'
import net from 'net'
import createDebug from 'debug'
import Server from './server/server'
import DefaultPeer from './peer/default-peer/default-peer'
import DistributedPeer from './peer/distributed-peer/distributed-peer'
import FilePeer from './peer/file-peer/file-peer'
import Listen from './listen'
import Shared from './share/shared'
import ShareIndex from './share/share-index'
import fsShareProvider from './share/providers/fs'
import memoryShareProvider from './share/providers/memory'
import Session from './session'
import Download from './download/download'
import waitFor from './utils/wait-for'
import { FileAttribute } from './types'
import type { FileSearchResultFile, FileSearchResult } from './peer/default-peer/messages'
import type { ShareEntry, ShareProvider } from './share/provider'
import type {
  DownloadOptions,
  DownloadProgress,
  DownloadResult,
  PeerInfo,
  QueuePlace,
  SearchOptions,
  SearchResult,
  ServerAddress,
  SlskClientOptions,
  UserInfo
} from './types'

export * from './types'
export * from './share/provider'
export type { FsLike, FsLikeFileHandle, FsLikeStats, FsShareProviderOptions } from './share/providers/fs'
export type { MemoryShareFile } from './share/providers/memory'
export type { IndexedEntry } from './share/share-index'
export type { DownloadEvents, DownloadInit, DownloadStatus } from './download/download'
export type { LoginResult } from './server/server'
export { Shared, ShareIndex, Download, fsShareProvider, memoryShareProvider }

const debug = createDebug('slsk:i')

/** Where a client connects when nothing else is asked for */
const DEFAULT_SERVER: ServerAddress = { host: 'server.slsknet.org', port: 2242 }
/** Port incoming peer connections are accepted on by default */
const DEFAULT_INCOMING_PORT = 2234
/** ms before the login attempt fails */
const DEFAULT_LOGIN_TIMEOUT = 2000
/** ms to wait for a peer connection, direct or relayed by the server */
const PEER_TIMEOUT = 10000
/** ms before accepting a transfer a peer announced, some peers need a beat */
const TRANSFER_ACCEPT_DELAY = 200
/** ms a peer is given to answer a UserInfoRequest */
const USER_INFO_TIMEOUT = 10000
/** How many distributed search requests are remembered to drop the duplicates */
const MAX_SEEN_SEARCHES = 5000

export type SlskClientEvents = {
  /** Emitted for every incoming search result */
  found: [res: SearchResult]
  /** Progress of a running download */
  'download-progress': [progress: DownloadProgress]
  /** Position of a download in the upload queue of the peer */
  'download-queue': [place: QueuePlace]
  /** Error on the connection to the slsk server */
  'server-error': [err: Error]
  /** Error on the server listening for incoming peer connections */
  'listen-error': [err: Error]
  /** Error on a peer connection */
  'peer-error': [err: Error, user: string]
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
  private shared!: Shared
  /** Connection to the server and to the shares, started once by `login()` */
  private initialized?: Promise<void>
  private peers: Record<string, DefaultPeer | DistributedPeer> = {}
  /** State the peers and the file transfers of this client share */
  private readonly session = new Session()
  /** Searches waiting for results, by token */
  private readonly searches = new Map<string, PendingSearch>()
  /** Matches waiting for the address of the peer that searched, by user then ticket */
  private readonly pendingSearchMatches = new Map<string, Map<string, ShareEntry[]>>()
  /** Distributed search requests already answered, the same one reaches us from every parent */
  private readonly seenSearches = new Set<string>()
  /** Tokens of the ConnectToPeer requests we sent, by token */
  private pendingIndirect: Record<string, (socket: net.Socket, initialData?: Buffer) => void> = {}

  constructor (readonly options: SlskClientOptions = {}) {
    super()
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
   * Connects to the slsk server, starts listening for incoming peer connections and lists the
   * shares. Called by `login()`, once however many times it is called.
   */
  private init (): Promise<void> {
    if (!this.initialized) this.initialized = this.initialize()
    return this.initialized
  }

  private async initialize (): Promise<void> {
    debug('Init client')
    this.server = new Server(this.serverAddress)

    this.server.on('socket-error', err => {
      this.emit('server-error', err)
    })

    this.server.on('connect-to-peer', peer => {
      this.connectToPeer(peer)
    })

    this.server.on('get-peer-address', peer => {
      if (this.peers[peer.user]) {
        this.peers[peer.user].setAddress(peer.host as string, peer.port as number)
      } else {
        this.peers[peer.user] = this.createDefaultPeer(net.createConnection({
          host: peer.host,
          port: peer.port as number
        }), peer)
        this.flushSearchMatches(peer.user)
      }
    })

    // the server could not reach a peer it was asked to connect to us
    this.server.on('cant-connect-to-peer', evt => {
      const download = this.session.downloads.byTransferToken(evt.token)
      if (download) download.fail(new Error(`Cannot connect to ${download.user}`))
    })

    this.shared = new Shared()
    this.shared.addFolders(this.options.sharedFolders ?? [])
    this.shareProviders.forEach(provider => this.shared.addProvider(provider))

    this.startListening()

    await this.server.ready
    await this.shared.refresh()
    this.announceShares()
  }

  /** Accepts the connections peers open to us, to browse our shares or to send us a file */
  private startListening (): void {
    this.listen = new Listen(this.incomingPort)

    this.listen.on('socket-error', err => {
      this.emit('listen-error', err)
    })

    this.listen.on('new-peer', evt => {
      const peer = evt.peer
      if (this.peers[peer.user]) {
        debug(`Already connected to ${peer.user}`)
      } else {
        this.server.getPeerAddress(peer.user)
        debug(`new Peer connected ${peer.user} token ${peer.token}`)
        this.peers[peer.user] = this.createDefaultPeer(evt.socket, peer, evt.initialData)
      }
    })

    // a peer starts sending a file it queued for us
    this.listen.on('file-transfer', evt => {
      debug(`incoming file transfer from ${evt.user}`)
      new FilePeer(evt.socket, { user: evt.user, type: 'F' }, {
        session: this.session,
        readToken: true,
        initialData: evt.initialData
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
    this.server.sharedFoldersFiles(stats.folders, stats.files)
  }

  private createDefaultPeer (socket: net.Socket, peer: PeerInfo, initialData?: Buffer): DefaultPeer {
    const defaultPeer = new DefaultPeer(socket, peer, {
      session: this.session,
      shared: this.shared,
      initialData,
      userInfo: this.options.userInfo
    })

    defaultPeer.on('socket-error', err => this.emit('peer-error', err, peer.user))
    defaultPeer.on('disconnect', () => {
      if (this.peers[peer.user] === defaultPeer) delete this.peers[peer.user]
    })

    defaultPeer.on('search-result', result => this.handleSearchResult(result))
    defaultPeer.on('transfer-request', evt => this.handleTransferRequest(defaultPeer, evt))
    defaultPeer.on('transfer-response', evt => this.handleTransferResponse(defaultPeer, evt))
    defaultPeer.on('place-in-queue', evt => {
      this.session.downloads.get(peer.user, evt.file)?.queued(evt.place)
    })
    defaultPeer.on('upload-failed', file => {
      this.failDownload(peer.user, file, new Error('Peer error'))
    })
    defaultPeer.on('upload-denied', evt => {
      this.failDownload(peer.user, evt.file, new Error(evt.reason || 'Upload denied'))
    })

    return defaultPeer
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
      // the peer wants to download from us, uploading is not supported
      debug(`${peer.peer.user} asks to download ${evt.file}, denying`)
      peer.transferResponse(evt.token, false, 'Cancelled')
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

  /** The peer answered the transfer we asked for */
  private handleTransferResponse (
    peer: DefaultPeer,
    evt: { token: string, allowed: boolean, reason?: string }
  ): void {
    if (!evt.allowed) {
      // 'Queued' is the usual answer, the peer sends its own TransferRequest when a slot frees
      debug(`${peer.peer.user} refused the transfer: ${evt.reason ?? 'no reason'}`)
      this.session.downloads.forgetToken(evt.token)
      return
    }

    const download = this.session.downloads.byTransferToken(evt.token)
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
      offsetDelay: 1000
    })
  }

  /** Files a peer sent back for one of our searches */
  private handleSearchResult (result: FileSearchResult): void {
    const search = this.searches.get(result.currentToken)
    if (!search) return

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
          readToken: true
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

    const peer = this.peerConnection(user)
    if (peer) {
      peer.fileSearchResult(matched, ticket, this.session.username)
      return
    }

    // the answer waits until the server tells us where the peer is
    const waiting = this.pendingSearchMatches.get(user) ?? new Map<string, ShareEntry[]>()
    waiting.set(ticket, matched)
    this.pendingSearchMatches.set(user, waiting)
    this.server.getPeerAddress(user)
  }

  /** Sends the matches that were waiting for the address of this peer */
  private flushSearchMatches (user: string): void {
    const waiting = this.pendingSearchMatches.get(user)
    if (!waiting) return
    this.pendingSearchMatches.delete(user)
    const peer = this.peerConnection(user)
    if (!peer) {
      debug(`no peer connection to answer the searches of ${user}`)
      return
    }
    waiting.forEach((matched, ticket) => {
      peer.fileSearchResult(matched, ticket, this.session.username)
    })
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
   * Connects to the slsk server, lists the shares, starts listening for incoming peer
   * connections and logs in: everything the client needs to be usable.
   * Rejects when the connection fails, the credentials are refused, or the server did not
   * answer the login after `options.timeout` ms.
   */
  async login (user: string, pass: string): Promise<void> {
    await this.init()

    // peers we talk to before the answer comes back must know how to introduce us
    this.session.username = user

    // the listener must be registered before the request is sent
    const answer = waitFor(this.server, 'login', {
      timeout: this.options.timeout ?? DEFAULT_LOGIN_TIMEOUT,
      timeoutError: new Error('timeout login')
    })
    this.server.login({ user, pass })

    const [result] = await answer
    if (!result.success) throw new Error(result.reason)
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
   * Asks a peer for a file and returns the running download, to follow its status and its
   * progress. Resolves as soon as the transfer has been asked for, not when it is done.
   */
  async startDownload (obj: DownloadOptions): Promise<Download> {
    if (typeof obj.file === 'undefined') throw new Error('You must specify file')

    const user = obj.file.user
    const file = obj.file.file
    debug(`launch download ${user} ${file}`)

    // connectToUser reuses the connection to this peer when there is a usable one
    const connection = await this.connectToUser(user)
    if (!(connection instanceof DefaultPeer)) {
      throw new Error(`No peer connection to ${user}`)
    }
    const peer = connection

    const download = this.session.downloads.start({
      user,
      file,
      path: obj.path,
      offset: obj.offset,
      size: obj.file.size
    })

    download.on('progress', progress => this.emit('download-progress', progress))
    download.on('queue', place => this.emit('download-queue', { user, file, place }))

    if (obj.request === 'transfer') {
      // legacy flow: we pick the token and ask for the transfer directly
      const token = crypto.randomBytes(4).toString('hex')
      this.session.downloads.bindToken(token, download)
      peer.transferRequest(file, token)
      return download
    }

    // modern flow: the peer queues the file and comes back with its own transfer token
    peer.queueUpload(file)
    peer.placeInQueueRequest(file)
    return download
  }

  /**
   * Downloads a file, resolving once it is fully downloaded (kept in RAM and
   * written to `obj.path`, /tmp/slsk/{{originalName}} by default).
   */
  async download (obj: DownloadOptions): Promise<DownloadResult> {
    const download = await this.startDownload(obj)
    return await download.promise
  }

  /**
   * Downloads a file as a stream, data is pushed as it is received.
   * Can be used for HTTP 206 (partial content) for example.
   * The stream is destroyed with an error when the peer reports a failure.
   */
  downloadStream (obj: DownloadOptions): Readable {
    const stream = new PassThrough()

    this.startDownload(obj)
      .then(download => {
        download.on('failed', err => stream.destroy(err))
        download.stream.pipe(stream)
      })
      .catch((err: Error) => stream.destroy(err))

    return stream
  }

  destroy (): void {
    if (this.server) this.server.destroy()
    if (this.listen) this.listen.destroy()
    if (this.shared) {
      this.shared.close().catch(err => debug(`cannot close the shares: ${String(err)}`))
    }

    this.session.downloads.failAll(new Error('Client destroyed'))
    this.searches.clear()

    Object.keys(this.peers).forEach(peer => {
      this.peers[peer].destroy()
    })
  }
}

/** Turns a file of a FileSearchResult into what the search API exposes */
export function toSearchResult (file: FileSearchResultFile, result: FileSearchResult): SearchResult {
  const attribs = file.attribs
  return {
    user: file.user,
    file: file.file,
    size: file.size,
    slots: result.slots === 1,
    bitrate: attribs[FileAttribute.Bitrate],
    duration: attribs[FileAttribute.Duration],
    vbr: FileAttribute.VBR in attribs ? attribs[FileAttribute.VBR] === 1 : undefined,
    sampleRate: attribs[FileAttribute.SampleRate],
    bitDepth: attribs[FileAttribute.BitDepth],
    attribs,
    speed: result.speed,
    queueLength: result.queueLength
  }
}

import EventEmitter from 'events'
import crypto from 'crypto'
import { Readable } from 'stream'
import net from 'net'
import createDebug from 'debug'
import Server from './server'
import DefaultPeer from './peer/default-peer'
import DistributedPeer from './peer/distributed-peer'
import downloadPeerFile, { attachFileTransfer } from './peer/download-peer-file'
import Listen from './listen'
import Shared from './share/shared'
import stack, { downloadKey } from './stack'
import type {
  ConnectOptions,
  Download,
  DownloadOptions,
  DownloadProgress,
  PeerInfo,
  QueuePlace,
  SearchOptions,
  SearchResult,
  ServerAddress
} from './types'

const debug = createDebug('slsk:i')

/** ms to wait for a peer connection, direct or relayed by the server */
const PEER_TIMEOUT = 10000

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

export default class SlskClient extends EventEmitter<SlskClientEvents> {
  private server!: Server
  private listen?: Listen
  private shared!: Shared
  private peers: Record<string, DefaultPeer | DistributedPeer> = {}
  /** Tokens of the ConnectToPeer requests we sent, by token */
  private pendingIndirect: Record<string, (socket: net.Socket, initialData?: Buffer) => void> = {}

  constructor (
    readonly serverAddress: ServerAddress,
    readonly sharedFolders: string[]
  ) {
    super()
  }

  /** Connects to the slsk server and scans the shared folders */
  async init (): Promise<void> {
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
        if (stack.peerSearchMatches[peer.user]) {
          Object.keys(stack.peerSearchMatches[peer.user]).forEach(ticket => {
            this.peers[peer.user].fileSearchResult(stack.peerSearchMatches[peer.user][ticket], ticket, stack.currentLogin as string)
          })
          stack.peerSearchMatches[peer.user] = {}
        }
      }
    })

    this.shared = new Shared()

    await this.server.ready
    await Promise.all(this.sharedFolders.map(folder => this.shared.scanFolder(folder)))
    this.server.sharedFoldersFiles(this.shared.folders().length, this.shared.files.length)
  }

  private createDefaultPeer (socket: net.Socket, peer: PeerInfo, initialData?: Buffer): DefaultPeer {
    const defaultPeer = new DefaultPeer(socket, peer, { shared: this.shared, initialData })
    defaultPeer.on('socket-error', err => this.emit('peer-error', err, peer.user))
    defaultPeer.on('disconnect', () => {
      if (this.peers[peer.user] === defaultPeer) delete this.peers[peer.user]
    })
    return defaultPeer
  }

  private connectToPeer (peer: PeerInfo): void {
    debug(`connectToPeer ${peer.user} ${peer.host} ${peer.port} ${peer.token} ${peer.type}`)

    switch (peer.type) {
      case 'F': {
        downloadPeerFile(peer.host as string, peer.port as number, peer.token as string, peer.user, false)
        break
      }
      case 'D': {
        const distributedPeer = new DistributedPeer(net.createConnection({
          host: peer.host,
          port: peer.port as number
        }), peer)
        this.peers[peer.user] = distributedPeer
        distributedPeer.on('socket-error', err => this.emit('peer-error', err, peer.user))
        distributedPeer.on('search', search => {
          this.answerSearchRequest(search.user, search.ticket, search.query)
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

  private answerSearchRequest (user: string, ticket: string, query: string): void {
    const matched = this.shared.search(query)
    if (matched.length === 0) return

    if (!this.peers[user]) {
      this.server.getPeerAddress(user)
      if (!stack.peerSearchMatches[user]) {
        stack.peerSearchMatches[user] = {
          [ticket]: matched
        }
      } else {
        stack.peerSearchMatches[user][ticket] = matched
      }
    } else {
      this.peers[user].fileSearchResult(matched, ticket, stack.currentLogin as string)
    }
    debug(`Search from peer ${user}, query: ${query}. Matched: ${matched.length} files`)
  }

  /**
   * Logs into the slsk server and starts listening for incoming peer connections.
   * Rejects when the server refuses the credentials or after `credentials.timeout` ms.
   */
  login (credentials: ConnectOptions): Promise<void> {
    stack.currentLogin = credentials.user

    const incomingPort = credentials.incomingPort || 2234
    this.listen = new Listen(incomingPort)

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
      attachFileTransfer(evt.socket, {
        user: evt.user,
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

    this.server.setWaitPort(incomingPort)

    const timeout = credentials.timeout || 2000
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (stack.login) {
          delete stack.login
          reject(new Error('timeout login'))
        }
      }, timeout)

      stack.login = err => {
        clearTimeout(timer)
        if (err) return reject(err)
        resolve()
      }

      this.server.login(credentials)
    })
  }

  /**
   * Searches for files. Slsk doesn't tell when a search is finished, so results are
   * collected until the timeout is reached and then returned all at once.
   * Individual results are also emitted as 'found' and 'found:{req}' events.
   */
  search (obj: SearchOptions): Promise<SearchResult[]> {
    const token = crypto.randomBytes(4).toString('hex')
    const timeout = obj.timeout || 4000
    const results: SearchResult[] = []

    return new Promise<SearchResult[]>(resolve => {
      setTimeout(() => {
        delete stack.search[token]
        resolve(results)
      }, timeout)
      stack.search[token] = {
        cb: res => {
          this.emit('found', res)
          this.emit(`found:${obj.req}`, res)
          results.push(res)
        },
        query: obj.req
      }

      this.server.fileSearch(obj.req, token)
    })
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
    const cleanups: Array<() => void> = []

    try {
      return await Promise.any([
        this.connectDirect(user, timeout, cleanups),
        this.connectIndirect(user, token, timeout, cleanups)
      ])
    } catch {
      this.server.cantConnectToPeer(token, user)
      throw new Error('User not exist')
    } finally {
      // stop the attempt that lost the race
      cleanups.forEach(cleanup => cleanup())
      delete this.pendingIndirect[token]
    }
  }

  /** Asks the server for the address of the peer and connects to it */
  private async connectDirect (
    user: string,
    timeout: number,
    cleanups: Array<() => void>
  ): Promise<DefaultPeer | DistributedPeer> {
    await new Promise<void>((resolve, reject) => {
      const listener = (peer: PeerInfo): void => {
        if (peer.user !== user) return
        cleanup()
        if (!peer.port) {
          reject(new Error(`${user} is not connected`))
          return
        }
        resolve()
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`GetPeerAddress timed out for ${user}`))
      }, timeout)

      const cleanup = (): void => {
        clearTimeout(timer)
        this.server.off('get-peer-address', listener)
      }
      cleanups.push(cleanup)

      this.server.on('get-peer-address', listener)
      this.server.getPeerAddress(user)
    })

    // the 'get-peer-address' handler created the peer with the address we just received
    const peer = this.peers[user]
    if (!peer) throw new Error(`No connection to ${user}`)
    await peer.ready
    return peer
  }

  /** Asks the server to make the peer connect to us */
  private connectIndirect (
    user: string,
    token: string,
    timeout: number,
    cleanups: Array<() => void>
  ): Promise<DefaultPeer | DistributedPeer> {
    return new Promise<DefaultPeer | DistributedPeer>((resolve, reject) => {
      const onConnectToPeer = (peer: PeerInfo): void => {
        if (peer.user !== user || peer.type === 'F') return
        const connected = this.peers[user]
        if (connected) {
          cleanup()
          resolve(connected)
        }
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`ConnectToPeer timed out for ${user}`))
      }, timeout)

      const cleanup = (): void => {
        clearTimeout(timer)
        delete this.pendingIndirect[token]
        this.server.off('connect-to-peer', onConnectToPeer)
      }
      cleanups.push(cleanup)

      // the peer pierces our firewall on the listening port
      this.pendingIndirect[token] = (socket, initialData) => {
        debug(`${user} pierced our firewall with token ${token}`)
        const peer = this.createDefaultPeer(socket, { user, type: 'P' }, initialData)
        this.peers[user] = peer
        cleanup()
        resolve(peer)
      }

      this.server.on('connect-to-peer', onConnectToPeer)
      this.server.connectToPeer(token, user, 'P')
    })
  }

  /**
   * Downloads a file, resolving once it is fully downloaded (kept in RAM and
   * written to `obj.path`, /tmp/slsk/{{originalName}} by default).
   */
  download (obj: DownloadOptions): Promise<Download> {
    return new Promise<Download>((resolve, reject) => {
      this.startDownload(obj, resolve, reject)
        .catch(reject)
    })
  }

  /**
   * Downloads a file as a stream, data is pushed as it is received.
   * Can be used for HTTP 206 (partial content) for example.
   * The stream is destroyed with an error when the peer reports a failure.
   */
  downloadStream (obj: DownloadOptions): Readable {
    const s = new Readable()
    s._read = () => {}
    this.startDownload(obj, undefined, undefined, s)
      .catch(err => s.destroy(err as Error))
    return s
  }

  private async startDownload (
    obj: DownloadOptions,
    resolve?: (down: Download) => void,
    reject?: (err: Error) => void,
    stream?: Readable
  ): Promise<void> {
    debug(`launch download ${obj.file?.user} ${obj.file?.file}`)
    const fail = (err: Error): void => {
      if (stream) {
        stream.destroy(err)
        return
      }
      if (reject) {
        reject(err)
        return
      }
      throw err
    }

    if (typeof obj.file === 'undefined') {
      return fail(new Error('You must specify file'))
    }

    const user = obj.file.user
    const file = obj.file.file

    let peer = this.peers[user]
    if (!peer) {
      try {
        peer = await this.connectToUser(user)
      } catch (err) {
        return fail(err as Error)
      }
    }

    const offset = obj.offset && obj.offset > 0 ? obj.offset : 0

    stack.download[downloadKey(user, file)] = {
      resolve,
      reject,
      path: obj.path,
      stream,
      offset,
      onProgress: (receivedBytes, totalBytes) => {
        this.emit('download-progress', {
          user,
          file,
          receivedBytes,
          totalBytes,
          progress: totalBytes ? receivedBytes / totalBytes : undefined
        })
      },
      onQueue: place => {
        this.emit('download-queue', { user, file, place })
      }
    }

    if (obj.request === 'transfer') {
      // legacy flow: we pick the token and ask for the transfer directly
      const token = crypto.randomBytes(4).toString('hex')
      stack.downloadTokens[token] = {
        user,
        file,
        size: obj.file.size
      }
      peer.transferRequest(file, token)
      return
    }

    // modern flow: the peer queues the file and comes back with its own transfer token
    peer.queueUpload(file)
    peer.placeInQueueRequest(file)
  }

  destroy (): void {
    if (this.server) this.server.destroy()
    if (this.listen) this.listen.destroy()

    Object.keys(this.peers).forEach(peer => {
      this.peers[peer].destroy()
    })
    delete stack.login
  }
}

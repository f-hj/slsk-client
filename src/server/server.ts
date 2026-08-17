import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Messages from '../utils/messages'
import messages from './messages'
import handleServerMessage from './handler'
import type Message from '../utils/message'
import type { PeerInfo, ServerAddress } from '../types'

const debug = createDebug('slsk:server:i')

/** Answer of the server to our Login */
export type LoginResult =
  | { success: true, greet: string }
  | { success: false, reason: string }

export interface ServerEvents {
  login: [result: LoginResult]
  'connect-to-peer': [peer: PeerInfo]
  'get-peer-address': [peer: PeerInfo]
  /** The server could not ask a peer to connect to us */
  'cant-connect-to-peer': [evt: { token: string }]
  'socket-error': [err: Error]
}

/**
 * The connection to the slsk server: the socket and what we send on it. Incoming messages are
 * parsed and answered by the handler, which reports them as events.
 */
export default class Server extends EventEmitter<ServerEvents> {
  /** Resolves once the connection to the slsk server is established, rejects on connection error */
  readonly ready: Promise<void>
  private conn: net.Socket
  /**
   * The server silently drops the connection state when anything is sent before a
   * successful Login, so announcements are queued until then.
   */
  private loggedIn = false
  /** Announced to the server on login and every time the shared folders are (re)scanned */
  private shareCounts = { folders: 0, files: 0 }
  /** Announced to the server on login, set again with SetWaitPort */
  private waitPort?: number

  constructor (serverAddress: ServerAddress) {
    super()
    this.conn = net.createConnection(serverAddress)

    this.ready = new Promise<void>((resolve, reject) => {
      this.conn.once('connect', resolve)
      this.conn.once('error', err => reject(new Error(err.message)))
    })

    // avoid crashing on socket errors happening after the initial connection
    this.conn.on('error', err => {
      debug(`server connection error ${err.message}`)
      this.emit('socket-error', err)
    })

    const msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', (msg: Message) => handleServerMessage(msg, this))
  }

  private write (msg: Message): void {
    this.conn.write(msg.getBuff())
  }

  /**
   * Sends everything the server expects right after a successful login, including what was
   * queued before it.
   */
  onLoggedIn (): void {
    this.loggedIn = true
    this.sharedFoldersFiles(this.shareCounts.folders, this.shareCounts.files)
    this.haveNoParents(true)
    this.setStatus(2)
    if (this.waitPort !== undefined) this.setWaitPort(this.waitPort)
  }

  login (credentials: { user: string, pass: string }): void {
    this.write(messages.login(credentials))
  }

  fileSearch (query: string, token: string): void {
    debug(`send FileSearch: ${query}`)
    this.write(messages.fileSearch(query, token))
  }

  setWaitPort (port: number): void {
    this.waitPort = port
    if (!this.loggedIn) {
      debug(`queue SetWaitPort ${port} until login`)
      return
    }
    debug(`send SetWaitPort ${port}`)
    this.write(messages.setWaitPort(port))
  }

  /** SetStatus (28): 1 away, 2 online */
  setStatus (status: number): void {
    debug(`send SetStatus ${status}`)
    this.write(messages.setStatus(status))
  }

  getPeerAddress (username: string): void {
    debug(`send GetPeerAddress ${username}`)
    this.write(messages.getPeerAddress(username))
  }

  /** Asks the server to tell a peer to connect to us, used when we cannot reach it directly */
  connectToPeer (token: string, username: string, type = 'P'): void {
    debug(`send ConnectToPeer ${username} type ${type} token ${token}`)
    this.write(messages.connectToPeer(token, username, type))
  }

  /** Tells the server we could not connect to a peer it asked us to reach */
  cantConnectToPeer (token: string, username: string): void {
    debug(`send CantConnectToPeer ${username} token ${token}`)
    this.write(messages.cantConnectToPeer(token, username))
  }

  /** Announces how much we share, sent again after every folder scan */
  sharedFoldersFiles (folders: number, files: number): void {
    this.shareCounts = { folders, files }
    if (!this.loggedIn) {
      debug(`queue SharedFoldersFiles ${folders} folders, ${files} files until login`)
      return
    }
    debug(`send SharedFoldersFiles ${folders} folders, ${files} files`)
    this.write(messages.sharedFoldersFiles(folders, files))
  }

  /** Tells the server whether we are looking for a distributed parent */
  haveNoParents (flag: boolean): void {
    debug(`send HaveNoParent ${String(flag)}`)
    this.write(messages.haveNoParents(flag))
  }

  /** ParentIP (73): address of the parent we picked */
  parentIp (ip: number[]): void {
    this.write(messages.parentIp(ip))
  }

  /** Reports our distance to the root of the distributed network */
  branchLevel (level: number): void {
    debug(`send BranchLevel ${level}`)
    this.write(messages.branchLevel(level))
  }

  /** Reports the root of our branch of the distributed network */
  branchRoot (root: string): void {
    debug(`send BranchRoot ${root}`)
    this.write(messages.branchRoot(root))
  }

  destroy (): void {
    this.conn.destroy()
  }
}

import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Messages from '../utils/messages'
import messages from './messages'
import handleServerMessage from './handler'
import { SERVER_MESSAGES, nameOf } from '../utils/message-names'
import type Message from '../utils/message'
import type { PeerInfo, ServerAddress } from '../types'

const debug = createDebug('slsk:server:i')

/** Answer of the server to our Login */
export type LoginResult =
  | { success: true, greet: string }
  | { success: false, reason: string }

/**
 * The server refused the credentials, which no amount of retrying fixes: a client that keeps
 * reconnecting gives up on this one, unlike a timeout or a broken connection.
 */
export class LoginRefusedError extends Error {
  override readonly name = 'LoginRefusedError'
}

export interface ServerEvents {
  login: [result: LoginResult]
  'connect-to-peer': [peer: PeerInfo]
  'get-peer-address': [peer: PeerInfo]
  /** The server could not ask a peer to connect to us */
  'cant-connect-to-peer': [evt: { token: string }]
  'socket-error': [err: Error]
  /** The connection is gone, whether the server closed it or the socket broke */
  close: []
}

/**
 * ms of idle time before the TCP keepalive probes start. The slsk server sends nothing on a
 * quiet session, so without them a connection dropped by a NAT or a proxy looks alive until
 * the next write, which can be hours later.
 */
const KEEPALIVE_DELAY = 60000

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
    this.conn.setKeepAlive(true, KEEPALIVE_DELAY)

    this.ready = new Promise<void>((resolve, reject) => {
      this.conn.once('connect', resolve)
      this.conn.once('error', err => reject(new Error(err.message)))
    })

    // avoid crashing on socket errors happening after the initial connection
    this.conn.on('error', err => {
      debug(`server connection error ${err.message}`)
      this.emit('socket-error', err)
    })

    this.conn.on('close', () => {
      debug('server connection closed')
      // whatever was announced is forgotten by the server, a new session starts from the login
      this.loggedIn = false
      this.emit('close')
    })

    const msgs = new Messages()

    this.conn.on('data', data => {
      msgs.write(data)
    })

    msgs.on('message', (msg: Message) => handleServerMessage(msg, this))
  }

  /** true while the connection to the slsk server is up */
  get connected (): boolean {
    return !this.conn.destroyed && this.conn.readyState === 'open'
  }

  /**
   * Writes a message and logs what it is. The code is the first field, so reading it back names
   * every message that goes out without repeating the name at each call site; `detail` carries
   * the values worth seeing next to it.
   */
  private write (msg: Message, detail?: string): void {
    const name = nameOf(SERVER_MESSAGES, msg.data.readUInt32LE(0))
    if (this.conn.destroyed) {
      // the client reports the drop as 'server-disconnect', writing would only raise a second error
      debug(`dropping ${name}, the server connection is gone`)
      return
    }
    debug(`send ${name}, ${msg.data.length} bytes${detail ? `: ${detail}` : ''}`)
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
    // the password is never logged, only the name it is sent for
    this.write(messages.login(credentials), credentials.user)
  }

  fileSearch (query: string, token: string): void {
    this.write(messages.fileSearch(query, token), `"${query}" token ${token}`)
  }

  setWaitPort (port: number): void {
    this.waitPort = port
    if (!this.loggedIn) {
      debug(`queue SetWaitPort ${port} until login`)
      return
    }
    this.write(messages.setWaitPort(port), String(port))
  }

  /** SetStatus (28): 1 away, 2 online */
  setStatus (status: number): void {
    this.write(messages.setStatus(status), status === 1 ? 'away' : 'online')
  }

  getPeerAddress (username: string): void {
    this.write(messages.getPeerAddress(username), username)
  }

  /** Asks the server to tell a peer to connect to us, used when we cannot reach it directly */
  connectToPeer (token: string, username: string, type = 'P'): void {
    this.write(messages.connectToPeer(token, username, type), `${username} type ${type} token ${token}`)
  }

  /** Tells the server we could not connect to a peer it asked us to reach */
  cantConnectToPeer (token: string, username: string): void {
    this.write(messages.cantConnectToPeer(token, username), `${username} token ${token}`)
  }

  /** Announces how much we share, sent again after every folder scan */
  sharedFoldersFiles (folders: number, files: number): void {
    this.shareCounts = { folders, files }
    if (!this.loggedIn) {
      debug(`queue SharedFoldersFiles ${folders} folders, ${files} files until login`)
      return
    }
    this.write(messages.sharedFoldersFiles(folders, files), `${folders} folders, ${files} files`)
  }

  /** Tells the server whether we are looking for a distributed parent */
  haveNoParents (flag: boolean): void {
    this.write(messages.haveNoParents(flag), String(flag))
  }

  /** ParentIP (73): address of the parent we picked */
  parentIp (ip: number[]): void {
    this.write(messages.parentIp(ip), ip.join('.'))
  }

  /** Reports our distance to the root of the distributed network */
  branchLevel (level: number): void {
    this.write(messages.branchLevel(level), String(level))
  }

  /** Reports the root of our branch of the distributed network */
  branchRoot (root: string): void {
    this.write(messages.branchRoot(root), root)
  }

  destroy (): void {
    this.conn.destroy()
  }
}

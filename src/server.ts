import EventEmitter from 'events'
import net from 'net'
import crypto from 'crypto'
import createDebug from 'debug'
import Messages from './messages'
import Message from './message'
import MessageFactory from './message-factory'
import stack, { failDownload } from './stack'
import type { PeerInfo, ServerAddress } from './types'

const debug = createDebug('slsk:server:i')

export interface ServerEvents {
  'connect-to-peer': [peer: PeerInfo]
  'get-peer-address': [peer: PeerInfo]
  /** The server could not ask a peer to connect to us */
  'cant-connect-to-peer': [evt: { token: string }]
  'socket-error': [err: Error]
}

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

    msgs.on('message', (msg: Message) => this.handleMessage(msg))
  }

  private handleMessage (msg: Message): void {
    const size = msg.int32()
    if (size < 4) return
    const code = msg.int32()
    switch (code) {
      case 1: {
        debug('Login Response')
        if (!stack.login) return
        const success = msg.int8()
        if (success === 1) {
          this.loggedIn = true
          stack.login()
          delete stack.login
          const greet = msg.str()
          debug(`Login succeed: ${greet}`)
          this.sharedFoldersFiles(this.shareCounts.folders, this.shareCounts.files)
          this.haveNoParents(true)
          debug('send SetStatus online')
          this.conn.write(MessageFactory
            .to.server
            .setStatus(2)
            .getBuff())
          if (this.waitPort !== undefined) this.setWaitPort(this.waitPort)
        } else {
          const reason = msg.str()
          stack.login(new Error(reason))
          delete stack.login
        }
        break
      }
      case 3: {
        const user = msg.str()
        const ip: number[] = []
        for (let i = 0; i < 4; i++) {
          ip.push(msg.int8())
        }
        const host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
        const port = msg.int32()
        this.emit('get-peer-address', { user, host, port } satisfies PeerInfo)
        break
      }
      case 7: {
        const user = msg.str()
        const status = msg.int32()
        const privileged = msg.remaining() >= 1 ? msg.int8() : 0
        debug(`recv GetUserStatus for ${user}: ${status}, privileged: ${privileged}`)
        break
      }
      case 18: {
        const user = msg.str()
        const type = msg.str()
        const ip: number[] = []
        for (let i = 0; i < 4; i++) {
          ip.push(msg.int8())
        }
        const host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
        const port = msg.int32()
        const token = msg.readRawHexStr(4)
        this.emit('connect-to-peer', { user, type, ip, host, port, token } satisfies PeerInfo)
        break
      }
      case 36: {
        const user = msg.str()
        const avgSpeed = msg.int32()
        const downloadNum = msg.int32()
        const something = msg.int32()
        const files = msg.int32()
        const folders = msg.int32()
        debug(`recv GetUserStats user: ${user}, avgSpeed ${avgSpeed}, files ${files}, folders ${folders}. downloadNum ${downloadNum}. something... ${something}`)
        break
      }
      case 64: {
        debug(`recv RoomList ${msg.data.length}`)
        const nbRooms = msg.int32()
        const rooms: Array<{ name: string, users?: number }> = []
        for (let i = 0; i < nbRooms; i++) {
          rooms.push({
            name: msg.str()
          })
        }
        // the number of rooms is repeated before the user counts
        const nbUserCounts = msg.remaining() >= 4 ? msg.int32() : 0
        for (let i = 0; i < nbUserCounts && i < nbRooms; i++) {
          rooms[i].users = msg.int32()
        }
        break
      }
      case 69: {
        const number = msg.int32()
        debug(`there are ${number} PrivilegedUsers. msg length: ${msg.data.length}`)
        break
      }
      case 83: {
        const number = msg.int32()
        debug(`ParentMinSpeed is ${number}. msg length: ${msg.data.length}`)
        break
      }
      case 84: {
        const number = msg.int32()
        debug(`ParentSpeedRatio is ${number}. msg length: ${msg.data.length}`)
        break
      }
      case 102: {
        const numberOfParents = msg.int32()
        debug(`recv NetInfo, number of search parents: ${numberOfParents}`)
        for (let i = 0; i < numberOfParents; i++) {
          const user = msg.str()
          const ip: number[] = []
          for (let j = 0; j < 4; j++) {
            ip.push(msg.int8())
          }
          const host = ip[3] + '.' + ip[2] + '.' + ip[1] + '.' + ip[0]
          const port = msg.int32()
          debug(`Parent ${user} ${host} ${port}`)
          this.conn.write(MessageFactory
            .to.server
            .parentIp(ip)
            .getBuff())
          this.emit('connect-to-peer', {
            user,
            type: 'D',
            ip,
            host,
            port,
            token: crypto.randomBytes(4).toString('hex')
          } satisfies PeerInfo)
        }
        break
      }
      case 104: {
        const number = msg.int32()
        debug(`Whishlist interval is ${number}. msg length: ${msg.data.length}`)
        break
      }
      case 1001: {
        const token = msg.readRawHexStr(4)
        debug(`Cannot connect to peer, token ${token}`)
        const pending = stack.downloadTokens[token]
        if (pending) {
          failDownload(pending.user, pending.file, new Error(`Cannot connect to ${pending.user}`))
        }
        this.emit('cant-connect-to-peer', { token })
        break
      }
      default: {
        debug(`unknown srv message code: ${code} length: ${msg.data.length}`)
      }
    }
  }

  login (credentials: { user: string, pass: string }): void {
    this.conn.write(MessageFactory
      .to.server
      .login(credentials)
      .getBuff())
  }

  fileSearch (query: string, token: string): void {
    debug(`send FileSearch: ${query}`)
    this.conn.write(MessageFactory
      .to.server
      .fileSearch(query, token)
      .getBuff())
  }

  setWaitPort (port: number): void {
    this.waitPort = port
    if (!this.loggedIn) {
      debug(`queue SetWaitPort ${port} until login`)
      return
    }
    debug(`send SetWaitPort ${port}`)
    this.conn.write(MessageFactory
      .to.server
      .setWaitPort(port)
      .getBuff())
  }

  getPeerAddress (username: string): void {
    debug(`send GetPeerAddress ${username}`)
    this.conn.write(MessageFactory
      .to.server
      .getPeerAddress(username)
      .getBuff())
  }

  /** Asks the server to tell a peer to connect to us, used when we cannot reach it directly */
  connectToPeer (token: string, username: string, type = 'P'): void {
    debug(`send ConnectToPeer ${username} type ${type} token ${token}`)
    this.conn.write(MessageFactory
      .to.server
      .connectToPeer(token, username, type)
      .getBuff())
  }

  /** Tells the server we could not connect to a peer it asked us to reach */
  cantConnectToPeer (token: string, username: string): void {
    debug(`send CantConnectToPeer ${username} token ${token}`)
    this.conn.write(MessageFactory
      .to.server
      .cantConnectToPeer(token, username)
      .getBuff())
  }

  /** Announces how much we share, sent again after every folder scan */
  sharedFoldersFiles (folders: number, files: number): void {
    this.shareCounts = { folders, files }
    if (!this.loggedIn) {
      debug(`queue SharedFoldersFiles ${folders} folders, ${files} files until login`)
      return
    }
    debug(`send SharedFoldersFiles ${folders} folders, ${files} files`)
    this.conn.write(MessageFactory
      .to.server
      .sharedFoldersFiles(folders, files)
      .getBuff())
  }

  /** Tells the server whether we are looking for a distributed parent */
  haveNoParents (flag: boolean): void {
    debug(`send HaveNoParent ${String(flag)}`)
    this.conn.write(MessageFactory
      .to.server
      .haveNoParents(flag)
      .getBuff())
  }

  /** Reports our distance to the root of the distributed network */
  branchLevel (level: number): void {
    debug(`send BranchLevel ${level}`)
    this.conn.write(MessageFactory
      .to.server
      .branchLevel(level)
      .getBuff())
  }

  /** Reports the root of our branch of the distributed network */
  branchRoot (root: string): void {
    debug(`send BranchRoot ${root}`)
    this.conn.write(MessageFactory
      .to.server
      .branchRoot(root)
      .getBuff())
  }

  destroy (): void {
    this.conn.destroy()
  }
}

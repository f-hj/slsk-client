import crypto from 'crypto'
import net from 'net'
import createDebug from 'debug'
import DefaultPeer from './default-peer/default-peer'
import DistributedPeer from './distributed-peer/distributed-peer'
import FilePeer from './file-peer/file-peer'
import Listen from '../listen'
import waitFor from '../utils/wait-for'
import dial from '../utils/dial'
import { PEER_TIMEOUT } from '../defaults'
import type { ClientContext } from '../context'
import type { PeerInfo } from '../types'

const debug = createDebug('slsk:peers')

/** Called with the connection a peer opens after a ConnectToPeer request we sent */
type Pierced = (socket: net.Socket, initialData?: Buffer) => void

/**
 * Names an incoming connection the way {@link Peer.label} does, for the log lines written before
 * it is wrapped in a `Peer`: every line about a connection says which peer and which side of it.
 * `?` for a peer that has not introduced itself, which a PierceFireWall never does.
 */
function inLabel (user: string, socket: net.Socket): string {
  return `${user}[in:${socket.localPort ?? '?'}]`
}

/** Same, for a connection we are about to dial: the port is the one the peer listens on */
function outLabel (user: string, port?: number): string {
  return `${user}[out:${port ?? '?'}]`
}

/**
 * Every connection this client holds to another peer, and how they come to be: the ones we dial,
 * the ones peers open to our listening port, and the ones the server has a peer open for us.
 * One connection per peer is kept, whichever side opened it.
 */
export default class Peers {
  /**
   * Peer connections (type P), by user. Kept apart from the distributed ones: the protocol keys a
   * connection by user *and* type, and the same user can hold one of each, for entirely different
   * traffic. One map per type is what keeps a parent from evicting a peer connection.
   */
  private readonly peers: Record<string, DefaultPeer> = {}
  /** Distributed connections (type D), by user: the parents that send us the searches */
  private readonly parents: Record<string, DistributedPeer> = {}
  /** Callbacks waiting for the ConnectToPeer requests we sent, by token */
  private readonly pendingIndirect: Record<string, Pierced> = {}
  /** Users a `connectDirect` is waiting for the address of, the only ones worth dialling */
  private readonly awaitingAddress = new Set<string>()
  private listen?: Listen

  constructor (private readonly ctx: ClientContext) {}

  /**
   * Peers whose listening port did not answer. A firewalled peer reaches us and never accepts a
   * connection of its own: dialling it again for every file only makes every transfer wait for a
   * dial that cannot come up, when the relayed route is the one that works for it.
   */
  private readonly cannotAccept = new Set<string>()

  /** false for a peer whose port did not answer the last time we dialled it */
  canBeDialled (user: string): boolean {
    return !this.cannotAccept.has(user)
  }

  /** Remembers whether the port of a peer answered, whatever the dial was for */
  dialled (user: string, reached: boolean): void {
    if (reached) {
      if (this.cannotAccept.delete(user)) debug(`${user} answers on its port again`)
      return
    }
    if (!this.cannotAccept.has(user)) {
      debug(`${user} does not answer on its port, the server will relay from now on`)
    }
    this.cannotAccept.add(user)
  }

  /** Dials that peer again next time, for when the relayed route does not work either */
  dialAgain (user: string): void {
    if (this.cannotAccept.delete(user)) debug(`${user} will be dialled again, the relay failed too`)
  }

  /** Dials a peer and remembers whether its port answered */
  private dialPeer (user: string, host: string, port: number): net.Socket {
    const socket = dial(host, port)

    let up = false
    socket.once('connect', () => {
      up = true
      this.dialled(user, true)
    })
    // close always comes, whether the dial failed, timed out or the connection lived and ended
    socket.once('close', () => {
      if (!up) this.dialled(user, false)
    })

    return socket
  }

  /** true once the client accepts incoming peer connections */
  get listening (): boolean {
    return this.listen !== undefined
  }

  get (user: string): DefaultPeer | DistributedPeer | undefined {
    return this.peers[user] ?? this.parents[user]
  }

  /**
   * Peer connection (type P) to a user, when there is one: the connection to a distributed
   * parent carries searches, not the messages a peer connection understands.
   */
  peerConnection (user: string): DefaultPeer | undefined {
    return this.peers[user]
  }

  /** Every connection to a user, whatever its type: what an address applies to */
  private connectionsTo (user: string): Array<DefaultPeer | DistributedPeer> {
    const connections: Array<DefaultPeer | DistributedPeer> = []
    if (this.peers[user]) connections.push(this.peers[user])
    if (this.parents[user]) connections.push(this.parents[user])
    return connections
  }

  /** Registers the connection a peer is about to open after a ConnectToPeer request */
  expectPierce (token: string, onPierced: Pierced): void {
    this.pendingIndirect[token] = onPierced
  }

  /** Gives up on such a connection, false when it had already been opened or forgotten */
  forgetPierce (token: string): boolean {
    if (!this.pendingIndirect[token]) return false
    delete this.pendingIndirect[token]
    return true
  }

  /** Accepts the connections peers open to us, to browse our shares or to send us a file */
  startListening (): void {
    const listen = new Listen(this.ctx.incomingPort)
    this.listen = listen

    listen.on('socket-error', err => {
      this.ctx.emit('listen-error', err)
    })

    listen.on('new-peer', evt => {
      const peer = evt.peer
      const existing = this.peers[peer.user]

      if (this.isOurOwnName(peer.user)) {
        this.dropSelfConnection(evt.socket, peer.user)
      } else if (peer.type !== undefined && peer.type !== 'P') {
        // the type says what travels on it, and a D connection carries messages a peer parser
        // would read as garbage. Only P is understood: we serve no distributed children.
        debug(`${inLabel(peer.user, evt.socket)} opened a type ${peer.type} connection, which is not served: closing it`)
        evt.socket.destroy()
      } else if (existing?.connected) {
        debug(`${inLabel(peer.user, evt.socket)} is already connected on ${existing.label},` +
          ` dropping the connection it just opened` +
          `${evt.initialData ? ` and the ${evt.initialData.length} bytes it sent on it` : ''}`)
        evt.socket.destroy()
      } else {
        // a peer reaching us while we are still dialling it, or after that dial died: its
        // connection is the one that works, ours would only hold messages in a buffer
        if (existing) {
          debug(`${inLabel(peer.user, evt.socket)} reached us, dropping ${existing.label}`)
          existing.destroy()
        }
        this.ctx.server.getPeerAddress(peer.user)
        debug(`${inLabel(peer.user, evt.socket)} new peer connection, token ${peer.token}`)
        this.peers[peer.user] = this.createDefaultPeer(evt.socket, peer, evt.initialData)
      }
    })

    // a peer starts sending a file it queued for us
    listen.on('file-transfer', evt => {
      if (this.isOurOwnName(evt.user)) {
        this.dropSelfConnection(evt.socket, evt.user)
        return
      }
      /*
       * A file connection is opened by whoever needs it, so an incoming one runs in either
       * direction. FileTransferInit is always sent by the uploader: a peer sending us a file
       * announces its token on it, while a peer ready to receive one of ours waits for us to
       * announce ours — and would wait forever if we read its init as a download.
       * What tells them apart is the token of the PeerInit, when a peer puts one there.
       */
      const upload = this.ctx.session.uploads.byTransferToken(evt.token)
      if (upload) {
        debug(`${inLabel(evt.user, evt.socket)} opened the file connection for ${upload.file}`)
        this.ctx.serving.sendOn(evt.socket, upload, evt.initialData)
        return
      }

      debug(`${inLabel(evt.user, evt.socket)} incoming file transfer`)
      new FilePeer(evt.socket, { user: evt.user, type: 'F' }, {
        session: this.ctx.session,
        readToken: true,
        initialData: evt.initialData,
        transferTimeout: this.ctx.transferTimeout
      })
    })

    // answer of a peer the server asked to connect to us
    listen.on('pierce-firewall', evt => {
      const pending = this.pendingIndirect[evt.token]
      if (!pending) {
        debug(`${inLabel('?', evt.socket)} unexpected PierceFireWall token ${evt.token}, closing`)
        evt.socket.destroy()
        return
      }
      delete this.pendingIndirect[evt.token]
      pending(evt.socket, evt.initialData)
    })

    this.ctx.server.setWaitPort(this.ctx.incomingPort)
  }

  /**
   * true when an incoming connection introduces itself with the name we logged in as. A PeerInit
   * carries the name of whoever opened the connection, and that name is ours on the network, so
   * the only things that send it are this client reaching its own address and a peer lying about
   * who it is.
   */
  private isOurOwnName (user: string): boolean {
    return this.ctx.session.username !== '' && user === this.ctx.session.username
  }

  /**
   * Closes such a connection. Keeping it would put us in our own peer map, where a search answer
   * or a download would then be sent to ourselves instead of to the peer that asked.
   */
  private dropSelfConnection (socket: net.Socket, user: string): void {
    debug(`${inLabel(user, socket)} introduced itself with the name we logged in as: closing it`)
    socket.destroy()
  }

  /**
   * The address the server has for a peer. It is recorded on every connection to that user,
   * whatever their type, since a file connection is opened to the port it listens on and a peer
   * connection only ever carries its ephemeral one.
   *
   * It is dialled only for a `connectDirect` waiting on it: an address is also answered for every
   * peer that connects to us, and dialling those back opens connections nobody asked for — to
   * peers that often cannot accept one anyway.
   */
  onAddress (peer: PeerInfo): void {
    const known = this.connectionsTo(peer.user)
    known.forEach(connection => connection.setAddress(peer.host as string, peer.port as number))

    if (!this.awaitingAddress.has(peer.user)) {
      if (known.length === 0) {
        debug(`${outLabel(peer.user, peer.port)} is at ${peer.host}, nothing is waiting for its address`)
      }
      return
    }
    if (this.peers[peer.user]) return

    this.peers[peer.user] = this.createDefaultPeer(
      this.dialPeer(peer.user, peer.host as string, peer.port as number),
      peer
    )
  }

  /** A peer asked the server to have us connect to it, because it cannot accept a connection */
  onConnectRequest (peer: PeerInfo): void {
    debug(`${outLabel(peer.user, peer.port)} asked the server to have us connect,` +
      ` type ${peer.type} token ${peer.token} at ${peer.host}`)

    switch (peer.type) {
      case 'F': {
        FilePeer.open({
          host: peer.host as string,
          port: peer.port as number,
          token: peer.token as string,
          user: peer.user,
          session: this.ctx.session,
          handshake: 'pierce',
          // the uploader announces the transfer with its own token
          readToken: true,
          transferTimeout: this.ctx.transferTimeout
        })
        break
      }
      case 'D': {
        // a parent of a user we also talk to as a peer: both connections are kept
        const parent = this.parents[peer.user]
        if (parent) {
          debug(`${parent.label} replaced by a new distributed connection`)
          parent.destroy()
        }
        this.parents[peer.user] = this.createDistributedPeer(peer)
        break
      }
      default: {
        /*
         * A peer asks the server to relay its request while it also tries to reach us directly,
         * and the direct attempt often wins: dialling it back would replace a connection that
         * works with one that may never come up. Its address is still worth keeping, a file
         * connection is opened to it.
         */
        const existing = this.peerConnection(peer.user)
        if (existing?.alive) {
          debug(`${existing.label} is already connected, keeping it`)
          if (peer.host && peer.port) existing.setAddress(peer.host, peer.port)
          return
        }

        this.peers[peer.user] = this.createDefaultPeer(
          this.dialPeer(peer.user, peer.host as string, peer.port as number),
          peer
        )
      }
    }
  }

  /**
   * A peer connection (type P) and everything the client does with what travels on it: the
   * searches it answers, the transfers it asks for, and the files it is asked for.
   */
  private createDefaultPeer (socket: net.Socket, peer: PeerInfo, initialData?: Buffer): DefaultPeer {
    const { session, searching, serving, requesting } = this.ctx

    const defaultPeer = new DefaultPeer(socket, peer, {
      session,
      shared: this.ctx.sharing.shared,
      initialData,
      // read every time a peer asks: the slots and the queue change while we run
      userInfo: () => ({ ...serving.capacity(), ...this.ctx.options.userInfo }),
      uploads: this.ctx.servesUploads
    })

    defaultPeer.on('socket-error', err => this.ctx.emit('peer-error', err, peer.user))
    defaultPeer.on('disconnect', () => {
      if (this.peers[peer.user] === defaultPeer) delete this.peers[peer.user]
    })

    defaultPeer.on('search-result', result => searching.onResult(result))

    defaultPeer.on('transfer-request', evt => {
      if (evt.direction === 1) requesting.announcedByPeer(defaultPeer, evt)
      else serving.requestedByPeer(defaultPeer, evt)
    })
    defaultPeer.on('transfer-response', evt => {
      const upload = session.uploads.byTransferToken(evt.token)
      if (upload) serving.answered(defaultPeer, upload, evt)
      else requesting.answered(defaultPeer, evt)
    })

    // only a peer that speaks the queue flow answers any of these three
    defaultPeer.on('place-in-queue', evt => {
      defaultPeer.supportsQueue = true
      requesting.queued(peer.user, evt.file, evt.place)
    })
    defaultPeer.on('upload-failed', file => {
      defaultPeer.supportsQueue = true
      requesting.fail(peer.user, file, new Error('Peer error'))
    })
    defaultPeer.on('upload-denied', evt => {
      defaultPeer.supportsQueue = true
      requesting.fail(peer.user, evt.file, new Error(evt.reason || 'Upload denied'))
    })

    // a peer asking for one of our files, only reported when this client serves them
    defaultPeer.on('queue-upload', file => {
      serving.queue(defaultPeer, file)
        .catch((err: Error) => debug(`${defaultPeer.label} cannot queue ${file}: ${err.message}`))
    })
    defaultPeer.on('place-in-queue-request', file => {
      serving.placeRequested(defaultPeer, file)
    })

    return defaultPeer
  }

  /** A connection to a distributed parent: the searches of the network reach us on it */
  private createDistributedPeer (peer: PeerInfo): DistributedPeer {
    const distributedPeer = new DistributedPeer(
      this.dialPeer(peer.user, peer.host as string, peer.port as number),
      peer,
      { session: this.ctx.session }
    )

    distributedPeer.on('socket-error', err => this.ctx.emit('peer-error', err, peer.user))
    distributedPeer.on('search', search => {
      this.ctx.searching.answerRequest(search.user, search.ticket, search.query)
        .catch(err => debug(`${distributedPeer.label} cannot answer the search of ${search.user}: ${String(err)}`))
    })
    distributedPeer.on('branch-level', level => {
      // we have a parent, tell the server where we sit in the distributed network
      this.ctx.server.haveNoParents(false)
      this.ctx.server.branchLevel(level + 1)
    })
    distributedPeer.on('branch-root', root => {
      this.ctx.server.branchRoot(root)
    })
    distributedPeer.on('disconnect', () => {
      if (this.parents[peer.user] === distributedPeer) delete this.parents[peer.user]
      this.ctx.server.haveNoParents(true)
    })

    return distributedPeer
  }

  /**
   * Connects to a peer, directly using the address given by the server and, at the same time,
   * indirectly by asking the server to make the peer connect to us. Resolves with the peer
   * connection that answered first, rejects when none did before `timeout` ms.
   */
  async connectToUser (user: string, timeout = PEER_TIMEOUT): Promise<DefaultPeer> {
    const existing = this.peers[user]
    if (existing) {
      try {
        // a connection we opened may still be being dialled, nothing reaches the peer until it is up
        await existing.ready
        return existing
      } catch {
        // that dial never came up, and its disconnect dropped it from the map: connect again
        debug(`${existing.label} never came up, connecting again`)
      }
    }

    const token = crypto.randomBytes(4).toString('hex')

    try {
      return await Promise.any([
        this.connectDirect(user, timeout),
        this.connectIndirect(user, token, timeout)
      ])
    } catch {
      this.ctx.server.cantConnectToPeer(token, user)
      throw new Error('User not exist')
    } finally {
      delete this.pendingIndirect[token]
    }
  }

  /** Asks the server for the address of the peer and connects to it */
  private async connectDirect (user: string, timeout: number): Promise<DefaultPeer> {
    const answer = waitFor(this.ctx.server, 'get-peer-address', {
      timeout,
      timeoutError: new Error(`GetPeerAddress timed out for ${user}`),
      match: peer => peer.user === user
    })
    // what tells `onAddress` this address was asked for, and is worth dialling
    this.awaitingAddress.add(user)

    let address
    try {
      this.ctx.server.getPeerAddress(user)
      ;[address] = await answer
    } finally {
      this.awaitingAddress.delete(user)
    }

    // the slsk server answers port 0 for a user that is not connected
    if (!address.port) throw new Error(`${user} is not connected`)

    // onAddress created the peer with the address we just received
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
  ): Promise<DefaultPeer> {
    const pierced = new Promise<DefaultPeer>(resolve => {
      // the peer pierces our firewall on the listening port
      this.expectPierce(token, (socket, initialData) => {
        debug(`${inLabel(user, socket)} pierced our firewall with token ${token}`)
        const peer = this.createDefaultPeer(socket, { user, type: 'P' }, initialData)
        this.peers[user] = peer
        resolve(peer)
      })
    })

    const relayed = waitFor(this.ctx.server, 'connect-to-peer', {
      timeout,
      timeoutError: new Error(`ConnectToPeer timed out for ${user}`),
      // a relayed F or D request is another connection entirely, not the one being waited for
      match: peer => peer.user === user && peer.type !== 'F' && peer.type !== 'D'
    }).then(() => {
      // onConnectRequest connected to the peer
      const peer = this.peers[user]
      if (!peer) throw new Error(`No connection to ${user}`)
      return peer
    })

    this.ctx.server.connectToPeer(token, user, 'P')

    return await Promise.race([pierced, relayed])
  }

  /** Closes every connection, the listening server included */
  destroy (): void {
    this.listen?.destroy()
    Object.values(this.peers).forEach(peer => peer.destroy())
    Object.values(this.parents).forEach(parent => parent.destroy())
  }
}

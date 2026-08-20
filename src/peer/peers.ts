import crypto from 'crypto'
import net from 'net'
import createDebug from 'debug'
import DefaultPeer from './default-peer/default-peer'
import DistributedPeer from './distributed-peer/distributed-peer'
import FilePeer from './file-peer/file-peer'
import Listen from '../listen'
import waitFor from '../utils/wait-for'
import { PEER_TIMEOUT } from '../defaults'
import type { ClientContext } from '../context'
import type { PeerInfo } from '../types'

const debug = createDebug('slsk:peers')

/** Called with the connection a peer opens after a ConnectToPeer request we sent */
type Pierced = (socket: net.Socket, initialData?: Buffer) => void

/**
 * Every connection this client holds to another peer, and how they come to be: the ones we dial,
 * the ones peers open to our listening port, and the ones the server has a peer open for us.
 * One connection per peer is kept, whichever side opened it.
 */
export default class Peers {
  private readonly byUser: Record<string, DefaultPeer | DistributedPeer> = {}
  /** Callbacks waiting for the ConnectToPeer requests we sent, by token */
  private readonly pendingIndirect: Record<string, Pierced> = {}
  private listen?: Listen

  constructor (private readonly ctx: ClientContext) {}

  /** true once the client accepts incoming peer connections */
  get listening (): boolean {
    return this.listen !== undefined
  }

  get (user: string): DefaultPeer | DistributedPeer | undefined {
    return this.byUser[user]
  }

  /**
   * Peer connection (type P) to a user, when there is one: the connection to a distributed
   * parent carries searches, not the messages a peer connection understands.
   */
  peerConnection (user: string): DefaultPeer | undefined {
    const peer = this.byUser[user]
    return peer instanceof DefaultPeer ? peer : undefined
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
      const existing = this.byUser[peer.user]

      if (this.isOurOwnName(peer.user)) {
        this.dropSelfConnection(evt.socket, peer.user)
      } else if (existing?.connected) {
        debug(`already connected to ${peer.user}, dropping the connection it just opened` +
          `${evt.initialData ? ` and the ${evt.initialData.length} bytes it sent on it` : ''}`)
        evt.socket.destroy()
      } else {
        // a peer reaching us while we are still dialling it, or after that dial died: its
        // connection is the one that works, ours would only hold messages in a buffer
        if (existing) {
          debug(`${peer.user} reached us, dropping ${existing.label}`)
          existing.destroy()
        }
        this.ctx.server.getPeerAddress(peer.user)
        debug(`new Peer connected ${peer.user} token ${peer.token}`)
        this.byUser[peer.user] = this.createDefaultPeer(evt.socket, peer, evt.initialData)
      }
    })

    // a peer starts sending a file it queued for us
    listen.on('file-transfer', evt => {
      if (this.isOurOwnName(evt.user)) {
        this.dropSelfConnection(evt.socket, evt.user)
        return
      }
      debug(`incoming file transfer from ${evt.user}`)
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
        debug(`unexpected PierceFirewall token ${evt.token}, closing`)
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
    debug(`a connection introduced itself as ${user}, which is the name we logged in as: closing it`)
    socket.destroy()
  }

  /** The address the server has for a peer: kept for the connection to it, or dialled */
  onAddress (peer: PeerInfo): void {
    const existing = this.byUser[peer.user]
    if (existing) {
      existing.setAddress(peer.host as string, peer.port as number)
      return
    }
    this.byUser[peer.user] = this.createDefaultPeer(
      this.dialPeer(peer.host as string, peer.port as number),
      peer
    )
  }

  /**
   * Dials a peer, giving up after `PEER_TIMEOUT`: the system takes minutes to declare an address
   * that drops our packets unreachable, and a download waiting on it looks like a silent peer.
   */
  private dialPeer (host: string, port: number): net.Socket {
    const socket = net.createConnection({ host, port })

    socket.setTimeout(PEER_TIMEOUT, () => {
      socket.destroy(new Error(`Connection to ${host}:${port} timed out`))
    })
    // an established connection may stay quiet for as long as the peer has nothing to say
    socket.once('connect', () => socket.setTimeout(0))

    return socket
  }

  /** A peer asked the server to have us connect to it, because it cannot accept a connection */
  onConnectRequest (peer: PeerInfo): void {
    debug(`connectToPeer ${peer.user} ${peer.host} ${peer.port} ${peer.token} ${peer.type}`)

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
        this.byUser[peer.user] = this.createDistributedPeer(peer)
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
          debug(`already connected to ${peer.user}, keeping ${existing.label}`)
          if (peer.host && peer.port) existing.setAddress(peer.host, peer.port)
          return
        }

        this.byUser[peer.user] = this.createDefaultPeer(
          this.dialPeer(peer.host as string, peer.port as number),
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
      if (this.byUser[peer.user] === defaultPeer) delete this.byUser[peer.user]
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
        .catch((err: Error) => debug(`cannot queue ${file} for ${peer.user}: ${err.message}`))
    })
    defaultPeer.on('place-in-queue-request', file => {
      serving.placeRequested(defaultPeer, file)
    })

    return defaultPeer
  }

  /** A connection to a distributed parent: the searches of the network reach us on it */
  private createDistributedPeer (peer: PeerInfo): DistributedPeer {
    const distributedPeer = new DistributedPeer(
      this.dialPeer(peer.host as string, peer.port as number),
      peer,
      { session: this.ctx.session }
    )

    distributedPeer.on('socket-error', err => this.ctx.emit('peer-error', err, peer.user))
    distributedPeer.on('search', search => {
      this.ctx.searching.answerRequest(search.user, search.ticket, search.query)
        .catch(err => debug(`cannot answer the search of ${search.user}: ${String(err)}`))
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
      if (this.byUser[peer.user] === distributedPeer) delete this.byUser[peer.user]
      this.ctx.server.haveNoParents(true)
    })

    return distributedPeer
  }

  /**
   * Connects to a peer, directly using the address given by the server and, at the same time,
   * indirectly by asking the server to make the peer connect to us. Resolves with the peer
   * connection that answered first, rejects when none did before `timeout` ms.
   */
  async connectToUser (
    user: string,
    timeout = PEER_TIMEOUT
  ): Promise<DefaultPeer | DistributedPeer> {
    const existing = this.byUser[user]
    if (existing) {
      try {
        // a connection we opened may still be being dialled, nothing reaches the peer until it is up
        await existing.ready
        return existing
      } catch {
        // that dial never came up, and its disconnect dropped it from the map: connect again
        debug(`the connection to ${user} never came up, connecting again`)
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
  private async connectDirect (
    user: string,
    timeout: number
  ): Promise<DefaultPeer | DistributedPeer> {
    const answer = waitFor(this.ctx.server, 'get-peer-address', {
      timeout,
      timeoutError: new Error(`GetPeerAddress timed out for ${user}`),
      match: peer => peer.user === user
    })
    this.ctx.server.getPeerAddress(user)

    const [address] = await answer
    // the slsk server answers port 0 for a user that is not connected
    if (!address.port) throw new Error(`${user} is not connected`)

    // onAddress created the peer with the address we just received
    const peer = this.byUser[user]
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
      this.expectPierce(token, (socket, initialData) => {
        debug(`${user} pierced our firewall with token ${token}`)
        const peer = this.createDefaultPeer(socket, { user, type: 'P' }, initialData)
        this.byUser[user] = peer
        resolve(peer)
      })
    })

    const relayed = waitFor(this.ctx.server, 'connect-to-peer', {
      timeout,
      timeoutError: new Error(`ConnectToPeer timed out for ${user}`),
      match: peer => peer.user === user && peer.type !== 'F'
    }).then(() => {
      // onConnectRequest connected to the peer
      const peer = this.byUser[user]
      if (!peer) throw new Error(`No connection to ${user}`)
      return peer
    })

    this.ctx.server.connectToPeer(token, user, 'P')

    return await Promise.race([pierced, relayed])
  }

  /** Closes every connection, the listening server included */
  destroy (): void {
    this.listen?.destroy()
    Object.keys(this.byUser).forEach(user => {
      this.byUser[user].destroy()
    })
  }
}

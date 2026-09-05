import createDebug from 'debug'
import Server, { LoginRefusedError } from './server'
import waitFor from '../utils/wait-for'
import {
  DEFAULT_LOGIN_TIMEOUT,
  DEFAULT_MAX_RECONNECT_DELAY,
  DEFAULT_RECONNECT_DELAY
} from '../defaults'
import type { ClientContext } from '../context'
import type { ReconnectOptions } from '../types'

const debug = createDebug('slsk:server:link')

/**
 * The session with the slsk server: the connection, the login it carries, and the loop that
 * opens both again when the server drops us. A lost connection loses the session with it, so
 * everything here is done again on every reconnection.
 */
export default class ServerLink {
  private conn!: Server
  /** Connection opened once by `login()`, whatever the number of callers */
  private opened?: Promise<void>
  /** Login in flight or done, so a caller retrying does not send a second Login */
  private attempt?: Promise<void>
  /** Kept in memory to log in again after a lost connection, set once the login went through */
  private credentials?: { user: string, pass: string }
  private destroyed = false
  /** true while the reconnection loop runs, so a failed attempt does not start a second one */
  private reconnecting = false
  /** Cuts the wait between two reconnection attempts short when the client is destroyed */
  private cancelPause?: () => void

  constructor (private readonly ctx: ClientContext) {}

  /** The current connection, undefined until the first one is opened */
  get server (): Server {
    return this.conn
  }

  /** How a lost connection is picked up again, false when the caller does it itself */
  private get reconnectOptions (): Required<ReconnectOptions> | false {
    const option = this.ctx.options.reconnect ?? true
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

  /**
   * Logs in, connecting to the server and starting to listen for incoming peer connections
   * first. Calling it again while a session is up does nothing: a second Login on the same
   * connection makes the server answer Relogged and drop the session.
   */
  async login (user: string, pass: string): Promise<void> {
    // a caller retrying a login is common, sending Login twice is what gets us relogged
    if (this.attempt) return await this.attempt

    this.attempt = this.attemptLogin(user, pass)
    try {
      await this.attempt
    } catch (err) {
      // a failed attempt must not stop the caller from trying again
      this.attempt = undefined
      throw err
    }
  }

  /** Everything a login needs around the credentials themselves */
  private async attemptLogin (user: string, pass: string): Promise<void> {
    await this.init()

    // logging in again after the connection was lost: that socket will not come back
    if (!this.conn.connected && !this.reconnecting) await this.connect()

    if (this.conn.isLoggedIn) {
      debug(`already logged in as ${this.ctx.session.username}, not sending Login again`)
      return
    }

    await this.sendLogin(user, pass)

    // only a working session is worth reconnecting, credentials the server refused are not
    this.credentials = { user, pass }

    // the shares are listed once the session exists, and on their own time
    void this.ctx.sharing.list()
  }

  /**
   * Connects to the slsk server and starts listening for incoming peer connections.
   * Done once however many times `login()` is called.
   */
  private init (): Promise<void> {
    if (!this.opened) {
      this.opened = (async () => {
        debug('Init client')
        await this.connect()
        this.ctx.peers.startListening()
      })()
    }
    return this.opened
  }

  /**
   * Opens the connection and wires what the server reports. Called again by the reconnection
   * loop, which is why nothing but the connection itself is set up here.
   */
  private async connect (): Promise<void> {
    const server = new Server(this.ctx.serverAddress)
    this.conn = server

    server.on('socket-error', err => {
      this.ctx.emit('server-error', err)
    })

    server.on('close', () => {
      this.onClose(server)
    })

    server.on('connect-to-peer', peer => {
      this.ctx.peers.onConnectRequest(peer)
    })

    server.on('private-message', msg => {
      debug(`${msg.user}: ${msg.message}`)
      this.ctx.emit('private-message', msg)
    })

    // the session is gone, not the connection: a new login is needed, and whatever logs in with
    // the same name has to stop first or the two keep kicking each other off
    server.on('relogged', () => {
      this.attempt = undefined
      this.ctx.emit('relogged')
    })

    server.on('get-peer-address', peer => {
      this.ctx.peers.onAddress(peer)
    })

    // the server could not reach a peer it was asked to connect to us
    server.on('cant-connect-to-peer', evt => {
      this.ctx.requesting.cannotConnect(evt.token)
    })

    // a new connection knows nothing about us, both are queued until the login goes through
    if (this.ctx.peers.listening) server.setWaitPort(this.ctx.incomingPort)
    // nothing yet on the first connection, the first listing announces the real counts
    this.ctx.sharing.announce()

    await server.ready
  }

  /** Sends the credentials and waits for the answer of the server */
  private async sendLogin (user: string, pass: string): Promise<void> {
    // peers we talk to before the answer comes back must know how to introduce us
    this.ctx.session.username = user

    // the listener must be registered before the request is sent
    const answer = waitFor(this.conn, 'login', {
      timeout: this.ctx.options.timeout ?? DEFAULT_LOGIN_TIMEOUT,
      timeoutError: new Error('timeout login')
    })
    this.conn.login({ user, pass })

    const [result] = await answer
    if (!result.success) throw new LoginRefusedError(result.reason)
  }

  /** The connection dropped: report it and log in again, unless the caller said not to */
  private onClose (server: Server): void {
    // a connection we already replaced, or one the reconnection loop just gave up on
    if (this.conn !== server || this.reconnecting || this.destroyed) return

    // the session went with the connection, so a caller asking to log in again is not a caller
    // retrying a login that already went through
    this.attempt = undefined

    const reconnecting = this.credentials !== undefined && this.reconnectOptions !== false
    debug(`server connection lost${reconnecting ? ', logging in again' : ''}`)
    this.ctx.emit('server-disconnect', { reconnecting })

    if (reconnecting) void this.reconnect()
  }

  /** Connects and logs in again after the server dropped us, waiting longer after every failure */
  private async reconnect (): Promise<void> {
    const config = this.reconnectOptions
    const credentials = this.credentials
    if (!config || !credentials) return

    this.reconnecting = true
    try {
      for (let attempt = 1; attempt <= config.retries; attempt++) {
        await this.pause(Math.min(config.delay * 2 ** (attempt - 1), config.maxDelay))
        if (this.destroyed) return

        try {
          await this.connect()
          await this.sendLogin(credentials.user, credentials.pass)
          debug(`logged in again after ${attempt} attempt(s)`)
          this.ctx.emit('server-reconnect')
          return
        } catch (err) {
          debug(`reconnection attempt ${attempt} failed: ${String(err)}`)
          this.conn.destroy()

          if (err instanceof LoginRefusedError) {
            // retrying refused credentials would only hammer the server
            this.credentials = undefined
            this.ctx.emit('server-error', err)
            this.ctx.emit('server-disconnect', { reconnecting: false })
            return
          }
        }
      }

      this.ctx.emit('server-error', new Error(
        `Cannot reconnect to the slsk server, gave up after ${config.retries} attempts`
      ))
      this.ctx.emit('server-disconnect', { reconnecting: false })
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

  destroy (): void {
    this.destroyed = true
    this.cancelPause?.()
    this.credentials = undefined
    if (this.conn) this.conn.destroy()
  }
}

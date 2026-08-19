import EventEmitter from 'events'
import net from 'net'
import createDebug from 'debug'
import Messages from '../src/utils/messages'
import Message from '../src/utils/message'
import type { ServerAddress } from '../src/types'

const debug = createDebug('slsk:mock:server')

export interface LoginEvent {
  client: net.Socket
  username: string
  password: string
  version: number
  /**
   * Codes of the messages received before Login on this connection.
   * The real server ignores everything sent before a successful Login,
   * so a compliant client must keep this empty.
   */
  precedingCodes: number[]
}

export interface GetPeerAddressEvent {
  client: net.Socket
  user: string
}

export interface HaveNoParentEvent {
  client: net.Socket
}

/** The client asks the server to make a peer connect to it, because it cannot reach it */
export interface ConnectToPeerEvent {
  client: net.Socket
  token: string
  user: string
  type: string
}

export interface MockServerEvents {
  login: [login: LoginEvent]
  'get-peer-address': [evt: GetPeerAddressEvent]
  'have-no-parent': [evt: HaveNoParentEvent]
  'connect-to-peer': [evt: ConnectToPeerEvent]
}

export default class MockServer extends EventEmitter<MockServerEvents> {
  private server: net.Server
  /** Every connection accepted, closed when the mock is destroyed */
  private readonly clients: net.Socket[] = []

  constructor (address: ServerAddress) {
    super()

    this.server = net.createServer(client => {
      debug('Client connected')
      this.clients.push(client)
      // a client that goes away resets this connection, which must not crash the test run
      client.on('error', (err: NodeJS.ErrnoException) => debug(`client socket error ${err.code}`))
      const msgs = new Messages()
      const receivedCodes: number[] = []

      client.on('data', data => {
        msgs.write(data)
      })

      msgs.on('message', (msg: Message) => {
        const size = msg.int32()
        if (size < 4) return
        const code = msg.int32()
        receivedCodes.push(code)
        switch (code) {
          case 1: {
            const username = msg.str()
            const password = msg.str()
            const version = msg.int32()
            debug(`Login attempt username ${username} version ${version}`)
            this.emit('login', {
              client,
              username,
              password,
              version,
              precedingCodes: receivedCodes.slice(0, -1)
            } satisfies LoginEvent)
            break
          }
          case 2: {
            const port = msg.int32()
            debug(`recv SetWaitPort ${port}`)
            break
          }
          case 3: {
            const user = msg.str()
            debug(`recv getPeerAddress for user ${user}`)
            this.emit('get-peer-address', { client, user } satisfies GetPeerAddressEvent)
            break
          }
          case 18: {
            const token = msg.rawHexStr(4)
            const user = msg.str()
            const type = msg.str()
            debug(`recv ConnectToPeer ${user} type ${type} token ${token}`)
            this.emit('connect-to-peer', { client, token, user, type })
            break
          }
          case 71: {
            const flag = msg.int8()
            debug(`recv HaveNoParent message: ${flag}`)
            if (flag) {
              this.emit('have-no-parent', { client })
            }
            break
          }
          default: {
            debug(`unknown srv message code: ${code}`)
          }
        }
      })
    })

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      debug(`Error ${err.code}`)
    })

    this.server.listen(address.port, address.host, () => {
      debug(`MockServer bound on ${address.host}:${address.port}`)
    })
  }

  loginSuccess (client: net.Socket): void {
    client.write(
      loginResponse(1, 'Login Success').getBuff()
    )
  }

  loginFail (client: net.Socket): void {
    client.write(
      loginResponse(0, 'INVALIDPASS').getBuff()
    )
  }

  netInfo (client: net.Socket, user: string, host: string, port: number): void {
    client.write(
      netInfo(user, host, port).getBuff()
    )
  }

  /**
   * ConnectToPeer (18): tells the client a peer wants a connection and cannot accept one, so the
   * client is the one that has to reach it, at the address given here and with `token`.
   */
  askToConnect (
    client: net.Socket,
    user: string,
    type: string,
    host: string,
    port: number,
    token: string
  ): void {
    const ip = host.split('.')
    client.write(
      new Message()
        .int32(18)
        .str(user)
        .str(type)
        .int8(parseInt(ip[3]))
        .int8(parseInt(ip[2]))
        .int8(parseInt(ip[1]))
        .int8(parseInt(ip[0]))
        .int32(port)
        .rawHexStr(token)
        .getBuff()
    )
  }

  returnPeerAddress (client: net.Socket, user: string, host: string, port: number): void {
    const ip = host.split('.')
    client.write(
      new Message()
        .int32(3)
        .str(user)
        .int8(parseInt(ip[3]))
        .int8(parseInt(ip[2]))
        .int8(parseInt(ip[1]))
        .int8(parseInt(ip[0]))
        .int32(port)
        .getBuff()
    )
  }

  /**
   * ConnectToPeer (18): relays the request of a peer that asked the server to make the client
   * connect to it, because it could not reach the client itself.
   */
  relayConnectToPeer (
    client: net.Socket,
    user: string,
    host: string,
    port: number,
    token: string,
    type = 'P'
  ): void {
    const ip = host.split('.')
    client.write(
      new Message()
        .int32(18)
        .str(user)
        .str(type)
        .int8(parseInt(ip[3]))
        .int8(parseInt(ip[2]))
        .int8(parseInt(ip[1]))
        .int8(parseInt(ip[0]))
        .int32(port)
        .rawHexStr(token)
        .getBuff()
    )
  }

  /** Drops a client connection, as the real server does when it restarts or the link breaks */
  disconnect (client: net.Socket): void {
    client.destroy()
  }

  destroy (): void {
    this.clients.forEach(client => client.destroy())
    this.server.close()
  }
}

function loginResponse (status: number, message: string): Message {
  return new Message()
    .int32(1)
    .int8(status)
    .str(message)
}

function netInfo (user: string, host: string, port: number): Message {
  const ip = host.split('.')
  return new Message()
    .int32(102)
    .int32(1)
    .str(user)
    .int8(parseInt(ip[3]))
    .int8(parseInt(ip[2]))
    .int8(parseInt(ip[1]))
    .int8(parseInt(ip[0]))
    .int32(port)
}

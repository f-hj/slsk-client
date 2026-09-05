import assert from 'assert'
import net from 'net'
import { type PrivateMessage, type SlskClient } from '../src/index'
import Message from '../src/utils/message'
import Messages from '../src/utils/messages'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'

/** MessageUser (22), as the server delivers a private message */
function messageUser (
  id: number,
  timestamp: number,
  user: string,
  message: string,
  isNew = true
): Buffer {
  return new Message()
    .int32(22)
    .int32(id)
    .int32(timestamp)
    .str(user)
    .str(message)
    .int8(isNew ? 1 : 0)
    .getBuff()
}

describe('private messages', () => {
  const serverAddress = { host: '127.0.0.1', port: 2255 }
  const incomingPort = 2298
  const sender = 'poulet'

  let client: SlskClient
  let mockServer: MockServer
  let serverSide: net.Socket
  /** What the client sent to the server, by code */
  let sent: Array<{ code: number, msg: Message }>

  beforeEach(async () => {
    sent = []
    mockServer = new MockServer(serverAddress)
    mockServer.on('login', (login: LoginEvent) => {
      serverSide = login.client
      mockServer.loginSuccess(login.client)

      const msgs = new Messages()
      login.client.on('data', data => msgs.write(data))
      msgs.on('message', (msg: Message) => {
        msg.int32() // size
        sent.push({ code: msg.int32(), msg })
      })
    })

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort
    })
  })

  afterEach(() => {
    client.destroy()
    mockServer.destroy()
  })

  /** The next message of that code the client sends to the server */
  const sentMessage = async (code: number): Promise<Message> => {
    for (let waited = 0; waited < 100; waited++) {
      const found = sent.find(it => it.code === code)
      if (found) return found.msg
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`the client never sent a message of code ${code}`)
  }

  it('reports a private message someone sent us', async () => {
    const received = new Promise<PrivateMessage>(resolve => client.once('private-message', resolve))

    serverSide.write(messageUser(4242, 1600000000, sender, 'hello there'))

    assert.deepStrictEqual(await received, {
      id: 4242,
      user: sender,
      message: 'hello there',
      sentAt: new Date(1600000000 * 1000),
      pending: false
    } satisfies PrivateMessage)
  })

  it('acknowledges it, or the server would send it again forever', async () => {
    serverSide.write(messageUser(4242, 1600000000, sender, 'hello there'))

    const acked = await sentMessage(23) // MessageAcked
    assert.strictEqual(acked.int32(), 4242, 'the id of the message must be acknowledged')
  })

  it('says when a message was kept by the server while we were offline', async () => {
    const received = new Promise<PrivateMessage>(resolve => client.once('private-message', resolve))

    serverSide.write(messageUser(7, 1600000000, sender, 'you were away', false))

    const msg = await received
    assert.strictEqual(msg.pending, true)
    assert.deepStrictEqual(msg.sentAt, new Date(1600000000 * 1000))
  })

  it('sends a private message to a user', async () => {
    client.sendPrivateMessage(sender, 'hello yourself')

    const msg = await sentMessage(22)
    assert.strictEqual(msg.str(), sender)
    assert.strictEqual(msg.str(), 'hello yourself')
  })

  it('flattens the newlines the server refuses', async () => {
    client.sendPrivateMessage(sender, 'first line\r\nsecond line')

    const msg = await sentMessage(22)
    msg.str() // user
    assert.strictEqual(msg.str(), 'first line second line')
  })

  it('survives a message that does not match its layout', async () => {
    // truncated by a server that does not follow the documented layout: reading it throws, which
    // must not take the connection, and the process with it, down
    serverSide.write(new Message().int32(22).int32(1).getBuff())

    const delivered = new Promise<PrivateMessage>(resolve => client.once('private-message', resolve))
    serverSide.write(messageUser(4242, 1600000000, sender, 'hello there'))

    assert.strictEqual((await delivered).message, 'hello there', 'the next message still arrives')
    client.sendPrivateMessage(sender, 'still here')
    assert.ok(await sentMessage(22), 'and the connection is still usable')
  })
})

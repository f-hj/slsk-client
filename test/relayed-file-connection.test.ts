import assert from 'assert'
import fs from 'fs'
import net from 'net'
import { SlskClient } from '../src/index'
import connectClient from './connect-client'
import MockServer, { type LoginEvent } from './mock-server'
import MockUploadPeer from './mock-upload-peer'

describe('a file connection request the server relays for a running transfer', () => {
  const baseFolder = '/tmp/slsk-client/relayed-file-connection'
  const serverAddress = { host: '127.0.0.1', port: 2257 }
  const incomingPort = 2307
  const remoteFile = 'music\\both routes at once.mp3'
  const data = Buffer.from('a file a peer sends on the connection it opened')

  /** A peer that connects to us and asks the server to relay a request at the same time */
  const doubler = 'doubler'
  const doublerAddress = { host: '127.0.0.1', port: 4261 }
  /** A peer that only asks the server to relay, like one that cannot be reached at all */
  const relayer = 'relayer'
  const relayerAddress = { host: '127.0.0.1', port: 4262 }

  let client: SlskClient
  let mockServer: MockServer
  let doublerPeer: MockUploadPeer
  let relayerPeer: MockUploadPeer
  let serverSide: net.Socket

  before(async () => {
    await fs.promises.mkdir(baseFolder, { recursive: true })

    const ports: Record<string, number> = {
      [doubler]: doublerAddress.port,
      [relayer]: relayerAddress.port
    }

    mockServer = new MockServer(serverAddress)
    mockServer
      .on('login', (login: LoginEvent) => {
        serverSide = login.client
        mockServer.loginSuccess(login.client)
      })
      .on('get-peer-address', evt =>
        mockServer.returnPeerAddress(evt.client, evt.user, '127.0.0.1', ports[evt.user] ?? 0))

    // holds the data, so its relayed request arrives while the transfer is running
    doublerPeer = new MockUploadPeer({
      address: doublerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: doubler,
      holdData: 1500
    })

    // never connects itself, the transfer has to come on the connection we pierce with
    relayerPeer = new MockUploadPeer({
      address: relayerAddress,
      clientListenPort: incomingPort,
      file: remoteFile,
      data,
      username: relayer,
      relay: true
    })
    relayerPeer.on('relay-requested', token =>
      mockServer.askToConnect(serverSide, relayer, 'F', '127.0.0.1', relayerAddress.port, token))

    client = await connectClient({
      user: 'me',
      pass: 'secret',
      host: serverAddress.host,
      port: serverAddress.port,
      incomingPort
    })
  })

  after(() => {
    if (client) client.destroy()
    doublerPeer.destroy()
    relayerPeer.destroy()
    mockServer.destroy()
  })

  it('is not answered when the file is already arriving on the connection the peer opened', async () => {
    const started = new Promise<number>(resolve => doublerPeer.once('offset', resolve))
    const download = client.download({
      user: doubler,
      file: remoteFile,
      size: data.length,
      path: baseFolder + '/direct.mp3'
    })

    // the transfer is running
    await started

    // the request it asked the server to relay arrives last, as it does on the network
    mockServer.askToConnect(serverSide, doubler, 'F', '127.0.0.1', doublerAddress.port, '69500000')

    const pierced = new Promise<string>(resolve => doublerPeer.once('pierce', resolve))
    const outcome = await Promise.race([
      pierced.then(() => 'pierce'),
      new Promise<string>(resolve => setTimeout(() => resolve('nothing'), 500))
    ])
    assert.strictEqual(outcome, 'nothing',
      'the client must not open a second file connection to a peer already sending')

    const down = await download
    assert.deepStrictEqual(down.buffer, data, 'the transfer it did not disturb is the one that finishes')
  }).timeout(10000)

  it('is answered with a pierce when the client has no other way to receive the file', async () => {
    const download = client.download({
      user: relayer,
      file: remoteFile,
      size: data.length,
      path: baseFolder + '/relayed.mp3'
    })

    const down = await download
    assert.deepStrictEqual(down.buffer, data, 'the file arrives on the connection the client pierced for')
  }).timeout(10000)
})
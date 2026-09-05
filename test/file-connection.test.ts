import assert from 'assert'
import net from 'net'
import UploadPeer from '../src/peer/file-peer/upload-peer'
import Upload from '../src/upload/upload'
import Session from '../src/session'
import dial from '../src/utils/dial'
import type { ShareEntry, ShareProvider } from '../src/share/provider'

/** A provider that never has to produce anything: these transfers never get to the bytes */
const provider: ShareProvider = {
  name: 'test',
  list: async () => [],
  read: async () => { throw new Error('not read in this test') }
}
const entry: ShareEntry = { path: 'music\\song.flac', size: 1000 }

function upload (user: string): Upload {
  const it = new Upload({ user, file: entry.path, entry, provider })
  it.requested('cafed00d', entry.size)
  return it
}

/** A listening server and the port it is on, closed by the caller */
async function listener (): Promise<{ server: net.Server, port: number }> {
  const server = net.createServer(socket => socket.on('error', () => {}))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as net.AddressInfo).port }
}

describe('dial', () => {
  it('leaves a connection that came up in time alone', async () => {
    const { server, port } = await listener()
    const socket = dial('127.0.0.1', port, 60)
    const failed: Error[] = []
    socket.on('error', err => failed.push(err))

    try {
      await new Promise<void>(resolve => socket.once('connect', resolve))
      // well past the dial timeout: its timer must not touch an established connection
      await new Promise<void>(resolve => setTimeout(resolve, 200))

      assert.deepStrictEqual(failed, [], 'an established connection must not be dropped')
      assert.strictEqual(socket.destroyed, false)
    } finally {
      socket.destroy()
      server.close()
    }
  })

  it('leaves the idle timeout of the transfer in place', async () => {
    const { server, port } = await listener()
    const it = upload('idler')

    // the transfer timeout is the socket timeout a file connection sets once it is up: a dial
    // that cleared it with setTimeout(0) would leave a silent connection open forever
    const peer = UploadPeer.open({
      host: '127.0.0.1',
      port,
      session: new Session(),
      upload: it,
      transferTimeout: 100,
      startTimeout: 5000
    })
    const failed = new Promise<Error>(resolve => it.once('failed', resolve))

    try {
      assert.match((await failed).message, /stopped reading/)
    } finally {
      peer.destroy()
      server.close()
    }
  }).timeout(5000)
})

describe('an announced transfer the downloader never starts', () => {
  it('fails instead of holding the upload slot', async () => {
    const { server, port } = await listener()
    const it = upload('silent')

    const peer = UploadPeer.open({
      host: '127.0.0.1',
      port,
      session: new Session(),
      upload: it,
      // the downloader has to ask where to start, and this one never will
      startTimeout: 100,
      transferTimeout: 5000
    })
    const failed = new Promise<Error>(resolve => it.once('failed', resolve))

    try {
      assert.match((await failed).message, /never asked where to start/)
      assert.strictEqual(it.status, 'failed', 'the slot is freed for the next file in the queue')
    } finally {
      peer.destroy()
      server.close()
    }
  }).timeout(5000)
})

import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { SlskClient, type SearchResult } from '../../src/index'
import connectClient from '../connect-client'

const hasCredentials = Boolean(process.env.SLSK_USER && process.env.SLSK_PASS)
const describeIntegration = hasCredentials ? describe : describe.skip

describeIntegration('search', () => {
  let client: SlskClient
  let file: SearchResult
  let file2: SearchResult

  after(() => {
    if (client) client.destroy()
  })

  it('must login', async () => {
    client = await connectClient({
      user: process.env.SLSK_USER as string,
      pass: process.env.SLSK_PASS as string
    })
  }).timeout(10000)

  it('must search correctly', async () => {
    const res = await client.search({
      req: 'moby play',
      timeout: 4000
    })
    const found = res.filter(it => path.extname(it.file) === '.mp3')
      .sort((a, b) => (a.size / a.speed) - (b.size / b.speed))
      .find(it => it.slots)

    assert.ok(found, 'Test: no file with free slot')
    file = found
    console.log(file)
  }).timeout(5000)

  it('must search correctly a second time', async () => {
    const res = await client.search({
      req: 'sbtrkt wildfire',
      timeout: 4000
    })
    const found = res.filter(it => path.extname(it.file) === '.mp3')
      .sort((a, b) => (a.size / a.speed) - (b.size / b.speed))
      .find(it => it.slots)

    assert.ok(found, 'Test: no file with free slot')
    file2 = found
    console.log(file2)
  }).timeout(5000)

  it('must download correctly', async () => {
    const down = await client.download({ file })
    console.log('test done')
    console.log(down)
    assert.ok(down.buffer.length > 0)
  }).timeout(120000)

  it('must download correctly a second time', async () => {
    const down = await client.download({ file: file2 })
    console.log(down)
    assert.ok(down.buffer.length > 0)
  }).timeout(120000)

  it('must download correctly with path', async () => {
    const down = await client.download({
      file,
      path: '/tmp/slsk-client_test.mp3'
    })
    console.log(down)
    assert.ok(down.buffer.length > 0)

    const stats = await fs.promises.stat('/tmp/slsk-client_test.mp3')
    assert.strictEqual(stats.size, file.size, 'File size is not same as specified')
  }).timeout(120000)

  it('must download correctly with stream', async () => {
    const stream = client.downloadStream({ file })

    let nbPacket = 0
    await new Promise<void>((resolve, reject) => {
      stream.on('data', () => {
        nbPacket++
      })
      stream.on('error', reject)
      stream.on('end', resolve)
    })

    assert.notStrictEqual(nbPacket, 0)
  }).timeout(120000)
})
